import os
import uuid
import tempfile
from io import BytesIO

from openpyxl import load_workbook

from models.settings import db
from services.store_connection import execute_query, get_store
from services.lookup_service import get_all_subcategories
from services.item_service import insert_item, get_field_configs


UPLOAD_DIR = tempfile.gettempdir()
_file_cache = {}

COLUMN_ALIASES = {
    "ProductUPC": [
        "upc", "barcode", "productupc", "product upc", "item upc",
        "upc code", "upc/barcode", "product barcode",
    ],
    "ProductSKU": [
        "sku", "productsku", "product sku", "item sku", "sku code",
        "item code", "item number", "item #", "item no",
    ],
    "ProductDescription": [
        "description", "name", "product name", "productdescription",
        "product description", "item name", "item description", "product",
    ],
    "CateName": [
        "category", "main category", "categoryname", "category name",
        "dept", "department",
    ],
    "SubCateName": [
        "subcategory", "sub category", "subcatename", "sub category name",
        "subcategory name", "sub-category",
    ],
    "UnitCost": ["unit cost", "cost", "unitcost", "cost price"],
    "UnitPrice": [
        "unit price", "price", "unitprice", "standard price",
        "retail price", "retail", "sell price", "selling price",
    ],
    "UnitPriceA": [
        "unitpricea", "price a", "cash and carry", "cash & carry",
        "c&c price", "pricea",
    ],
    "UnitPriceB": [
        "unitpriceb", "price b", "delivery a", "delivery a price",
        "del a price", "priceb",
    ],
    "UnitPriceC": [
        "unitpricec", "price c", "delivery b", "delivery b price",
        "del b price", "pricec",
    ],
    "MSRPrice": [
        "msrp", "msrprice", "manufacturer price", "msr price",
        "suggested retail", "suggested price",
    ],
}


def store_upload(file_bytes):
    upload_id = str(uuid.uuid4())
    path = os.path.join(UPLOAD_DIR, f"import_{upload_id}.xlsx")
    with open(path, "wb") as f:
        f.write(file_bytes)
    _file_cache[upload_id] = {"path": path}
    return upload_id


def get_upload(upload_id):
    entry = _file_cache.get(upload_id)
    if not entry or not os.path.exists(entry["path"]):
        return None
    with open(entry["path"], "rb") as f:
        return f.read()


def cleanup_upload(upload_id):
    entry = _file_cache.pop(upload_id, None)
    if entry and os.path.exists(entry.get("path", "")):
        os.remove(entry["path"])


def detect_columns(headers):
    mapping = {}
    used_indices = set()
    for field_name, aliases in COLUMN_ALIASES.items():
        for col_idx, header in enumerate(headers):
            if col_idx in used_indices:
                continue
            normalized = header.strip().lower()
            if normalized in aliases:
                mapping[field_name] = col_idx
                used_indices.add(col_idx)
                break
    return mapping


def parse_excel(file_bytes, sheet_name=None):
    wb = load_workbook(BytesIO(file_bytes), read_only=True, data_only=True)
    sheets = wb.sheetnames

    ws = wb[sheet_name] if sheet_name and sheet_name in sheets else wb.active
    active_sheet = ws.title

    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    if not rows:
        return {"error": "File is empty"}

    headers = [str(cell or "").strip() for cell in rows[0]]
    data_rows = rows[1:]

    # Filter out completely empty rows
    non_empty_rows = [r for r in data_rows if any(cell is not None and str(cell).strip() for cell in r)]

    preview = []
    for row in non_empty_rows[:5]:
        preview.append([str(cell) if cell is not None else "" for cell in row])

    auto_mapping = detect_columns(headers)

    return {
        "sheets": sheets,
        "active_sheet": active_sheet,
        "headers": headers,
        "preview_rows": preview,
        "total_rows": len(non_empty_rows),
        "auto_mapping": auto_mapping,
    }


def extract_rows_with_mapping(file_bytes, sheet_name, column_mapping):
    wb = load_workbook(BytesIO(file_bytes), read_only=True, data_only=True)
    ws = wb[sheet_name] if sheet_name else wb.active
    all_rows = list(ws.iter_rows(values_only=True))
    wb.close()

    if len(all_rows) < 2:
        return []

    data_rows = all_rows[1:]
    result = []
    for raw_row in data_rows:
        # Skip completely empty rows
        if not any(cell is not None and str(cell).strip() for cell in raw_row):
            continue
        row_dict = {}
        for field_name, col_idx in column_mapping.items():
            if col_idx < len(raw_row):
                val = raw_row[col_idx]
                row_dict[field_name] = str(val).strip() if val is not None else ""
            else:
                row_dict[field_name] = ""
        # Store raw column values for per-store price lookups
        row_dict["_raw"] = [str(cell).strip() if cell is not None else "" for cell in raw_row]
        result.append(row_dict)
    return result


