from decimal import Decimal, ROUND_HALF_UP
from models.settings import db


def get_formulas_for_store(store_id):
    result = db.session.execute(
        db.text(
            "SELECT target_field, source_field, operator, operand "
            "FROM price_formulas "
            "WHERE store_id = :store_id AND is_active = TRUE "
            "ORDER BY sort_order"
        ),
        {"store_id": store_id},
    )
    return [dict(r) for r in result.mappings().all()]


def get_formulas_for_stores(store_ids):
    if not store_ids:
        return {}
    placeholders = ", ".join(f":s{i}" for i in range(len(store_ids)))
    params = {f"s{i}": sid for i, sid in enumerate(store_ids)}
    result = db.session.execute(
        db.text(
            f"SELECT store_id, target_field, source_field, operator, operand "
            f"FROM price_formulas "
            f"WHERE store_id IN ({placeholders}) AND is_active = TRUE "
            f"ORDER BY store_id, sort_order"
        ),
        params,
    )
    rows = [dict(r) for r in result.mappings().all()]
    grouped = {}
    for row in rows:
        sid = row["store_id"]
        if sid not in grouped:
            grouped[sid] = []
        grouped[sid].append(row)
    return grouped


def calculate_prices(fields, store_id):
    """Apply ALL price formulas for a store. Server-side is authoritative.

    Every formula calculates from the user-entered BASE COST (UnitCost
    in the original fields). No chaining - each formula independently
    uses the same base cost as its source.

    Example with base cost 100:
      UnitCost  = 100 × 1.05 = 105  (store's local cost)
      UnitPrice = 100 × 1.20 = 120  (NOT 105 × 1.20)
      UnitPriceC = 100 × 1.05 = 105 (NOT from adjusted cost)
    """
    formulas = get_formulas_for_store(store_id)
    if not formulas:
        return {}

    # The base cost is always the user-entered value, never adjusted
    base_cost_val = fields.get("UnitCost")
    if base_cost_val is None:
        return {}
    try:
        base_cost = Decimal(str(base_cost_val))
    except Exception:
        return {}

    if base_cost <= 0:
        return {}

    results = {}
    for formula in formulas:
        target = formula["target_field"]
        operand = Decimal(str(formula["operand"]))

        if formula["operator"] == "multiply":
            value = base_cost * operand
        elif formula["operator"] == "add":
            value = base_cost + operand
        elif formula["operator"] == "fixed":
            value = operand
        else:
            continue

        results[target] = str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

    return results
