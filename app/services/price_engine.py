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
    """Apply price formulas for a store.

    The user enters a BASE cost in UnitCost. Formulas can:
    - Adjust UnitCost per store (e.g., UnitCost = UnitCost × 1.05)
    - Calculate prices from UnitCost (e.g., UnitPrice = UnitCost × 1.20)
    - Chain: first adjust cost, then prices use the adjusted cost

    Formulas targeting UnitCost ALWAYS override the base cost (that's
    their purpose - per-store cost adjustment). Other targets only fill
    in if not already set by the user.
    """
    formulas = get_formulas_for_store(store_id)
    # Start with a copy of fields so we can chain (adjusted cost -> prices)
    computed = dict(fields)
    results = {}

    for formula in formulas:
        target = formula["target_field"]
        source = formula.get("source_field", "UnitCost")

        # UnitCost formulas always apply (per-store cost adjustment).
        # Other targets: skip if already provided by the user.
        if target != "UnitCost":
            existing = computed.get(target)
            if existing not in (None, "", "0", "0.00"):
                continue

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
        # Update computed so subsequent formulas can chain off this result
        computed[target] = calculated

    return results
