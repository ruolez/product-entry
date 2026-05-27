"""Startup database migration runner.

Applies every SQL file in the migrations directory, in sorted filename order, on
each application startup. The runner re-applies all migrations every time rather
than trusting the ``schema_migrations`` tracking table, so it self-heals a
database whose tracking rows say a migration was applied when it actually was not.

CRITICAL CAVEAT: this only works because every migration is idempotent
(``CREATE TABLE IF NOT EXISTS`` / ``ADD COLUMN IF NOT EXISTS`` /
``ON CONFLICT DO NOTHING``). New migrations MUST stay idempotent.
"""

import logging
import os

from sqlalchemy import create_engine, text

logger = logging.getLogger("migrate")

# Arbitrary constant key so concurrent processes (e.g. Gunicorn dev workers)
# serialize on the same Postgres advisory lock while migrating.
_ADVISORY_LOCK_KEY = 8274619


def run_migrations(database_uri: str, migrations_dir: str) -> None:
    """Apply all migration files found in ``migrations_dir``.

    Uses a dedicated, disposed-after-use engine so the shared SQLAlchemy pool is
    not initialized in the Gunicorn ``--preload`` master before workers fork.
    Never raises: migration failures are logged loudly so a single bad migration
    cannot take the whole app down.
    """
    if not os.path.isdir(migrations_dir):
        logger.warning("[migrate] migrations dir %s not found, skipping", migrations_dir)
        return

    files = sorted(f for f in os.listdir(migrations_dir) if f.endswith(".sql"))
    if not files:
        logger.warning("[migrate] no .sql files in %s, skipping", migrations_dir)
        return

    engine = create_engine(database_uri)
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
            try:
                _ensure_tracking_table(conn)
                for filename in files:
                    _apply_migration(conn, migrations_dir, filename)
            finally:
                conn.exec_driver_sql("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))
    finally:
        engine.dispose()


def _ensure_tracking_table(conn) -> None:
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "id SERIAL PRIMARY KEY, "
        "filename VARCHAR(255) NOT NULL UNIQUE, "
        "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    conn.commit()


def _apply_migration(conn, migrations_dir: str, filename: str) -> None:
    with open(os.path.join(migrations_dir, filename), encoding="utf-8") as f:
        sql = f.read()
    try:
        conn.exec_driver_sql(sql)
        conn.execute(
            text("INSERT INTO schema_migrations (filename) VALUES (:f) ON CONFLICT (filename) DO NOTHING"),
            {"f": filename},
        )
        conn.commit()
        logger.info("[migrate] applied %s", filename)
    except Exception:
        conn.rollback()
        logger.exception("[migrate] FAILED %s", filename)
