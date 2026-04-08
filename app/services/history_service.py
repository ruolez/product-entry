from models.settings import db


_COMBINED_CTE = """
WITH combined AS (
    SELECT
        id,
        'mssql' AS entry_type,
        created_at,
        product_desc AS product_name,
        product_upc,
        product_sku,
        stores_targeted,
        stores_succeeded,
        stores_failed,
        error_details,
        form_data,
        NULL::jsonb AS shopify_product_ids
    FROM insertion_log

    UNION ALL

    SELECT
        id,
        'shopify' AS entry_type,
        created_at,
        product_title AS product_name,
        NULL AS product_upc,
        NULL AS product_sku,
        stores_targeted,
        stores_succeeded,
        stores_failed,
        error_details,
        form_data,
        shopify_product_ids
    FROM shopify_insertion_log
),
with_status AS (
    SELECT *,
        CASE
            WHEN stores_failed IS NULL OR array_length(stores_failed, 1) IS NULL THEN 'success'
            WHEN stores_succeeded IS NULL OR array_length(stores_succeeded, 1) IS NULL THEN 'failed'
            ELSE 'partial'
        END AS status
    FROM combined
)
"""


def _build_filters(params, search=None, entry_type=None, status=None,
                   date_from=None, date_to=None, store_name=None):
    clauses = []
    if search:
        clauses.append(
            "(product_name ILIKE :search OR product_upc ILIKE :search OR product_sku ILIKE :search)"
        )
        params["search"] = f"%{search}%"
    if entry_type:
        clauses.append("entry_type = :entry_type")
        params["entry_type"] = entry_type
    if status:
        clauses.append("status = :status")
        params["status"] = status
    if date_from:
        clauses.append("created_at >= :date_from")
        params["date_from"] = date_from
    if date_to:
        clauses.append("created_at <= :date_to")
        params["date_to"] = date_to
    if store_name:
        clauses.append(":store_name = ANY(stores_targeted)")
        params["store_name"] = store_name
    return " AND ".join(clauses)


