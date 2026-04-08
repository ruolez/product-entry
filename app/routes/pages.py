from flask import Blueprint, render_template

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/")
def index():
    return render_template("index.html")


@pages_bp.route("/history")
def history():
    return render_template("history.html")


@pages_bp.route("/settings")
def settings():
    return render_template("settings.html")