def match_categories(store_ids, rows):
    unique_subcats = set()
    unique_cats = set()
    for row in rows:
        sub_text = row.get("SubCateName", "").strip()
        cat_text = row.get("CateName", "").strip()
        if sub_text:
            unique_subcats.add(sub_text)
        if cat_text:
            unique_cats.add(cat_text)

    results = {}
    for store_id in store_ids:
        all_subs = get_all_subcategories(store_id)

        sub_lookup = {}
        for sub in all_subs:
            key = sub["SubCateName"].strip().lower()
            sub_lookup[key] = {
                "SubCateID": sub["SubCateID"],
                "CateID": sub["CategoryID"],
                "SubCateName": sub["SubCateName"],
                "CategoryName": sub["CategoryName"],
            }

        store_matches = {}
        for sub_text in unique_subcats:
            match = sub_lookup.get(sub_text.lower())
            if match:
                store_matches[sub_text] = {"matched": True, **match}
            else:
                store_matches[sub_text] = {
                    "matched": False,
                    "SubCateID": None,
                    "CateID": None,
                    "SubCateName": sub_text,
                    "CategoryName": None,
                }

        results[str(store_id)] = {
            "subcategories": store_matches,
            "all_subcategories": all_subs,
        }

    return results


def validate_batch(rows, store_ids, category_assignments):
    all_upcs = [r.get("ProductUPC", "").strip() for r in rows if r.get("ProductUPC", "").strip()]
    all_skus = [r.get("ProductSKU", "").strip() for r in rows if r.get("ProductSKU", "").strip()]

    existing_upcs = {}
    existing_skus = {}

    for store_id in store_ids:
        if all_upcs:
            store_existing = set()
            for chunk in _chunks(all_upcs, 100):
                placeholders = ", ".join(["%s"] * len(chunk))
                found = execute_query(
                    store_id,
                    f"SELECT ProductUPC FROM Items_tbl WHERE ProductUPC IN ({placeholders})",
                    tuple(chunk),
                )
                store_existing.update(r["ProductUPC"] for r in found)
            existing_upcs[store_id] = store_existing

        if all_skus:
            store_existing = set()
            for chunk in _chunks(all_skus, 100):
                placeholders = ", ".join(["%s"] * len(chunk))
                found = execute_query(
                    store_id,
                    f"SELECT ProductSKU FROM Items_tbl WHERE ProductSKU IN ({placeholders})",
                    tuple(chunk),
                )
                store_existing.update(r["ProductSKU"] for r in found)
            existing_skus[store_id] = store_existing

    upc_counts = {}
    for r in rows:
        upc = r.get("ProductUPC", "").strip()
        if upc:
            upc_counts[upc] = upc_counts.get(upc, 0) + 1

    store_name_cache = {}
    for sid in store_ids:
        store = get_store(sid)
        store_name_cache[sid] = store["name"] if store else f"Store {sid}"

    results = []
    for idx, row in enumerate(rows):
        errors = []
        upc = row.get("ProductUPC", "").strip()
        sku = row.get("ProductSKU", "").strip()
        desc = row.get("ProductDescription", "").strip()

        if not upc:
            errors.append({"field": "ProductUPC", "error": "UPC is required"})
        if not desc:
            errors.append({"field": "ProductDescription", "error": "Description is required"})

        if upc and len(upc) > 20:
            errors.append({"field": "ProductUPC", "error": "UPC exceeds 20 characters"})
        if sku and len(sku) > 20:
            errors.append({"field": "ProductSKU", "error": "SKU exceeds 20 characters"})
        if desc and len(desc) > 50:
            errors.append({"field": "ProductDescription", "error": "Description exceeds 50 characters"})

        if upc and upc_counts.get(upc, 0) > 1:
            errors.append({"field": "ProductUPC", "error": "Duplicate UPC within this import file"})

        is_duplicate = False
        if upc:
            stores_with_upc = [
                store_name_cache[sid]
                for sid in store_ids
                if upc in existing_upcs.get(sid, set())
            ]
            if stores_with_upc:
                errors.append({
                    "field": "ProductUPC",
                    "error": f"UPC already exists in: {', '.join(stores_with_upc)}",
                })
                is_duplicate = True

        if sku:
            stores_with_sku = [
                store_name_cache[sid]
                for sid in store_ids
                if sku in existing_skus.get(sid, set())
            ]
            if stores_with_sku:
                errors.append({
                    "field": "ProductSKU",
                    "error": f"SKU already exists in: {', '.join(stores_with_sku)}",
                })

        for store_id in store_ids:
            sid = str(store_id)
            sub_text = row.get("SubCateName", "").strip()
            if sub_text:
                store_cats = category_assignments.get(sid, {})
                sub_match = store_cats.get(sub_text, {})
                if not sub_match.get("SubCateID"):
                    errors.append({
                        "field": "SubCateID",
                        "error": f"Subcategory '{sub_text}' not matched for {store_name_cache[store_id]}",
                    })

        if is_duplicate:
            status = "duplicate"
        elif errors:
            status = "error"
        else:
            status = "valid"

        results.append({
            "row_index": idx,
            "status": status,
            "errors": errors,
            "upc": upc,
            "sku": sku,
            "description": desc,
        })

    return results


