import uuid

from flask import Blueprint, jsonify, request

from services.shopify_service import (
    get_all_shopify_stores,
    get_shopify_store,
    get_collections,
    get_locations,
    get_publications,
    get_product_types,
    push_to_stores,
)
from services.shopify_image_service import (
    process_images_for_store,
    upload_images_to_store,
    get_watermark_base64,
)

shopify_bp = Blueprint("shopify", __name__)

_temp_images = {}


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


@shopify_bp.route("/upload-images", methods=["POST"])
def upload_images():
    uploaded = []
    for key in request.files:
        f = request.files[key]
        if not f.filename:
            continue
        file_id = str(uuid.uuid4())
        file_bytes = f.read()
        _temp_images[file_id] = {
            "bytes": file_bytes,
            "filename": f.filename,
            "content_type": f.content_type or "image/jpeg",
        }
        uploaded.append({"id": file_id, "filename": f.filename})
    return jsonify({"images": uploaded})


@shopify_bp.route("/products", methods=["POST"])
def create_product():
    data = request.get_json()
    store_ids = data.get("store_ids", [])
    product_data = data.get("product_data", {})
    image_ids = data.get("image_ids", [])
    image_mode = data.get("image_mode", "shared")
    per_store_image_ids = data.get("per_store_image_ids", {})

    if not store_ids:
        return jsonify({"error": "No stores selected"}), 400
    if not product_data.get("product", {}).get("title"):
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
        img = _temp_images.get(img_id)
        if img:
            images.append(img)
    return images


def _cleanup_temp_images(image_ids):
    for img_id in image_ids:
        _temp_images.pop(img_id, None)
