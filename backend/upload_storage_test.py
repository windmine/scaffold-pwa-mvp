from pathlib import Path
from tempfile import TemporaryDirectory

from app import upload_storage
from app.use_cases.common import upload_url


def assert_equal(label, actual, expected):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
    print(f"ok - {label}")


def assert_raises_value_error(label, callback):
    try:
        callback()
    except ValueError:
        print(f"ok - {label}")
        return
    raise AssertionError(f"{label}: expected ValueError")


def main():
    original_backend = upload_storage.UPLOAD_STORAGE_BACKEND
    original_bucket = upload_storage.UPLOAD_BUCKET
    original_prefix = upload_storage.UPLOAD_OBJECT_PREFIX
    original_dir = upload_storage.UPLOAD_DIR

    try:
        with TemporaryDirectory() as tmp_dir:
            upload_storage.UPLOAD_STORAGE_BACKEND = "local"
            upload_storage.UPLOAD_BUCKET = ""
            upload_storage.UPLOAD_OBJECT_PREFIX = "uploads"
            upload_storage.UPLOAD_DIR = Path(tmp_dir)

            upload_storage.ensure_upload_storage_ready()
            upload_storage.save_upload("sample.png", b"image-bytes", "image/png")
            stored = upload_storage.load_upload("sample.png")

            assert_equal("local upload content", stored.content, b"image-bytes")
            assert_equal("local upload content type", stored.content_type, "image/png")
            assert_equal("upload url format", upload_url("sample.png"), "/uploads/sample.png")

            assert_raises_value_error(
                "reject nested upload filename",
                lambda: upload_storage.load_upload("../sample.png"),
            )
            assert_raises_value_error(
                "reject slash upload filename",
                lambda: upload_storage.save_upload("nested/sample.png", b"", "image/png"),
            )
    finally:
        upload_storage.UPLOAD_STORAGE_BACKEND = original_backend
        upload_storage.UPLOAD_BUCKET = original_bucket
        upload_storage.UPLOAD_OBJECT_PREFIX = original_prefix
        upload_storage.UPLOAD_DIR = original_dir


if __name__ == "__main__":
    main()
