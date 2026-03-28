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

    The user enters a BASE cost in UnitCost. Formulas execute in order:
    1. UnitCost = UnitCost × 1.05  (per-store cost adjustment)
    2. UnitPrice = UnitCost × 1.20 (now uses adjusted 105, not base 100)
    3. UnitPriceC = UnitCost × 1.05 (also uses adjusted cost)

    ALL configured formulas are applied unconditionally. The client-side
    only shows preview values from the base cost; the server recalculates
    everything with per-store adjustments and chaining.
    """
    formulas = get_formulas_for_store(store_id)
    if not formulas:
        return {}

    computed = dict(fields)
    results = {}

    for formula in formulas:
        target = formula["target_field"]
        source = formula.get("source_field", "UnitCost")

        source_val = computed.get(source)
        if source_val is None:
            continue
        try:
            source_dec = Decimal(str(source_val))
        except Exception:
            continue

        if source_dec <= 0 and formula["operator"] != "fixed":
            continue

        operand = Decimal(str(formula["operand"]))
        if formula["operator"] == "multiply":
            value = source_dec * operand
        elif formula["operator"] == "add":
            value = source_dec + operand
        elif formula["operator"] == "fixed":
            value = operand
        else:
            continue

        calculated = str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        results[target] = calculated
        computed[target] = calculated

    return results
