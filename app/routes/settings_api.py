from flask import Blueprint, jsonify, request

from models.settings import db
from services.store_connection import (
    encrypt_password,
    decrypt_password,
    get_all_stores,
    get_store,
    test_connection,
)

settings_bp = Blueprint("settings", __name__)


# --- Store CRUD ---

@settings_bp.route("/stores")
def list_stores():
    stores = get_all_stores(active_only=False)
    for s in stores:
        s.pop("password_enc", None)
        if s.get("created_at"):
            s["created_at"] = s["created_at"].isoformat()
        if s.get("updated_at"):
            s["updated_at"] = s["updated_at"].isoformat()
    return jsonify(stores)


@settings_bp.route("/stores", methods=["POST"])
def create_store():
    data = request.get_json()
    required = ["name", "host", "database_name", "username", "password"]
    for field in required:
        if not data.get(field):
            return jsonify({"error": f"{field} is required"}), 400

    password_enc = encrypt_password(data["password"])
    if data.get("is_primary"):
        db.session.execute(
            db.text("UPDATE stores SET is_primary = FALSE, updated_at = NOW() WHERE is_primary = TRUE")
        )
    result = db.session.execute(
        db.text(
            "INSERT INTO stores (name, host, port, database_name, username, password_enc, is_active, is_primary, sort_order) "
            "VALUES (:name, :host, :port, :db, :user, :pass, :active, :primary, :sort) "
            "RETURNING id"
        ),
        {
            "name": data["name"],
            "host": data["host"],
            "port": data.get("port", 1433),
            "db": data["database_name"],
            "user": data["username"],
            "pass": password_enc,
            "active": data.get("is_active", True),
            "primary": data.get("is_primary", False),
            "sort": data.get("sort_order", 0),
        },
    )
    db.session.commit()
    new_id = result.scalar()
    return jsonify({"id": new_id, "message": "Store created"}), 201


@settings_bp.route("/stores/<int:store_id>", methods=["PUT"])
def update_store(store_id):
    data = request.get_json()
    store = get_store(store_id)
    if not store:
        return jsonify({"error": "Store not found"}), 404

    updates = []
    params = {"id": store_id}

    for field in ["name", "host", "port", "database_name", "username", "is_active", "is_primary", "sort_order"]:
        if field in data:
            updates.append(f"{field} = :{field}")
            params[field] = data[field]

    if "password" in data and data["password"]:
        updates.append("password_enc = :password_enc")
        params["password_enc"] = encrypt_password(data["password"])

    if data.get("is_primary"):
        db.session.execute(
            db.text("UPDATE stores SET is_primary = FALSE, updated_at = NOW() WHERE is_primary = TRUE AND id != :id"),
            {"id": store_id},
        )

    if not updates:
        return jsonify({"error": "No fields to update"}), 400

    updates.append("updated_at = NOW()")
    sql = f"UPDATE stores SET {', '.join(updates)} WHERE id = :id"
    db.session.execute(db.text(sql), params)
    db.session.commit()
    return jsonify({"message": "Store updated"})


@settings_bp.route("/stores/<int:store_id>", methods=["DELETE"])
def delete_store(store_id):
    db.session.execute(
        db.text("UPDATE stores SET is_active = FALSE, updated_at = NOW() WHERE id = :id"),
        {"id": store_id},
    )
    db.session.commit()
    return jsonify({"message": "Store deactivated"})


@settings_bp.route("/stores/<int:store_id>/test", methods=["POST"])
def test_store_connection(store_id):
    try:
        success, message = test_connection(store_id)
        return jsonify({"success": success, "message": message}), 200
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 200


# --- Price Formulas ---

@settings_bp.route("/price-formulas")
def list_price_formulas():
    result = db.session.execute(
        db.text(
            "SELECT pf.*, s.name as store_name "
            "FROM price_formulas pf "
            "JOIN stores s ON pf.store_id = s.id "
            "ORDER BY s.sort_order, pf.sort_order"
        )
    )
    rows = [dict(r) for r in result.mappings().all()]
    return jsonify(rows)


@settings_bp.route("/price-formulas", methods=["PUT"])
def update_price_formulas():
    data = request.get_json()
    formulas = data.get("formulas", [])

    db.session.execute(db.text("DELETE FROM price_formulas"))
    for i, f in enumerate(formulas):
        db.session.execute(
            db.text(
                "INSERT INTO price_formulas (store_id, target_field, source_field, operator, operand, sort_order, is_active) "
                "VALUES (:store_id, :target, :source, :op, :operand, :sort, :active)"
            ),
            {
                "store_id": f["store_id"],
                "target": f["target_field"],
                "source": f.get("source_field", "UnitCost"),
                "op": f.get("operator", "multiply"),
                "operand": f["operand"],
                "sort": i,
                "active": f.get("is_active", True),
            },
        )
    db.session.commit()
    return jsonify({"message": "Price formulas updated"})


# --- Field Configs ---

@settings_bp.route("/field-configs")
def list_field_configs():
    result = db.session.execute(
        db.text("SELECT * FROM field_configs ORDER BY section, sort_order")
    )
    rows = [dict(r) for r in result.mappings().all()]
    return jsonify(rows)


@settings_bp.route("/field-configs", methods=["PUT"])
def update_field_configs():
    data = request.get_json()
    configs = data.get("configs", [])

    for cfg in configs:
        db.session.execute(
            db.text(
                "UPDATE field_configs SET "
                "display_name = :display_name, "
                "is_visible = :is_visible, "
                "is_required = :is_required, "
                "default_value = :default_value, "
                "sort_order = :sort_order "
                "WHERE field_name = :field_name"
            ),
            {
                "field_name": cfg["field_name"],
                "display_name": cfg.get("display_name", cfg["field_name"]),
                "is_visible": cfg.get("is_visible", True),
                "is_required": cfg.get("is_required", False),
                "default_value": cfg.get("default_value"),
                "sort_order": cfg.get("sort_order", 0),
            },
        )
    db.session.commit()
    return jsonify({"message": "Field configs updated"})