def get_history_entries(page=1, per_page=25, search=None, entry_type=None,
                        status=None, date_from=None, date_to=None,
                        store_name=None):
    params = {}
    where = _build_filters(params, search, entry_type, status, date_from, date_to, store_name)
    where_clause = f"WHERE {where}" if where else ""

    count_sql = f"{_COMBINED_CTE} SELECT COUNT(*) FROM with_status {where_clause}"
    total = db.session.execute(db.text(count_sql), params).scalar()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page

    data_sql = (
        f"{_COMBINED_CTE} "
        f"SELECT id, entry_type, created_at, product_name, product_upc, product_sku, "
        f"stores_targeted, stores_succeeded, stores_failed, status "
        f"FROM with_status {where_clause} "
        f"ORDER BY created_at DESC LIMIT :limit OFFSET :offset"
    )
    rows = db.session.execute(db.text(data_sql), params).mappings().all()

    items = []
    for r in rows:
        items.append({
            "id": r["id"],
            "entry_type": r["entry_type"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "product_name": r["product_name"],
            "product_upc": r["product_upc"],
            "product_sku": r["product_sku"],
            "status": r["status"],
            "stores_targeted": r["stores_targeted"] or [],
            "stores_succeeded": r["stores_succeeded"] or [],
            "stores_failed": r["stores_failed"] or [],
            "store_count": len(r["stores_targeted"] or []),
        })

    total_pages = max(1, -(-total // per_page))
    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    }


def get_history_entry(entry_type, entry_id):
    if entry_type == "mssql":
        sql = (
            "SELECT id, created_at, product_upc, product_sku, product_desc AS product_name, "
            "stores_targeted, stores_succeeded, stores_failed, "
            "error_details, form_data, NULL::jsonb AS shopify_product_ids "
            "FROM insertion_log WHERE id = :id"
        )
    elif entry_type == "shopify":
        sql = (
            "SELECT id, created_at, NULL AS product_upc, NULL AS product_sku, "
            "product_title AS product_name, "
            "stores_targeted, stores_succeeded, stores_failed, "
            "error_details, form_data, shopify_product_ids "
            "FROM shopify_insertion_log WHERE id = :id"
        )
    else:
        return None

    row = db.session.execute(db.text(sql), {"id": entry_id}).mappings().first()
    if not row:
        return None

    result = dict(row)
    result["entry_type"] = entry_type
    if result["created_at"]:
        result["created_at"] = result["created_at"].isoformat()
    if result.get("stores_failed") and len(result["stores_failed"]) > 0:
        if result.get("stores_succeeded") and len(result["stores_succeeded"]) > 0:
            result["status"] = "partial"
        else:
            result["status"] = "failed"
    else:
        result["status"] = "success"
    return result


def get_history_stats(search=None, entry_type=None, date_from=None,
                      date_to=None, store_name=None):
    params = {}
    where = _build_filters(params, search, entry_type, None, date_from, date_to, store_name)
    where_clause = f"WHERE {where}" if where else ""

    sql = (
        f"{_COMBINED_CTE} "
        f"SELECT "
        f"COUNT(*) AS total, "
        f"COUNT(*) FILTER (WHERE status = 'success') AS success, "
        f"COUNT(*) FILTER (WHERE status = 'partial') AS partial, "
        f"COUNT(*) FILTER (WHERE status = 'failed') AS failed "
        f"FROM with_status {where_clause}"
    )
    row = db.session.execute(db.text(sql), params).mappings().first()
    return {
        "total": row["total"],
        "success": row["success"],
        "partial": row["partial"],
        "failed": row["failed"],
    }


def get_targeted_stores():
    sql = (
        "SELECT DISTINCT unnest(stores_targeted) AS store_name "
        "FROM ("
        "  SELECT stores_targeted FROM insertion_log "
        "  UNION ALL "
        "  SELECT stores_targeted FROM shopify_insertion_log"
        ") sub "
        "ORDER BY store_name"
    )
    rows = db.session.execute(db.text(sql)).mappings().all()
    return [r["store_name"] for r in rows]


def delete_history_entries(entries):
    mssql_ids = [e["id"] for e in entries if e["type"] == "mssql"]
    shopify_ids = [e["id"] for e in entries if e["type"] == "shopify"]

    if mssql_ids:
        db.session.execute(
            db.text("DELETE FROM insertion_log WHERE id = ANY(:ids)"),
            {"ids": mssql_ids},
        )
    if shopify_ids:
        db.session.execute(
            db.text("DELETE FROM shopify_insertion_log WHERE id = ANY(:ids)"),
            {"ids": shopify_ids},
        )
    db.session.commit()
    return len(mssql_ids) + len(shopify_ids)


def delete_failed_entries():
    r1 = db.session.execute(db.text(
        "DELETE FROM insertion_log WHERE "
        "(stores_succeeded IS NULL OR array_length(stores_succeeded, 1) IS NULL) "
        "AND stores_failed IS NOT NULL AND array_length(stores_failed, 1) > 0"
    ))
    r2 = db.session.execute(db.text(
        "DELETE FROM shopify_insertion_log WHERE "
        "(stores_succeeded IS NULL OR array_length(stores_succeeded, 1) IS NULL) "
        "AND stores_failed IS NOT NULL AND array_length(stores_failed, 1) > 0"
    ))
    db.session.commit()
    return r1.rowcount + r2.rowcount


def export_history_entries(search=None, entry_type=None, status=None,
                           date_from=None, date_to=None, store_name=None):
    params = {}
    where = _build_filters(params, search, entry_type, status, date_from, date_to, store_name)
    where_clause = f"WHERE {where}" if where else ""

    sql = (
        f"{_COMBINED_CTE} "
        f"SELECT id, entry_type, created_at, product_name, product_upc, product_sku, "
        f"stores_targeted, stores_succeeded, stores_failed, status "
        f"FROM with_status {where_clause} "
        f"ORDER BY created_at DESC"
    )
    rows = db.session.execute(db.text(sql), params).mappings().all()

    items = []
    for r in rows:
        items.append({
            "id": r["id"],
            "entry_type": r["entry_type"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else "",
            "product_name": r["product_name"] or "",
            "product_upc": r["product_upc"] or "",
            "product_sku": r["product_sku"] or "",
            "status": r["status"],
            "stores_targeted": ", ".join(r["stores_targeted"] or []),
            "stores_succeeded": ", ".join(r["stores_succeeded"] or []),
            "stores_failed": ", ".join(r["stores_failed"] or []),
        })
    return items
