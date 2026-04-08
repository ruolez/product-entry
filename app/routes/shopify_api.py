import uuid

from flask import Blueprint, jsonify, request

from services.shopify_service import (
    get_all_shopify_stores,
    get_collections,
    get_locations,
    get_publications,
    get_product_types,
    push_to_stores,
    staged_uploads_create,
    upload_file_to_staged_target,
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

    if not store_ids:
        return jsonify({"error": "No stores selected"}), 400
    if not product_data.get("product", {}).get("title"):
        return jsonify({"error": "Product title is required"}), 400

    image_resource_urls = None
    if image_ids:
        first_store_id = store_ids[0]
        resource_urls = _upload_images_to_shopify(first_store_id, image_ids)
        image_resource_urls = resource_urls

    try:
        results = push_to_stores(store_ids, product_data, image_resource_urls)
        _cleanup_temp_images(image_ids)
        return jsonify(results)
    except Exception as e:
        _cleanup_temp_images(image_ids)
        return jsonify({"error": str(e)}), 500


def _upload_images_to_shopify(store_id, image_ids):
    files_info = []
    valid_images = []
    for img_id in image_ids:
        img = _temp_images.get(img_id)
        if not img:
            continue
        valid_images.append(img)
        files_info.append({
            "filename": img["filename"],
            "mimeType": img["content_type"],
            "resource": "PRODUCT_IMAGE",
            "httpMethod": "POST",
        })

    if not files_info:
        return []

    targets = staged_uploads_create(store_id, files_info)
    resource_urls = []
    for target, img in zip(targets, valid_images):
        url = upload_file_to_staged_target(
            target, img["bytes"], img["filename"], img["content_type"]
        )
        resource_urls.append(url)

    return resource_urls


def _cleanup_temp_images(image_ids):
    for img_id in image_ids:
        _temp_images.pop(img_id, None)
