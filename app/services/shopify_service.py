import json

import httpx
from models.settings import db
from services.store_connection import decrypt_password


SHOPIFY_API_VERSION = "2024-10"


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


_API_VERSIONS = ["2024-10", "2024-07", "2024-04"]


def _graphql_url(store_url, version=None):
    v = version or SHOPIFY_API_VERSION
    return f"{store_url}/admin/api/{v}/graphql.json"


def execute_graphql(store_id, query, variables=None):
    store = get_shopify_store(store_id)
    if not store:
        raise ValueError(f"Shopify store {store_id} not found")

    store_url, token = _build_client(store)
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    payload = {"query": query}
    if variables:
        payload["variables"] = variables

    last_error = None
    for version in _API_VERSIONS:
        url = _graphql_url(store_url, version)
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

            if "errors" in data:
                last_error = RuntimeError(f"GraphQL errors: {data['errors']}")
                continue

            return data.get("data", {})
        except httpx.HTTPStatusError:
            last_error = RuntimeError(f"HTTP {resp.status_code} from {version}")
            continue
        except Exception as e:
            last_error = e
            continue

    raise last_error or RuntimeError("All API versions failed")


def test_shopify_connection(store_id):
    try:
        data = execute_graphql(
            store_id,
            "{ shop { name myshopifyDomain } productTypes(first: 1) { nodes } }"
        )
        shop = data.get("shop", {})
        has_products_scope = "productTypes" in data
        msg = f"Connected to {shop.get('name', 'unknown')}"
        if has_products_scope:
            msg += " (read_products scope OK)"
        else:
            msg += " (WARNING: read_products scope may be missing)"
        return True, msg
    except Exception as e:
        return False, str(e)


def get_store_data(store_id):
    result = {
        "vendors": [], "tags": [], "productTypes": [],
        "collections": [], "locations": [], "publications": [],
        "errors": {},
    }

    # Try consolidated query first
    consolidated_query = """
    {
        productVendors(first: 250) { nodes }
        productTags(first: 250) { nodes }
        productTypes(first: 250) { nodes }
        collections(first: 250) { nodes { id title handle } }
        locations(first: 50) { nodes { id name isActive } }
    }
    """
    try:
        data = execute_graphql(store_id, consolidated_query)
        result["vendors"] = data.get("productVendors", {}).get("nodes", [])
        result["tags"] = data.get("productTags", {}).get("nodes", [])
        result["productTypes"] = data.get("productTypes", {}).get("nodes", [])
        result["collections"] = data.get("collections", {}).get("nodes", [])
        all_locations = data.get("locations", {}).get("nodes", [])
        result["locations"] = [loc for loc in all_locations if loc.get("isActive", True)]
    except Exception as e:
        result["errors"]["consolidated"] = str(e)
        # Fall back to individual queries
        for field, query, parser in [
            ("vendors", "{ productVendors(first: 250) { nodes } }",
             lambda d: d.get("productVendors", {}).get("nodes", [])),
            ("tags", "{ productTags(first: 250) { nodes } }",
             lambda d: d.get("productTags", {}).get("nodes", [])),
            ("productTypes", "{ productTypes(first: 250) { nodes } }",
             lambda d: d.get("productTypes", {}).get("nodes", [])),
            ("collections", "{ collections(first: 250) { nodes { id title handle } } }",
             lambda d: d.get("collections", {}).get("nodes", [])),
            ("locations", "{ locations(first: 50) { nodes { id name isActive } } }",
             lambda d: [l for l in d.get("locations", {}).get("nodes", []) if l.get("isActive", True)]),
        ]:
            try:
                data = execute_graphql(store_id, query)
                result[field] = parser(data)
            except Exception as ex:
                result["errors"][field] = str(ex)

    # Publications need read_publications scope - separate query
    try:
        pub_data = execute_graphql(
            store_id, "{ publications(first: 50) { nodes { id name } } }"
        )
        result["publications"] = pub_data.get("publications", {}).get("nodes", [])
    except Exception as e:
        result["errors"]["publications"] = str(e)

    return result


