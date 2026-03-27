import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", "postgresql://itementry:itementry_dev_pass@postgres:5432/itementry")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    FERNET_KEY = os.environ.get("FERNET_KEY", "")
    FLASK_ENV = os.environ.get("FLASK_ENV", "development")
