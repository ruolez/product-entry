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


def calculate_prices(unit_cost, store_id):
    if not unit_cost or float(unit_cost) <= 0:
        return {}

    cost = Decimal(str(unit_cost))
    formulas = get_formulas_for_store(store_id)
    results = {}

    for formula in formulas:
        operand = Decimal(str(formula["operand"]))
        if formula["operator"] == "multiply":
            value = cost * operand
        elif formula["operator"] == "add":
            value = cost + operand
        elif formula["operator"] == "fixed":
            value = operand
        else:
            continue

        results[formula["target_field"]] = str(
            value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        )

    return results
