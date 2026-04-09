import os
import uuid
import tempfile
import json

from flask import Blueprint, jsonify, request

from services.shopify_service import (
    get_all_shopify_stores,
    get_shopify_store,
    get_collections,
    get_locations,
    get_publications,
    get_product_types,
    get_vendors,
    get_tags,
    get_store_data,
    push_to_stores,
    push_to_stores_per_store,
    lookup_product_by_barcode,
    search_products,
    get_product_detail,
    check_duplicate_sku_barcode,
)
from services.shopify_image_service import (
    process_images_for_store,
    upload_images_to_store,
    get_watermark_base64,
)

shopify_bp = Blueprint("shopify", __name__)

_UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "shopify_uploads")
os.makedirs(_UPLOAD_DIR, exist_ok=True)


@shopify_bp.route("/stores")
def list_stores():
    stores = get_all_shopify_stores(active_only=True)
    return jsonify([
        {"id": s["id"], "name": s["name"], "store_url": s["store_url"]}
        for s in stores
    ])


@shopify_bp.route("/stores/<int:store_id>/collections")
def store_collections(store_id):
    try:
        collections = get_collections(store_id)
        return jsonify(collections)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/locations")
def store_locations(store_id):
    try:
        locations = get_locations(store_id)
        return jsonify(locations)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/publications")
def store_publications(store_id):
    try:
        publications = get_publications(store_id)
        return jsonify(publications)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/product-types")
def store_product_types(store_id):
    try:
        types = get_product_types(store_id)
        return jsonify(types)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/debug")
def debug_all_stores():
    from services.shopify_service import test_shopify_connection
    stores = get_all_shopify_stores(active_only=False)
    results = []
    for s in stores:
        entry = {"id": s["id"], "name": s["name"], "store_url": s["store_url"], "is_active": s["is_active"]}
        try:
            ok, msg = test_shopify_connection(s["id"])
            entry["connection"] = {"success": ok, "message": msg}
        except Exception as e:
            entry["connection"] = {"success": False, "message": str(e)}
        if entry["connection"]["success"]:
            try:
                data = get_store_data(s["id"])
                entry["data"] = {
                    "vendors_count": len(data.get("vendors", [])),
                    "vendors_sample": data.get("vendors", [])[:5],
                    "tags_count": len(data.get("tags", [])),
                    "tags_sample": data.get("tags", [])[:5],
                    "productTypes_count": len(data.get("productTypes", [])),
                    "productTypes_sample": data.get("productTypes", [])[:5],
                    "collections_count": len(data.get("collections", [])),
                    "locations_count": len(data.get("locations", [])),
                    "publications_count": len(data.get("publications", [])),
                    "errors": data.get("errors", {}),
                }
            except Exception as e:
                entry["data_error"] = str(e)
        results.append(entry)
    return jsonify(results)


@shopify_bp.route("/stores/<int:store_id>/store-data")
def store_data(store_id):
    try:
        data = get_store_data(store_id)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/vendors")
def store_vendors(store_id):
    try:
        vendors = get_vendors(store_id)
        return jsonify(vendors)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/tags")
def store_tags(store_id):
    try:
        tags = get_tags(store_id)
        return jsonify(tags)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/stores/<int:store_id>/watermark-info")
def store_watermark_info(store_id):
    b64 = get_watermark_base64(store_id)
    if not b64:
        return jsonify({"has_watermark": False})
    store = get_shopify_store(store_id)
    return jsonify({
        "has_watermark": True,
        "watermark_base64": b64,
        "position": store.get("watermark_position", "bottom-right"),
        "opacity": float(store.get("watermark_opacity", 0.30)),
    })


@shopify_bp.route("/products/lookup", methods=["POST"])
def lookup_product():
    data = request.get_json()
    barcode = (data.get("barcode") or "").strip()
    if not barcode:
        return jsonify({"error": "Barcode is required"}), 400
    try:
        result = lookup_product_by_barcode(barcode)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/products/search")
