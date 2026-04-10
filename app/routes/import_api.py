from flask import Blueprint, jsonify, request

from services.import_service import (
    store_upload,
    get_upload,
    cleanup_upload,
    parse_excel,
    extract_rows_with_mapping,
    match_categories,
    validate_batch,
    execute_import,
)
from services.lookup_service import get_all_subcategories

import_bp = Blueprint("import", __name__)


@import_bp.route("/upload", methods=["POST"])
def upload_file():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename or not file.filename.endswith(".xlsx"):
        return jsonify({"error": "Only .xlsx files are accepted"}), 400

    file_bytes = file.read()
    if not file_bytes:
        return jsonify({"error": "File is empty"}), 400

    upload_id = store_upload(file_bytes)
    result = parse_excel(file_bytes)

    if "error" in result:
        cleanup_upload(upload_id)
        return jsonify({"error": result["error"]}), 400

    result["upload_id"] = upload_id
    return jsonify(result)


@import_bp.route("/select-sheet", methods=["POST"])
def select_sheet():
    data = request.get_json()
    upload_id = data.get("upload_id")
    sheet_name = data.get("sheet_name")

    if not upload_id or not sheet_name:
        return jsonify({"error": "upload_id and sheet_name required"}), 400

    file_bytes = get_upload(upload_id)
    if not file_bytes:
        return jsonify({"error": "Upload not found or expired"}), 404

    result = parse_excel(file_bytes, sheet_name=sheet_name)
    if "error" in result:
        return jsonify({"error": result["error"]}), 400

    result["upload_id"] = upload_id
    return jsonify(result)


@import_bp.route("/match-categories", methods=["POST"])
def match_cats():
    data = request.get_json()
    upload_id = data.get("upload_id")
    store_ids = data.get("store_ids", [])
    column_mapping = data.get("column_mapping", {})
    sheet_name = data.get("sheet_name")

    if not upload_id or not store_ids or not column_mapping:
        return jsonify({"error": "upload_id, store_ids, and column_mapping required"}), 400

    file_bytes = get_upload(upload_id)
    if not file_bytes:
        return jsonify({"error": "Upload not found or expired"}), 404

    int_mapping = {k: int(v) for k, v in column_mapping.items()}
    rows = extract_rows_with_mapping(file_bytes, sheet_name, int_mapping)

    if not rows:
        return jsonify({"error": "No data rows found"}), 400

    result = match_categories(store_ids, rows)
    return jsonify(result)


@import_bp.route("/validate", methods=["POST"])
def validate():
    data = request.get_json()
    upload_id = data.get("upload_id")
    store_ids = data.get("store_ids", [])
    column_mapping = data.get("column_mapping", {})
    store_mappings = data.get("store_mappings", {})
    category_assignments = data.get("category_assignments", {})
    sheet_name = data.get("sheet_name")

    if not upload_id or not store_ids:
        return jsonify({"error": "upload_id and store_ids required"}), 400

    file_bytes = get_upload(upload_id)
    if not file_bytes:
        return jsonify({"error": "Upload not found or expired"}), 404

    int_mapping = {k: int(v) for k, v in column_mapping.items()}
    rows = extract_rows_with_mapping(file_bytes, sheet_name, int_mapping)

    if not rows:
        return jsonify({"error": "No data rows found"}), 400

    int_store_mappings = {}
    for sid, mapping in store_mappings.items():
        int_store_mappings[sid] = {k: int(v) for k, v in mapping.items()}

    results = validate_batch(rows, store_ids, category_assignments, int_store_mappings)

    valid_count = sum(1 for r in results if r["status"] == "valid")
    duplicate_count = sum(1 for r in results if r["status"] == "duplicate")
    error_count = sum(1 for r in results if r["status"] == "error")

    return jsonify({
        "total_rows": len(results),
        "valid": valid_count,
        "duplicates": duplicate_count,
        "errors": error_count,
        "rows": results,
    })


@import_bp.route("/execute", methods=["POST"])
def execute():
    data = request.get_json()
    upload_id = data.get("upload_id")
    store_ids = data.get("store_ids", [])
    column_mapping = data.get("column_mapping", {})
    store_mappings = data.get("store_mappings", {})
    category_assignments = data.get("category_assignments", {})
    price_mode = data.get("price_mode", {})
    skip_rows = data.get("skip_rows", [])
    sheet_name = data.get("sheet_name")

    if not upload_id or not store_ids:
        return jsonify({"error": "upload_id and store_ids required"}), 400

    file_bytes = get_upload(upload_id)
    if not file_bytes:
        return jsonify({"error": "Upload not found or expired"}), 404

    int_mapping = {k: int(v) for k, v in column_mapping.items()}
    rows = extract_rows_with_mapping(file_bytes, sheet_name, int_mapping)

    if not rows:
        return jsonify({"error": "No data rows found"}), 400

    int_store_mappings = {}
    for sid, mapping in store_mappings.items():
        int_store_mappings[sid] = {k: int(v) for k, v in mapping.items()}

    result = execute_import(
        rows, store_ids, category_assignments,
        price_mode, int_store_mappings, skip_rows,
    )

    cleanup_upload(upload_id)

    return jsonify(result)


@import_bp.route("/stores/<int:store_id>/subcategories-list")
def store_subcategories_list(store_id):
    try:
        return jsonify(get_all_subcategories(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