def get_collections(store_id):
    query = """
    {
        collections(first: 250) {
            nodes {
                id
                title
                handle
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    return data.get("collections", {}).get("nodes", [])


def get_locations(store_id):
    query = """
    {
        locations(first: 50) {
            nodes {
                id
                name
                isActive
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    nodes = data.get("locations", {}).get("nodes", [])
    return [loc for loc in nodes if loc.get("isActive", True)]


def get_publications(store_id):
    query = """
    {
        publications(first: 50) {
            nodes {
                id
                name
            }
        }
    }
    """
    data = execute_graphql(store_id, query)
    return data.get("publications", {}).get("nodes", [])


def get_product_types(store_id):
    query = """
    {
        productTypes(first: 250) {
            nodes
        }
    }
    """
    data = execute_graphql(store_id, query)
    return data.get("productTypes", {}).get("nodes", [])


def get_vendors(store_id):
    query = """
    {
        productVendors(first: 250) {
            nodes
        }
    }
    """
    data = execute_graphql(store_id, query)
    return data.get("productVendors", {}).get("nodes", [])


def get_tags(store_id):
    query = """
    {
        productTags(first: 250) {
            nodes
        }
    }
    """
    data = execute_graphql(store_id, query)
    return data.get("productTags", {}).get("nodes", [])


_BARCODE_LOOKUP_QUERY = """
{
  products(first: 5, query: "barcode:%s") {
    nodes {
      id
      title
      descriptionHtml
      handle
      vendor
      productType
      status
      tags
      templateSuffix
      seo { title description }
      metafields(first: 50) {
        nodes { namespace key type value }
      }
      variants(first: 100) {
        nodes {
          id title sku barcode
          price compareAtPrice
          inventoryItem {
            cost { amount }
            tracked
          }
          taxable
          inventoryPolicy
          selectedOptions { name value }
          weight
          weightUnit
        }
      }
    }
  }
}
"""


def lookup_product_by_barcode(barcode):
    stores = get_all_shopify_stores(active_only=True)
    if not stores:
        return {"found": False, "error": "No active Shopify stores"}

    query = _BARCODE_LOOKUP_QUERY % barcode
    found_in_stores = []
    product_data = None

    for store in stores:
        try:
            data = execute_graphql(store["id"], query)
            products = data.get("products", {}).get("nodes", [])

            for product in products:
                variants = product.get("variants", {}).get("nodes", [])
                matched_variant = None
                for v in variants:
                    if v.get("barcode") == barcode:
                        matched_variant = v
                        break

                if not matched_variant:
                    continue

                found_in_stores.append(store["name"])

                if product_data is None:
                    product_data = _normalize_lookup_result(product, matched_variant)
                break

        except Exception:
            continue

    if not product_data:
        return {"found": False}

    return {
        "found": True,
        "product": product_data,
        "found_in_stores": found_in_stores,
        "source_store": found_in_stores[0] if found_in_stores else None,
    }


def _normalize_lookup_result(product, variant):
    result = {
        "title": product.get("title", ""),
        "descriptionHtml": product.get("descriptionHtml", ""),
        "vendor": product.get("vendor", ""),
        "productType": product.get("productType", ""),
        "status": product.get("status", "DRAFT"),
        "tags": product.get("tags", []),
        "handle": product.get("handle", ""),
        "templateSuffix": product.get("templateSuffix", ""),
    }

    seo = product.get("seo")
    if seo:
        result["seo"] = {
            "title": seo.get("title", ""),
            "description": seo.get("description", ""),
        }

    metafields_nodes = product.get("metafields", {}).get("nodes", [])
    if metafields_nodes:
        result["metafields"] = [
            {
                "namespace": mf.get("namespace", "custom"),
                "key": mf.get("key", ""),
                "type": mf.get("type", "single_line_text_field"),
                "value": mf.get("value", ""),
            }
            for mf in metafields_nodes
            if mf.get("key")
        ]

    if variant:
        result["price"] = variant.get("price", "")
        result["compareAtPrice"] = variant.get("compareAtPrice", "")
        cost_data = variant.get("inventoryItem", {}).get("cost")
        result["cost"] = cost_data.get("amount", "") if cost_data else ""
        result["taxable"] = variant.get("taxable", True)
        result["weight"] = variant.get("weight")
        result["weightUnit"] = (variant.get("weightUnit") or "POUNDS").lower()
        weight_map = {"pounds": "lb", "kilograms": "kg", "ounces": "oz", "grams": "g"}
        result["weightUnit"] = weight_map.get(result["weightUnit"], result["weightUnit"])

    return result


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


def push_to_stores(store_ids, product_data, per_store_image_urls=None):
    results = {
        "stores_succeeded": [],
        "stores_failed": [],
        "error_details": {},
        "product_ids": {},
    }

    per_store_urls = per_store_image_urls or {}

    for sid in store_ids:
        store = get_shopify_store(sid)
        store_name = store["name"] if store else f"Store {sid}"
        try:
            store_image_urls = per_store_urls.get(sid, [])
            product_input = _build_product_set_input(product_data, store_image_urls)
            product = create_product(sid, product_input)

            if not product:
                raise RuntimeError("No product returned")

            product_id = product["id"]
            results["product_ids"][store_name] = product_id
            results["stores_succeeded"].append(store_name)

            inventory = product_data.get("inventory", {})
            per_store_inv = inventory.get("per_store", {})
            store_inv = per_store_inv.get(str(sid), {})
            if not store_inv:
                store_inv = inventory.get("location_quantities", {})

            if store_inv:
                variants = product.get("variants", {}).get("edges", [])
                for variant_edge in variants:
                    inv_item_id = variant_edge["node"]["inventoryItem"]["id"]
                    set_inventory_quantities(sid, inv_item_id, store_inv)

            per_store_pubs = product_data.get("per_store_publications", {})
            pub_ids = per_store_pubs.get(str(sid), product_data.get("publication_ids", []))
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

    for key in [
        "descriptionHtml", "handle", "vendor", "productType",
        "status", "templateSuffix", "category",
    ]:
        if product.get(key):
            inp[key] = product[key]

    if product.get("tags"):
        inp["tags"] = product["tags"]

    if product.get("seo"):
        inp["seo"] = product["seo"]

    if product.get("metafields"):
        inp["metafields"] = product["metafields"]

    if product.get("productOptions"):
        inp["productOptions"] = product["productOptions"]

    if product.get("variants"):
        inp["variants"] = product["variants"]

    if product.get("collectionsToJoin"):
        inp["collections"] = product["collectionsToJoin"]

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
