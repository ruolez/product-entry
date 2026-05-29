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


def check_duplicate_sku_barcode(store_id, sku=None, barcode=None):
    results = {}
    if sku:
        query = '{products(first:1,query:"sku:%s status:active"){nodes{id title variants(first:100){nodes{sku}}}}}' % sku.replace('"', '\\"')
        data = execute_graphql(store_id, query)
        products = data.get("products", {}).get("nodes", [])
        for p in products:
            for v in p.get("variants", {}).get("nodes", []):
                if v.get("sku") == sku:
                    results["sku"] = {"product_title": p.get("title", ""), "product_id": p.get("id", "")}
                    break
            if "sku" in results:
                break
    if barcode:
        query = '{products(first:1,query:"barcode:%s status:active"){nodes{id title variants(first:100){nodes{barcode}}}}}' % barcode.replace('"', '\\"')
        data = execute_graphql(store_id, query)
        products = data.get("products", {}).get("nodes", [])
        for p in products:
            for v in p.get("variants", {}).get("nodes", []):
                if v.get("barcode") == barcode:
                    results["barcode"] = {"product_title": p.get("title", ""), "product_id": p.get("id", "")}
                    break
            if "barcode" in results:
                break
    return results


_BARCODE_LOOKUP_QUERY = """
{
  products(first: 5, query: "barcode:%s status:active") {
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
      metafields(first: 250) {
        nodes {
          namespace key type value
          definition { pinnedPosition }
        }
      }
      collections(first: 50) {
        nodes { id title }
      }
      variants(first: 100) {
        nodes {
          id title sku barcode
          price compareAtPrice
          inventoryItem {
            unitCost { amount }
            tracked
            measurement { weight { unit value } }
          }
          taxable
          inventoryPolicy
          selectedOptions { name value }
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
    per_store_products = {}
    first_product = None
    lookup_errors = {}

    for store in stores:
        try:
            data = execute_graphql(store["id"], query)
            products = data.get("products", {}).get("nodes", [])

            # Collect every product in this store whose variants include the
            # barcode. >1 is a Shopify-side data-quality issue (duplicate
            # barcodes) we need to surface — we still load the first match so
            # the form is usable, but the user gets a warning.
            matches = []
            for product in products:
                variants = product.get("variants", {}).get("nodes", [])
                matched_variant = None
                for v in variants:
                    if v.get("barcode") == barcode:
                        matched_variant = v
                        break
                if matched_variant:
                    matches.append((product, matched_variant, variants))

            if not matches:
                continue

            first_match_product, first_match_variant, first_match_variants = matches[0]
            normalized = _normalize_lookup_result(
                first_match_product, first_match_variant, first_match_variants
            )

            if len(matches) > 1:
                normalized["barcodeCollision"] = True
                normalized["collisionCandidates"] = [
                    {
                        "id": p.get("id"),
                        "title": p.get("title", ""),
                        "handle": p.get("handle", ""),
                        "vendor": p.get("vendor", ""),
                    }
                    for p, _v, _vs in matches
                ]

            found_in_stores.append(store["name"])
            per_store_products[str(store["id"])] = normalized
            if first_product is None:
                first_product = normalized

        except Exception as e:
            lookup_errors[store["name"]] = str(e)
            continue

    if not first_product:
        return {"found": False, "lookup_errors": lookup_errors}

    # If any store has the product configured with variants, promote variant
    # info onto a copy so the per-store entry stays untouched.
    if not first_product.get("isVariantProduct"):
        for product_data in per_store_products.values():
            if product_data.get("isVariantProduct"):
                first_product = dict(first_product)
                first_product["isVariantProduct"] = True
                first_product["productOptions"] = product_data.get("productOptions", [])
                first_product["existingVariants"] = product_data.get("existingVariants", [])
                first_product["shopifyProductId"] = product_data.get("shopifyProductId", "")
                break

    return {
        "found": True,
        "product": first_product,
        "per_store_products": per_store_products,
        "found_in_stores": found_in_stores,
        "source_store": found_in_stores[0] if found_in_stores else None,
        "lookup_errors": lookup_errors,
    }


def _is_variant_product(variants):
    if len(variants) > 1:
        return True
    if len(variants) == 1:
        for opt in variants[0].get("selectedOptions", []):
            if opt.get("value") != "Default Title":
                return True
    return False


def _extract_product_options(variants):
    options = {}
    for v in variants:
        for opt in v.get("selectedOptions", []):
            name = opt.get("name", "")
            value = opt.get("value", "")
            if not name:
                continue
            if name not in options:
                options[name] = []
            if value not in options[name]:
                options[name].append(value)
    return [{"name": name, "values": vals} for name, vals in options.items()]


def _normalize_lookup_result(product, variant, all_variants=None):
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

    # Carry the matched Shopify product identity through so the frontend can
    # show the user exactly which product was loaded into each store's tab.
    result["matchedProductId"] = product.get("id", "")
    result["matchedTitle"] = product.get("title", "")
    result["matchedHandle"] = product.get("handle", "")
    result["matchedVendor"] = product.get("vendor", "")

    # SEO: Product.seo.{title,description} is the canonical Shopify field, but
    # it's not guaranteed to mirror the underlying global.title_tag /
    # global.description_tag metafields — third-party SEO apps frequently write
    # to the metafield only. Fall back to the metafield when seo.* is empty.
    raw_metafields = product.get("metafields", {}).get("nodes", []) or []
    global_tags = {}
    for mf in raw_metafields:
        if mf.get("namespace") == "global" and mf.get("key") in ("title_tag", "description_tag"):
            global_tags[mf["key"]] = mf.get("value") or ""

    seo = product.get("seo") or {}
    seo_title = seo.get("title") or global_tags.get("title_tag", "")
    seo_description = seo.get("description") or global_tags.get("description_tag", "")
    if seo_title or seo_description:
        result["seo"] = {"title": seo_title, "description": seo_description}

    # Keep only pinned metafields (those backed by a pinned definition in this
    # store). Unstructured metafields have no definition; unpinned definitions
    # have a null pinnedPosition. Each store's query runs against that store, so
    # this yields that store's own pinned set, ordered as in the Shopify admin.
    pinned_metafields = []
    for mf in raw_metafields:
        if not mf.get("key"):
            continue
        definition = mf.get("definition")
        pinned_position = definition.get("pinnedPosition") if definition else None
        if pinned_position is None:
            continue
        pinned_metafields.append((pinned_position, {
            "namespace": mf.get("namespace", "custom"),
            "key": mf.get("key", ""),
            "type": mf.get("type", "single_line_text_field"),
            "value": mf.get("value", ""),
        }))
    if pinned_metafields:
        pinned_metafields.sort(key=lambda item: item[0])
        result["metafields"] = [mf for _, mf in pinned_metafields]

    collections_nodes = product.get("collections", {}).get("nodes", [])
    if collections_nodes:
        result["collections"] = [
            {"id": c.get("id"), "title": c.get("title", "")}
            for c in collections_nodes
            if c.get("id")
        ]

    if variant:
        result["price"] = variant.get("price", "")
        result["compareAtPrice"] = variant.get("compareAtPrice", "")
        inv_item = variant.get("inventoryItem", {})
        unit_cost = inv_item.get("unitCost")
        result["cost"] = unit_cost.get("amount", "") if unit_cost else ""
        result["taxable"] = variant.get("taxable", True)
        measurement = inv_item.get("measurement", {})
        weight_data = measurement.get("weight")
        if weight_data:
            result["weight"] = weight_data.get("value")
            raw_unit = (weight_data.get("unit") or "POUNDS").lower()
            weight_map = {"pounds": "lb", "kilograms": "kg", "ounces": "oz", "grams": "g"}
            result["weightUnit"] = weight_map.get(raw_unit, raw_unit)

    if all_variants and _is_variant_product(all_variants):
        result["isVariantProduct"] = True
        result["shopifyProductId"] = product.get("id", "")
        result["productOptions"] = _extract_product_options(all_variants)
        result["existingVariants"] = []
        for v in all_variants:
            inv_item = v.get("inventoryItem", {})
            unit_cost = inv_item.get("unitCost")
            result["existingVariants"].append({
                "id": v.get("id", ""),
                "title": v.get("title", ""),
                "sku": v.get("sku", ""),
                "barcode": v.get("barcode", ""),
                "price": v.get("price", ""),
                "compareAtPrice": v.get("compareAtPrice", ""),
                "cost": unit_cost.get("amount", "") if unit_cost else "",
                "selectedOptions": v.get("selectedOptions", []),
            })

    return result


_SEARCH_QUERY = """
{
  products(first: %d, query: "%s") {
    nodes {
      id
      title
      vendor
      productType
      status
      featuredMedia {
        ... on MediaImage {
          image { url }
        }
      }
      variants(first: 5) {
        nodes {
          barcode
          sku
          price
        }
      }
    }
  }
}
"""


def search_products(query, limit=50):
    stores = get_all_shopify_stores(active_only=True)
    if not stores:
        return []

    has_wildcard = "%" in query
    safe_query = query.replace('"', '\\"').replace("\\", "\\\\")

    if has_wildcard:
        # SQL-like: % becomes * for Shopify search
        shopify_query = "title:" + safe_query.replace("%", "*") + " status:active"
    else:
        # Default: starts-with match
        shopify_query = "title:" + safe_query + "* status:active"

    per_store_limit = min(limit, 50)
    gql = _SEARCH_QUERY % (per_store_limit, shopify_query)

    # Build a pattern for client-side filtering
    if has_wildcard:
        import re
        pattern_str = re.escape(query.replace("%", "\x00")).replace(re.escape("\x00"), ".*")
        title_pattern = re.compile("^" + pattern_str, re.IGNORECASE)
    else:
        title_pattern = None

    results = []
    seen_titles = set()

    for store in stores:
        try:
            data = execute_graphql(store["id"], gql)
            products = data.get("products", {}).get("nodes", [])
            for p in products:
                title = p.get("title", "")

                # Filter: starts-with (no wildcard) or pattern match (wildcard)
                if title_pattern:
                    if not title_pattern.match(title):
                        continue
                else:
                    if not title.lower().startswith(query.lower()):
                        continue

                dedup_key = f"{title}|{p.get('vendor', '')}"
                if dedup_key in seen_titles:
                    continue
                seen_titles.add(dedup_key)

                variants = p.get("variants", {}).get("nodes", [])
                first_variant = variants[0] if variants else {}
                barcodes = [v.get("barcode") for v in variants if v.get("barcode")]

                results.append({
                    "product_id": p["id"],
                    "store_id": store["id"],
                    "store_name": store["name"],
                    "title": title,
                    "vendor": p.get("vendor", ""),
                    "productType": p.get("productType", ""),
                    "status": p.get("status", ""),
                    "price": first_variant.get("price", ""),
                    "sku": first_variant.get("sku", ""),
                    "barcode": barcodes[0] if barcodes else "",
                })
        except Exception:
            continue

    results.sort(key=lambda r: r["title"].lower())
    return results[:limit]


_PRODUCT_DETAIL_QUERY = """
query getProduct($id: ID!) {
  product(id: $id) {
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
    metafields(first: 250) {
      nodes {
        namespace key type value
        definition { pinnedPosition }
      }
    }
    collections(first: 50) {
      nodes { id title }
    }
    variants(first: 100) {
      nodes {
        id title sku barcode
        price compareAtPrice
        inventoryItem {
          unitCost { amount }
          tracked
          measurement { weight { unit value } }
        }
        taxable
        inventoryPolicy
        selectedOptions { name value }
      }
    }
  }
}
"""


def get_product_detail(store_id, product_id):
    data = execute_graphql(store_id, _PRODUCT_DETAIL_QUERY, {"id": product_id})
    product = data.get("product")
    if not product:
        return None

    variants = product.get("variants", {}).get("nodes", [])
    first_variant = variants[0] if variants else {}

    return _normalize_lookup_result(product, first_variant, variants)


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


def push_to_stores_per_store(store_ids, per_store_product_data, per_store_image_urls=None):
    results = {
        "stores_succeeded": [],
        "stores_failed": [],
        "error_details": {},
        "product_ids": {},
    }

    per_store_urls = per_store_image_urls or {}
    first_product_data = None

    for sid in store_ids:
        store = get_shopify_store(sid)
        store_name = store["name"] if store else f"Store {sid}"
        product_data = per_store_product_data.get(str(sid), {})
        if first_product_data is None:
            first_product_data = product_data

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
            store_inv = inventory.get("location_quantities", {})

            if store_inv:
                variants = product.get("variants", {}).get("edges", [])
                for variant_edge in variants:
                    inv_item_id = variant_edge["node"]["inventoryItem"]["id"]
                    set_inventory_quantities(sid, inv_item_id, store_inv)

            pub_ids = product_data.get("publication_ids", [])
            if pub_ids:
                publish_product(sid, product_id, pub_ids)

        except Exception as e:
            results["stores_failed"].append(store_name)
            results["error_details"][store_name] = str(e)

    _log_insertion(first_product_data or {}, results)
    return results


def _build_product_set_input(product_data, image_resource_urls=None):
    product = product_data.get("product", {})
    inp = {"title": product.get("title", "")}

    if product.get("id"):
        inp["id"] = product["id"]

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
