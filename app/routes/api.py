from flask import Blueprint, jsonify, request

from services.store_connection import get_all_stores
from services.lookup_service import (
    get_categories,
    get_subcategories,
    get_all_subcategories,
    get_taxes,
    get_units,
    get_manufacturers,
    get_promotions,
    get_bin_locations,
    search_products,
    get_product_by_upc,
)
from services.validation_service import validate_upc, validate_sku
from services.price_engine import get_formulas_for_stores
from services.item_service import insert_item, insert_sibling_item, get_field_configs

api_bp = Blueprint("api", __name__)


@api_bp.route("/health")
def health():
    return jsonify({"status": "ok"})


@api_bp.route("/stores")
def list_stores():
    stores = get_all_stores(active_only=True)
    return jsonify([
        {"id": s["id"], "name": s["name"], "is_active": s["is_active"], "is_primary": s["is_primary"]}
        for s in stores
    ])


@api_bp.route("/stores/<int:store_id>/categories")
def store_categories(store_id):
    try:
        return jsonify(get_categories(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/subcategories")
def store_subcategories(store_id):
    category_id = request.args.get("category_id", type=int)
    if category_id is None:
        return jsonify({"error": "category_id is required"}), 400
    try:
        return jsonify(get_subcategories(store_id, category_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/all-subcategories")
def store_all_subcategories(store_id):
    try:
        return jsonify(get_all_subcategories(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/products/search")
def store_search_products(store_id):
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    try:
        results = search_products(store_id, q)
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/products/lookup-by-upc", methods=["POST"])
def bulk_lookup_by_upc():
    data = request.get_json()
    upc = data.get("upc", "")
    store_ids = data.get("store_ids", [])
    if not upc or not store_ids:
        return jsonify({"error": "upc and store_ids required"}), 400
    try:
        results = {}
        for sid in store_ids:
            product = get_product_by_upc(sid, upc)
            results[str(sid)] = product
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/taxes")
def store_taxes(store_id):
    try:
        return jsonify(get_taxes(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/units")
def store_units(store_id):
    try:
        return jsonify(get_units(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/manufacturers")
def store_manufacturers(store_id):
    try:
        return jsonify(get_manufacturers(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/promotions")
def store_promotions(store_id):
    try:
        return jsonify(get_promotions(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/stores/<int:store_id>/bin-locations")
def store_bin_locations(store_id):
    try:
        return jsonify(get_bin_locations(store_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/validate/upc", methods=["POST"])
def check_upc():
    data = request.get_json()
    upc = data.get("upc", "")
    store_ids = data.get("store_ids", [])
    if not store_ids:
        return jsonify({"error": "store_ids required"}), 400
    try:
        result = validate_upc(upc, store_ids)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/validate/sku", methods=["POST"])
def check_sku():
    data = request.get_json()
    sku = data.get("sku", "")
    store_ids = data.get("store_ids", [])
    if not store_ids:
        return jsonify({"error": "store_ids required"}), 400
    try:
        result = validate_sku(sku, store_ids)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/field-configs")
def list_field_configs():
    configs = get_field_configs()
    return jsonify(configs)


@api_bp.route("/price-formulas")
def list_price_formulas():
    store_ids_str = request.args.get("store_ids", "")
    if not store_ids_str:
        return jsonify({})
    store_ids = [int(x) for x in store_ids_str.split(",") if x.strip()]
    formulas = get_formulas_for_stores(store_ids)
    serializable = {str(k): v for k, v in formulas.items()}
    return jsonify(serializable)


@api_bp.route("/items", methods=["POST"])
def create_item():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400

    store_ids = data.get("store_ids", [])
    if not store_ids:
        return jsonify({"error": "At least one store must be selected"}), 400

    common_fields = data.get("common_fields", {})
    if not common_fields:
        return jsonify({"error": "common_fields required"}), 400

    try:
        mode = data.get("mode", "new")
        if mode == "sibling":
            result = insert_sibling_item(data)
        else:
            result = insert_item(data)
        status = 200 if result["success"] else 207
        if result.get("errors"):
            status = 422
        return jsonify(result), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500
