import json

import httpx
from models.settings import db
from services.store_connection import decrypt_password


SHOPIFY_API_VERSION = "2025-04"


def get_all_shopify_stores(active_only=True):
    sql = "SELECT * FROM shopify_stores"
    if active_only:
        sql += " WHERE is_active = TRUE"
    sql += " ORDER BY sort_order, name"
    result = db.session.execute(db.text(sql))
    rows = result.mappings().all()
    return [dict(r) for r in rows]


def get_shopify_store(store_id):
    result = db.session.execute(
        db.text("SELECT * FROM shopify_stores WHERE id = :id"),
        {"id": store_id},
    )
    row = result.mappings().first()
    return dict(row) if row else None


def _build_client(store):
    store_url = store["store_url"].rstrip("/")
    if not store_url.startswith("http"):
        store_url = f"https://{store_url}"
    token = decrypt_password(store["access_token_enc"])
    return store_url, token


def _graphql_url(store_url):
    return f"{store_url}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"


def execute_graphql(store_id, query, variables=None):
    store = get_shopify_store(store_id)
    if not store:
        raise ValueError(f"Shopify store {store_id} not found")

    store_url, token = _build_client(store)
    url = _graphql_url(store_url)

    payload = {"query": query}
    if variables:
        payload["variables"] = variables

    with httpx.Client(timeout=30) as client:
        resp = client.post(
            url,
            json=payload,
            headers={
                "X-Shopify-Access-Token": token,
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")

    return data.get("data", {})


def test_shopify_connection(store_id):
    try:
        data = execute_graphql(store_id, "{ shop { name myshopifyDomain } }")
        shop = data.get("shop", {})
        return True, f"Connected to {shop.get('name', 'unknown')}"
    except Exception as e:
        return False, str(e)


def get_collections(store_id):
    query = """
    {
        collections(first: 250) {
            edges {
                node {
                    id
                    title
                    handle
                }
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    edges = data.get("collections", {}).get("edges", [])
    return [edge["node"] for edge in edges]


def get_locations(store_id):
    query = """
    {
        locations(first: 50) {
            edges {
                node {
                    id
                    name
                    isActive
                }
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    edges = data.get("locations", {}).get("edges", [])
    return [edge["node"] for edge in edges if edge["node"].get("isActive", True)]


def get_publications(store_id):
    query = """
    {
        publications(first: 50) {
            edges {
                node {
                    id
                    name
                }
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    edges = data.get("publications", {}).get("edges", [])
    return [edge["node"] for edge in edges]


def get_product_types(store_id):
    query = """
    {
        productTypes(first: 250) {
            edges {
                node
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    edges = data.get("productTypes", {}).get("edges", [])
    return [edge["node"] for edge in edges]


def staged_uploads_create(store_id, files_info):
    query = """
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets {
                url
                resourceUrl
                parameters {
                    name
                    value
                }
            }
            userErrors {
                field
                message
            }
        }
    }
    """
    variables = {"input": files_info}
    data = execute_graphql(store_id, query, variables)
    result = data.get("stagedUploadsCreate", {})
    errors = result.get("userErrors", [])
    if errors:
        raise RuntimeError(f"Staged upload errors: {errors}")
    return result.get("stagedTargets", [])


def upload_file_to_staged_target(target, file_bytes, filename, content_type):
    params = {p["name"]: p["value"] for p in target["parameters"]}
    files = {"file": (filename, file_bytes, content_type)}

    with httpx.Client(timeout=60) as client:
        resp = client.post(target["url"], data=params, files=files)
        resp.raise_for_status()

    return target["resourceUrl"]


def create_product(store_id, product_input):
    query = """
    mutation productSet($synchronous: Boolean!, $input: ProductSetInput!) {
        productSet(synchronous: $synchronous, input: $input) {
            product {
                id
                title
                handle
                status
                variants(first: 100) {
                    edges {
                        node {
                            id
                            title
                            price
                            sku
                            inventoryItem {
                                id
                            }
                        }
                    }
                }
            }
            userErrors {
                field
                message
            }
        }
    }
    """
    variables = {"synchronous": True, "input": product_input}
    data = execute_graphql(store_id, query, variables)
    result = data.get("productSet", {})
    errors = result.get("userErrors", [])
    if errors:
        raise RuntimeError(f"Product creation errors: {errors}")
    return result.get("product")


def set_inventory_quantities(store_id, inventory_item_id, location_quantities):
    query = """
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
                reason
            }
            userErrors {
                field
                message
            }
        }
    }
    """
    quantities = [
        {
            "inventoryItemId": inventory_item_id,
            "locationId": loc_id,
            "quantity": qty,
        }
        for loc_id, qty in location_quantities.items()
    ]

    variables = {
        "input": {
            "name": "available",
            "reason": "correction",
            "quantities": quantities,
        }
    }
    data = execute_graphql(store_id, query, variables)
    result = data.get("inventorySetQuantities", {})
    errors = result.get("userErrors", [])
    if errors:
        raise RuntimeError(f"Inventory errors: {errors}")
    return result


def publish_product(store_id, product_id, publication_ids):
    query = """
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
            publishable {
                ... on Product {
                    id
                }
            }
            userErrors {
                field
                message
            }
        }
    }
    """
    variables = {
        "id": product_id,
        "input": [{"publicationId": pub_id} for pub_id in publication_ids],
    }
    data = execute_graphql(store_id, query, variables)
    result = data.get("publishablePublish", {})
    errors = result.get("userErrors", [])
    if errors:
        raise RuntimeError(f"Publish errors: {errors}")
    return result


def push_to_stores(store_ids, product_data, image_resource_urls=None):
    results = {
        "stores_succeeded": [],
        "stores_failed": [],
        "error_details": {},
        "product_ids": {},
    }

    for sid in store_ids:
        store = get_shopify_store(sid)
        store_name = store["name"] if store else f"Store {sid}"
        try:
            product_input = _build_product_set_input(
                product_data, image_resource_urls
            )
            product = create_product(sid, product_input)

            if not product:
                raise RuntimeError("No product returned")

            product_id = product["id"]
            results["product_ids"][store_name] = product_id
            results["stores_succeeded"].append(store_name)

            inventory = product_data.get("inventory", {})
            location_quantities = inventory.get("location_quantities", {})
            if location_quantities:
                variants = product.get("variants", {}).get("edges", [])
                for variant_edge in variants:
                    inv_item_id = variant_edge["node"]["inventoryItem"]["id"]
                    set_inventory_quantities(sid, inv_item_id, location_quantities)

            pub_ids = product_data.get("publication_ids", [])
            if pub_ids:
                publish_product(sid, product_id, pub_ids)

        except Exception as e:
            results["stores_failed"].append(store_name)
            results["error_details"][store_name] = str(e)

    _log_insertion(product_data, results)
    return results


def _build_product_set_input(product_data, image_resource_urls=None):
    product = product_data.get("product", {})
    inp = {"title": product.get("title", "")}

    if product.get("descriptionHtml"):
        inp["descriptionHtml"] = product["descriptionHtml"]
    if product.get("handle"):
        inp["handle"] = product["handle"]
    if product.get("vendor"):
        inp["vendor"] = product["vendor"]
    if product.get("productType"):
        inp["productType"] = product["productType"]
    if product.get("tags"):
        inp["tags"] = product["tags"]
    if product.get("status"):
        inp["status"] = product["status"]
    if product.get("templateSuffix"):
        inp["templateSuffix"] = product["templateSuffix"]

    if product.get("seo"):
        inp["seo"] = product["seo"]

    if product.get("metafields"):
        inp["metafields"] = product["metafields"]

    if product.get("productOptions"):
        inp["productOptions"] = product["productOptions"]

    if product.get("variants"):
        inp["variants"] = product["variants"]

    if product.get("collectionsToJoin"):
        inp["collectionsToJoin"] = product["collectionsToJoin"]

    if product.get("category"):
        inp["category"] = product["category"]

    if image_resource_urls:
        inp["files"] = [
            {"originalSource": url, "contentType": "IMAGE"}
            for url in image_resource_urls
        ]

    return inp


def _log_insertion(product_data, results):
    try:
        product = product_data.get("product", {})
        db.session.execute(
            db.text(
                "INSERT INTO shopify_insertion_log "
                "(product_title, stores_targeted, stores_succeeded, stores_failed, "
                "error_details, form_data, shopify_product_ids) "
                "VALUES (:title, :targeted, :succeeded, :failed, "
                ":errors, :form, :ids)"
            ),
            {
                "title": product.get("title", ""),
                "targeted": results["stores_succeeded"] + results["stores_failed"],
                "succeeded": results["stores_succeeded"],
                "failed": results["stores_failed"],
                "errors": json.dumps(results["error_details"]),
                "form": json.dumps(product_data, default=str),
                "ids": json.dumps(results["product_ids"]),
            },
        )
        db.session.commit()
    except Exception:
        db.session.rollback()
