from services.store_connection import execute_query, get_store


def validate_upc(upc, store_ids):
    if not upc or not upc.strip():
        return {"is_unique": True, "found_in": []}

    found_in = []
    for store_id in store_ids:
        rows = execute_query(
            store_id,
            "SELECT TOP 1 ProductID, ProductDescription FROM Items_tbl WHERE ProductUPC = %s",
            (upc.strip(),),
        )
        if rows:
            store = get_store(store_id)
            found_in.append({
                "store_id": store_id,
                "store_name": store["name"],
                "product_id": rows[0]["ProductID"],
                "description": rows[0]["ProductDescription"],
            })

    return {"is_unique": len(found_in) == 0, "found_in": found_in}


def validate_sku(sku, store_ids):
    if not sku or not sku.strip():
        return {"is_unique": True, "found_in": [], "prefix_conflicts": []}

    sku = sku.strip()
    prefix = sku[:14]
    found_in = []
    prefix_conflicts = []

    for store_id in store_ids:
        store = get_store(store_id)

        exact = execute_query(
            store_id,
            "SELECT TOP 1 ProductID, ProductSKU, ProductDescription FROM Items_tbl WHERE ProductSKU = %s",
            (sku,),
        )
        if exact:
            found_in.append({
                "store_id": store_id,
                "store_name": store["name"],
                "product_id": exact[0]["ProductID"],
                "sku": exact[0]["ProductSKU"],
                "description": exact[0]["ProductDescription"],
            })
            continue

        prefix_match = execute_query(
            store_id,
            "SELECT TOP 1 ProductID, ProductSKU, ProductDescription FROM Items_tbl WHERE LEFT(ProductSKU, 14) = LEFT(%s, 14) AND ProductSKU != %s",
            (prefix, sku),
        )
        if prefix_match:
            prefix_conflicts.append({
                "store_id": store_id,
                "store_name": store["name"],
                "product_id": prefix_match[0]["ProductID"],
                "sku": prefix_match[0]["ProductSKU"],
                "description": prefix_match[0]["ProductDescription"],
            })

    return {
        "is_unique": len(found_in) == 0 and len(prefix_conflicts) == 0,
        "found_in": found_in,
        "prefix_conflicts": prefix_conflicts,
    }


FIELD_MAX_LENGTHS = {
    "ProductUPC": 20,
    "ProductSKU": 20,
    "ProductDescription": 50,
    "ProductMessage": 96,
    "ItemSize": 10,
    "ItemWeight": 10,
    "ManuProductID": 20,
    "SPPromotionDescription": 50,
    "SPPromotionCode": 20,
    "Notes": 500,
}


PER_STORE_GATED_FIELDS = ("UnitCost", "UnitPrice")


def _per_store_prices_complete(per_store_fields, store_ids):
    if not store_ids:
        return False
    for store_id in store_ids:
        sf = per_store_fields.get(str(store_id), {})
        for field_name in PER_STORE_GATED_FIELDS:
            val = sf.get(field_name)
            if val is None or (isinstance(val, str) and not val.strip()):
                return False
    return True


def validate_fields(common_fields, field_configs, per_store_fields=None, store_ids=None):
    errors = []
    per_store_fields = per_store_fields or {}
    store_ids = store_ids or []
    prices_complete = _per_store_prices_complete(per_store_fields, store_ids)

    required_common = [
        fc["field_name"]
        for fc in field_configs
        if fc["is_required"] and not fc["is_per_store"]
    ]
    for field_name in required_common:
        if prices_complete and field_name in PER_STORE_GATED_FIELDS:
            continue
        val = common_fields.get(field_name)
        if val is None or (isinstance(val, str) and not val.strip()):
            display = next(
                (fc["display_name"] for fc in field_configs if fc["field_name"] == field_name),
                field_name,
            )
            errors.append({"field": field_name, "error": f"{display} is required"})

    for field_name, max_len in FIELD_MAX_LENGTHS.items():
        val = common_fields.get(field_name, "")
        if val and len(str(val)) > max_len:
            errors.append({"field": field_name, "error": f"Maximum {max_len} characters"})

    return errors


def validate_per_store_fields(per_store_fields, store_ids, field_configs):
    errors = []
    required_per_store = [
        fc["field_name"]
        for fc in field_configs
        if fc["is_required"] and fc["is_per_store"]
    ]

    for store_id in store_ids:
        sid = str(store_id)
        store_fields = per_store_fields.get(sid, {})
        store = get_store(store_id)
        store_name = store["name"] if store else f"Store {store_id}"

        for field_name in required_per_store:
            val = store_fields.get(field_name)
            if val is None or (isinstance(val, str) and not val.strip()):
                display = next(
                    (fc["display_name"] for fc in field_configs if fc["field_name"] == field_name),
                    field_name,
                )
                errors.append({
                    "field": field_name,
                    "store_id": store_id,
                    "error": f"{display} is required for {store_name}",
                })

    return errors
