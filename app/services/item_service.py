import json
from datetime import datetime, timezone

from models.settings import db
from services.store_connection import execute_insert, get_store
from services.price_engine import calculate_prices
from services.validation_service import (
    validate_fields,
    validate_per_store_fields,
    validate_sku,
    validate_upc,
)


MONEY_FIELDS = {
    "UnitPrice", "UnitPriceA", "UnitPriceB", "UnitPriceC",
    "MSRPrice", "AvrCost", "LastCost", "UnitCost",
    "UnitPrice2", "UnitPriceA2", "UnitPriceB2", "UnitPriceC2",
    "UnitPrice3", "UnitPriceA3", "UnitPriceB3", "UnitPriceC3",
    "UnitPrice4", "UnitPriceA4", "UnitPriceB4", "UnitPriceC4",
}

INT_FIELDS = {
    "CateID", "SubCateID", "ProductType", "ValuationMethod", "ItemTaxID",
    "ReorderLevel", "ReorderQuant", "PromotionID", "ManuID", "StLocationID",
    "UnitID", "UnitID2", "UnitID3", "UnitID4", "CountInUnit", "BarcodeFormat",
}

REAL_FIELDS = {
    "QuantOnHand", "QuantOnOrder", "UnitQty2", "UnitQty3", "UnitQty4",
}

BIT_FIELDS = {
    "SPPromoted", "Discontinued",
}


def _coerce_value(field_name, value):
    if value is None or value == "":
        return None
    if field_name in MONEY_FIELDS:
        return float(value)
    if field_name in INT_FIELDS:
        return int(value)
    if field_name in REAL_FIELDS:
        return float(value)
    if field_name in BIT_FIELDS:
        if isinstance(value, bool):
            return 1 if value else 0
        return int(value)
    return value


def _build_insert(merged_fields):
    merged_fields["SPPromoted"] = merged_fields.get("SPPromoted", 0)

    fields = {}
    for k, v in merged_fields.items():
        coerced = _coerce_value(k, v)
        if coerced is not None:
            fields[k] = coerced

    columns = ", ".join(f"[{col}]" for col in fields.keys())
    placeholders = ", ".join(["%s"] * len(fields))
    sql = f"INSERT INTO [Items_tbl] ({columns}) VALUES ({placeholders})"
    params = list(fields.values())

    return sql, params


def get_field_configs():
    result = db.session.execute(
        db.text("SELECT * FROM field_configs ORDER BY section, sort_order")
    )
    return [dict(r) for r in result.mappings().all()]


def _apply_defaults(merged_fields, field_configs):
    """Apply default values from field_configs for any field not already in the data."""
    for fc in field_configs:
        field_name = fc["field_name"]
        default = fc.get("default_value")
        if default is None or default == "" or default == "--":
            continue
        # Skip per-store fields (handled separately)
        if fc.get("is_per_store"):
            continue
        # Only apply if the field is missing or empty in submitted data
        current = merged_fields.get(field_name)
        if current is None or current == "" or current == "undefined":
            merged_fields[field_name] = default
    return merged_fields


def insert_item(data):
    store_ids = data["store_ids"]
    common_fields = data["common_fields"]
    per_store_fields = data.get("per_store_fields", {})

    field_configs = get_field_configs()
    errors = []

    errors.extend(validate_fields(common_fields, field_configs))
    errors.extend(validate_per_store_fields(per_store_fields, store_ids, field_configs))

    upc = common_fields.get("ProductUPC", "").strip()
    if upc:
        upc_result = validate_upc(upc, store_ids)
        if not upc_result["is_unique"]:
            stores_with_upc = ", ".join(f["store_name"] for f in upc_result["found_in"])
            errors.append({"field": "ProductUPC", "error": f"UPC already exists in: {stores_with_upc}"})

    sku = common_fields.get("ProductSKU", "").strip()
    if sku:
        sku_result = validate_sku(sku, store_ids)
        if not sku_result["is_unique"]:
            if sku_result["found_in"]:
                stores_list = ", ".join(f["store_name"] for f in sku_result["found_in"])
                errors.append({"field": "ProductSKU", "error": f"SKU already exists in: {stores_list}"})
            if sku_result["prefix_conflicts"]:
                stores_list = ", ".join(f["store_name"] for f in sku_result["prefix_conflicts"])
                errors.append({"field": "ProductSKU", "error": f"SKU prefix (first 14 chars) conflicts in: {stores_list}"})

    if errors:
        return {"success": False, "errors": errors, "results": []}

    results = []
    stores_succeeded = []
    stores_failed = []
    error_details = {}

    for store_id in store_ids:
        store = get_store(store_id)
        store_name = store["name"] if store else f"Store {store_id}"
        sid = str(store_id)

        merged = {**common_fields}
        if sid in per_store_fields:
            merged.update(per_store_fields[sid])

        # Apply defaults from field_configs for any missing fields
        merged = _apply_defaults(merged, field_configs)

        # Apply price formulas for this store.
        # calculate_prices handles skip logic internally (UnitCost always
        # overrides for per-store adjustment, others only if not user-set).
        # All returned results should be applied unconditionally.
        formula_results = calculate_prices(merged, store_id)
        merged.update(formula_results)

        try:
            sql, params = _build_insert(merged)
            product_id = execute_insert(store_id, sql, params)
            results.append({
                "store_id": store_id,
                "store_name": store_name,
                "success": True,
                "product_id": product_id,
            })
            stores_succeeded.append(store_name)
        except Exception as e:
            results.append({
                "store_id": store_id,
                "store_name": store_name,
                "success": False,
                "error": str(e),
            })
            stores_failed.append(store_name)
            error_details[store_name] = str(e)

    _log_insertion(common_fields, store_ids, stores_succeeded, stores_failed, error_details, data)

    return {
        "success": len(stores_failed) == 0,
        "results": results,
        "errors": [],
    }


def _log_insertion(common_fields, store_ids, succeeded, failed, error_details, form_data):
    try:
        store_names_targeted = []
        for sid in store_ids:
            store = get_store(sid)
            store_names_targeted.append(store["name"] if store else str(sid))

        db.session.execute(
            db.text(
                "INSERT INTO insertion_log "
                "(product_upc, product_sku, product_desc, stores_targeted, stores_succeeded, stores_failed, error_details, form_data) "
                "VALUES (:upc, :sku, :desc, :targeted, :succeeded, :failed, :errors, :form_data)"
            ),
            {
                "upc": common_fields.get("ProductUPC"),
                "sku": common_fields.get("ProductSKU"),
                "desc": common_fields.get("ProductDescription"),
                "targeted": store_names_targeted,
                "succeeded": succeeded,
                "failed": failed,
                "errors": json.dumps(error_details),
                "form_data": json.dumps(form_data, default=str),
            },
        )
        db.session.commit()
    except Exception:
        db.session.rollback()