def search_shopify_products():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    try:
        results = search_products(q, limit=50)
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/products/detail/<int:store_id>/<path:product_id>")
def product_detail(store_id, product_id):
    if not product_id.startswith("gid://"):
        product_id = f"gid://shopify/Product/{product_id}"
    try:
        result = get_product_detail(store_id, product_id)
        if not result:
            return jsonify({"error": "Product not found"}), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/products/check-duplicates", methods=["POST"])
def check_duplicates():
    data = request.get_json()
    store_id = data.get("store_id")
    sku = (data.get("sku") or "").strip()
    barcode = (data.get("barcode") or "").strip()
    if not store_id:
        return jsonify({"error": "store_id is required"}), 400
    if not sku and not barcode:
        return jsonify({})
    try:
        result = check_duplicate_sku_barcode(store_id, sku=sku or None, barcode=barcode or None)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@shopify_bp.route("/upload-images", methods=["POST"])
def upload_images():
    uploaded = []
    for key in request.files:
        f = request.files[key]
        if not f.filename:
            continue
        file_id = str(uuid.uuid4())
        file_path = os.path.join(_UPLOAD_DIR, file_id)
        f.save(file_path)
        meta = {
            "filename": f.filename,
            "content_type": f.content_type or "image/jpeg",
        }
        with open(file_path + ".meta", "w") as mf:
            json.dump(meta, mf)
        uploaded.append({"id": file_id, "filename": f.filename})
    return jsonify({"images": uploaded})


@shopify_bp.route("/products", methods=["POST"])
def create_product():
    data = request.get_json()
    store_ids = data.get("store_ids", [])
    product_data = data.get("product_data", {})
    per_store_product_data = data.get("per_store_product_data")
    image_ids = data.get("image_ids", [])
    image_mode = data.get("image_mode", "shared")
    per_store_image_ids = data.get("per_store_image_ids", {})

    if not store_ids:
        return jsonify({"error": "No stores selected"}), 400

    # Validate title — check per-store or shared
    if per_store_product_data:
        first_data = next(iter(per_store_product_data.values()), {})
        if not first_data.get("product", {}).get("title"):
            return jsonify({"error": "Product title is required"}), 400
    elif not product_data.get("product", {}).get("title"):
        return jsonify({"error": "Product title is required"}), 400

    raw_images = _collect_raw_images(image_ids)

    per_store_urls = {}
    if image_mode == "shared" and raw_images:
        for sid in store_ids:
            processed = process_images_for_store(sid, raw_images)
            urls = upload_images_to_store(sid, processed)
            per_store_urls[sid] = urls
    elif image_mode == "per_store":
        for sid in store_ids:
            sid_key = str(sid)
            store_img_ids = per_store_image_ids.get(sid_key, [])
            store_images = _collect_raw_images(store_img_ids)
            if store_images:
                urls = upload_images_to_store(sid, store_images)
                per_store_urls[sid] = urls

    try:
        if per_store_product_data:
            results = push_to_stores_per_store(store_ids, per_store_product_data, per_store_urls)
        else:
            results = push_to_stores(store_ids, product_data, per_store_urls)
        _cleanup_temp_images(image_ids)
        for ids in per_store_image_ids.values():
            _cleanup_temp_images(ids)
        return jsonify(results)
    except Exception as e:
        _cleanup_temp_images(image_ids)
        return jsonify({"error": str(e)}), 500


def _collect_raw_images(image_ids):
    images = []
    for img_id in image_ids:
        file_path = os.path.join(_UPLOAD_DIR, img_id)
        meta_path = file_path + ".meta"
        if not os.path.exists(file_path) or not os.path.exists(meta_path):
            continue
        with open(meta_path) as mf:
            meta = json.load(mf)
        with open(file_path, "rb") as f:
            file_bytes = f.read()
        images.append({
            "bytes": file_bytes,
            "filename": meta["filename"],
            "content_type": meta["content_type"],
        })
    return images


def _cleanup_temp_images(image_ids):
    for img_id in image_ids:
        for path in [
            os.path.join(_UPLOAD_DIR, img_id),
            os.path.join(_UPLOAD_DIR, img_id + ".meta"),
        ]:
            try:
                os.remove(path)
            except OSError:
                pass
