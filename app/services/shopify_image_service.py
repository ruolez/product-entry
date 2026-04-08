import io

from PIL import Image, ImageEnhance

from models.settings import db
from services.shopify_service import (
    get_shopify_store,
    staged_uploads_create,
    upload_file_to_staged_target,
)


POSITION_MAP = {
    "bottom-right": lambda iw, ih, ww, wh: (iw - ww - 20, ih - wh - 20),
    "bottom-left": lambda iw, ih, ww, wh: (20, ih - wh - 20),
    "top-right": lambda iw, ih, ww, wh: (iw - ww - 20, 20),
    "top-left": lambda iw, ih, ww, wh: (20, 20),
    "center": lambda iw, ih, ww, wh: ((iw - ww) // 2, (ih - wh) // 2),
}


def apply_watermark(image_bytes, watermark_bytes, position="bottom-right", opacity=0.30):
    base = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    watermark = Image.open(io.BytesIO(watermark_bytes)).convert("RGBA")

    target_width = max(int(base.width * 0.20), 40)
    ratio = target_width / watermark.width
    target_height = int(watermark.height * ratio)
    watermark = watermark.resize((target_width, target_height), Image.LANCZOS)

    alpha = watermark.split()[3]
    alpha = ImageEnhance.Brightness(alpha).enhance(opacity)
    watermark.putalpha(alpha)

    pos_fn = POSITION_MAP.get(position, POSITION_MAP["bottom-right"])
    x, y = pos_fn(base.width, base.height, watermark.width, watermark.height)

    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(watermark, (x, y))
    composite = Image.alpha_composite(base, layer)

    output = composite.convert("RGB")
    buf = io.BytesIO()
    output.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def process_images_for_store(store_id, images):
    store = get_shopify_store(store_id)
    if not store:
        return images

    watermark_bytes = store.get("watermark_image")
    if not watermark_bytes:
        return images

    position = store.get("watermark_position", "bottom-right")
    opacity = float(store.get("watermark_opacity", 0.30))

    processed = []
    for img in images:
        try:
            watermarked = apply_watermark(
                img["bytes"], watermark_bytes, position, opacity
            )
            processed.append({
                "bytes": watermarked,
                "filename": img["filename"],
                "content_type": "image/jpeg",
            })
        except Exception:
            processed.append(img)
    return processed


def upload_images_to_store(store_id, images):
    if not images:
        return []

    files_info = [
        {
            "filename": img["filename"],
            "mimeType": img["content_type"],
            "resource": "PRODUCT_IMAGE",
            "httpMethod": "POST",
        }
        for img in images
    ]

    targets = staged_uploads_create(store_id, files_info)
    resource_urls = []
    for target, img in zip(targets, images):
        url = upload_file_to_staged_target(
            target, img["bytes"], img["filename"], img["content_type"]
        )
        resource_urls.append(url)

    return resource_urls


def get_watermark_base64(store_id):
    import base64
    store = get_shopify_store(store_id)
    if not store or not store.get("watermark_image"):
        return None
    return base64.b64encode(store["watermark_image"]).decode()
