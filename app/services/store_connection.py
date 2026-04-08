import pymssql
from cryptography.fernet import Fernet
from flask import current_app
from models.settings import db


_pools = {}


def _get_fernet():
    key = current_app.config["FERNET_KEY"]
    if not key:
        raise RuntimeError("FERNET_KEY not configured")
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_password(password):
    return _get_fernet().encrypt(password.encode()).decode()


def decrypt_password(encrypted):
    return _get_fernet().decrypt(encrypted.encode()).decode()


def get_all_stores(active_only=True):
    sql = "SELECT * FROM stores"
    if active_only:
        sql += " WHERE is_active = TRUE"
    sql += " ORDER BY is_primary DESC, sort_order, name"
    result = db.session.execute(db.text(sql))
    rows = result.mappings().all()
    return [dict(r) for r in rows]


def get_store(store_id):
    result = db.session.execute(
        db.text("SELECT * FROM stores WHERE id = :id"),
        {"id": store_id},
    )
    row = result.mappings().first()
    return dict(row) if row else None


def get_connection(store_id):
    store = get_store(store_id)
    if not store:
        raise ValueError(f"Store {store_id} not found")

    password = decrypt_password(store["password_enc"])
    return pymssql.connect(
        server=store["host"],
        port=store["port"],
        user=store["username"],
        password=password,
        database=store["database_name"],
        login_timeout=10,
        timeout=30,
    )


def test_connection(store_id):
    try:
        conn = get_connection(store_id)
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        cursor.close()
        conn.close()
        return True, "Connection successful"
    except Exception as e:
        return False, str(e)


def execute_query(store_id, sql, params=None):
    conn = get_connection(store_id)
    try:
        cursor = conn.cursor(as_dict=True)
        cursor.execute(sql, params or ())
        if cursor.description:
            rows = cursor.fetchall()
        else:
            rows = []
        conn.commit()
        cursor.close()
        return rows
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute_insert(store_id, sql, params=None):
    conn = get_connection(store_id)
    try:
        cursor = conn.cursor(as_dict=True)
        cursor.execute(sql, params or ())
        cursor.execute("SELECT SCOPE_IDENTITY() AS ProductID")
        result = cursor.fetchone()
        conn.commit()
        cursor.close()
        product_id = result["ProductID"] if result else None
        return product_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