def execute_import(rows, store_ids, category_assignments, price_mode, price_mapping, skip_rows):
    batch_id = str(uuid.uuid4())
    results = []
    succeeded = 0
    failed = 0
    skipped = 0

    skip_set = set(skip_rows) if skip_rows else set()

    price_field_names = {"UnitCost", "UnitPrice", "UnitPriceA", "UnitPriceB", "UnitPriceC", "MSRPrice"}
    any_store_uses_formula = any(
        price_mode.get(str(sid), "formula") == "formula"
        for sid in store_ids
    )

    for idx, row in enumerate(rows):
        if idx in skip_set:
            skipped += 1
            results.append({
                "row_index": idx,
                "upc": row.get("ProductUPC", ""),
                "description": row.get("ProductDescription", ""),
                "status": "skipped",
            })
            continue

        per_store_fields = {}
        for store_id in store_ids:
            sid = str(store_id)
            store_fields = {}

            sub_text = row.get("SubCateName", "").strip()
            if sub_text:
                cat_data = category_assignments.get(sid, {}).get(sub_text, {})
                if cat_data.get("SubCateID"):
                    store_fields["CateID"] = cat_data["CateID"]
                    store_fields["SubCateID"] = cat_data["SubCateID"]

            store_price_mode = price_mode.get(sid, "formula")
            if store_price_mode == "excel":
                store_price_map = price_mapping.get(sid, {})
                raw = row.get("_raw", [])
                for price_field, col_idx in store_price_map.items():
                    try:
                        ci = int(col_idx)
                        val = raw[ci] if ci < len(raw) else ""
                    except (ValueError, IndexError):
                        val = ""
                    if val is not None and val != "":
                        try:
                            store_fields[price_field] = float(val)
                        except (ValueError, TypeError):
                            pass

            if store_fields:
                per_store_fields[sid] = store_fields

        common_fields = {}
        skip_keys = {"SubCateName", "CateName", "CateID", "SubCateID", "_raw"}
        for key, val in row.items():
            if key in skip_keys:
                continue
            if key.startswith("_"):
                continue
            # If any store uses formula mode, don't put prices in common_fields
            # They will be handled per-store (either from Excel or via formula)
            if key in price_field_names and any_store_uses_formula:
                continue
            if val is not None and val != "":
                common_fields[key] = val

        # For stores using "excel" mode without per-store mapping,
        # add global price values to per_store_fields
        if any_store_uses_formula:
            for store_id in store_ids:
                sid = str(store_id)
                if price_mode.get(sid, "formula") == "excel":
                    if sid not in per_store_fields:
                        per_store_fields[sid] = {}
                    store_price_map = price_mapping.get(sid, {})
                    if not store_price_map:
                        for pf in price_field_names:
                            val = row.get(pf, "")
                            if val is not None and val != "":
                                try:
                                    per_store_fields[sid][pf] = float(val)
                                except (ValueError, TypeError):
                                    pass

        data = {
            "store_ids": store_ids,
            "common_fields": common_fields,
            "per_store_fields": per_store_fields,
            "batch_id": batch_id,
        }

        result = insert_item(data)

        if result["success"]:
            succeeded += 1
            results.append({
                "row_index": idx,
                "upc": row.get("ProductUPC", ""),
                "description": row.get("ProductDescription", ""),
                "status": "success",
                "results": result["results"],
            })
        else:
            failed += 1
            results.append({
                "row_index": idx,
                "upc": row.get("ProductUPC", ""),
                "description": row.get("ProductDescription", ""),
                "status": "failed",
                "errors": result.get("errors", []),
                "results": result.get("results", []),
            })

    return {
        "batch_id": batch_id,
        "total": len(rows),
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
        "results": results,
    }


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]
