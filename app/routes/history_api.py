import csv
import io

from flask import Blueprint, Response, jsonify, request

from services.history_service import (
    delete_failed_entries,
    delete_history_entries,
    export_history_entries,
    get_history_entries,
    get_history_entry,
    get_history_stats,
    get_targeted_stores,
)

history_bp = Blueprint("history", __name__)


def _parse_filters():
    return {
        "search": request.args.get("search") or None,
        "entry_type": request.args.get("type") or None,
        "status": request.args.get("status") or None,
        "date_from": request.args.get("date_from") or None,
        "date_to": request.args.get("date_to") or None,
        "store_name": request.args.get("store") or None,
        "batch_id": request.args.get("batch_id") or None,
    }


@history_bp.route("/entries")
def list_entries():
    page = request.args.get("page", 1, type=int)
    per_page = min(request.args.get("per_page", 25, type=int), 100)
    filters = _parse_filters()
    result = get_history_entries(page=page, per_page=per_page, **filters)
    return jsonify(result)


@history_bp.route("/entries/<entry_type>/<int:entry_id>")
def get_entry_detail(entry_type, entry_id):
    if entry_type not in ("mssql", "shopify"):
        return jsonify({"error": "Invalid entry type"}), 400
    entry = get_history_entry(entry_type, entry_id)
    if not entry:
        return jsonify({"error": "Entry not found"}), 404
    return jsonify(entry)


@history_bp.route("/stats")
def stats():
    filters = _parse_filters()
    filters.pop("status", None)
    result = get_history_stats(**filters)
    return jsonify(result)


@history_bp.route("/stores")
def stores():
    return jsonify(get_targeted_stores())


@history_bp.route("/entries", methods=["DELETE"])
def bulk_delete():
    data = request.get_json()
    entries = data.get("entries", [])
    if not entries:
        return jsonify({"error": "No entries specified"}), 400
    count = delete_history_entries(entries)
    return jsonify({"message": f"{count} entries deleted", "count": count})


@history_bp.route("/entries/failed", methods=["DELETE"])
def clear_failed():
    count = delete_failed_entries()
    return jsonify({"message": f"{count} failed entries deleted", "count": count})


@history_bp.route("/export")
def export_csv():
    filters = _parse_filters()
    rows = export_history_entries(**filters)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "id", "entry_type", "created_at", "product_name", "product_upc",
        "product_sku", "status", "stores_targeted", "stores_succeeded",
        "stores_failed",
    ])
    writer.writeheader()
    writer.writerows(rows)

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=history_export.csv"},
    )
