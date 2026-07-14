import os
import sys
from pathlib import Path

from sqlalchemy import text


os.environ["DATABASE_URL"] = "sqlite://"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.database import engine  # noqa: E402


def test_stale_pooled_connection_is_recycled():
    with engine.connect() as connection:
        stale_connection = connection.connection.driver_connection

    stale_connection.close()

    with engine.connect() as connection:
        result = connection.execute(text("SELECT 1")).scalar_one()

    if result != 1:
        raise AssertionError("database engine did not replace the stale pooled connection")
    print("ok - stale pooled connection is recycled before the route query")


if __name__ == "__main__":
    test_stale_pooled_connection_is_recycled()
    print("database test passed")
