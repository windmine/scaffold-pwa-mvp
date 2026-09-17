"""Local-only PDF regressions for 50 camera-resolution photos in one Report.

Run ``python backend/report_pdf_volume_test.py``. Add ``--output PATH`` to keep
the synthetic PDF for Poppler visual inspection. No real evidence or API is read.
"""

import argparse
import hashlib
import json
import random
import re
import time
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw
from pypdf import PdfReader

from app.use_cases.report_pdf import EVIDENCE_DPI, VALUE_WIDTH, _printable_raster, build_report_pdf
from report_pdf_layout_test import assert_page_numbers, page_texts, report_fixture, synthetic_image


def image_bytes(image, **save_options):
    buffer = BytesIO()
    image.save(buffer, **save_options)
    return buffer.getvalue()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def test_small_rasters_are_unchanged():
    png = synthetic_image(181, 61, "navy")
    jpeg = image_bytes(Image.new("RGB", (220, 130), "orange"), format="JPEG")
    for original in (png, jpeg):
        prepared, width, height = _printable_raster(original, VALUE_WIDTH - 16, 94)
        assert prepared is original, "Small evidence must not be unnecessarily re-encoded"
        with Image.open(BytesIO(original)) as source:
            assert (width, height) == source.size
    print("ok - small photo/signature source bytes and dimensions are unchanged")


def test_orientation_alpha_and_signature_quality():
    # Orientation 6 rotates a stored landscape image to a portrait display.
    picture = Image.new("RGB", (1600, 900), "navy")
    ImageDraw.Draw(picture).rectangle((0, 0, 799, 899), fill="orange")
    exif = Image.Exif()
    exif[274] = 6
    original = image_bytes(picture, format="JPEG", exif=exif, quality=95)
    original_hash = digest(original)
    prepared, width, height = _printable_raster(original, VALUE_WIDTH - 16, 215)
    assert (width, height) == (900, 1600), (width, height)
    with Image.open(BytesIO(prepared)) as rotated:
        assert rotated.height > rotated.width
        assert rotated.getexif().get(274, 1) == 1
        assert rotated.getpixel((rotated.width // 2, 20))[0] > 200
        assert rotated.getpixel((rotated.width // 2, rotated.height - 20))[2] > 90
    assert digest(original) == original_hash

    signature = Image.new("RGBA", (2400, 680), (0, 0, 0, 0))
    draw = ImageDraw.Draw(signature)
    draw.line([(40, 400), (180, 130), (200, 570), (590, 250), (900, 450), (1700, 160)],
              fill=(20, 30, 40, 255), width=12)
    draw.text((45, 35), "SYNTHETIC SIGNATURE", fill=(20, 30, 40, 255), font_size=60)
    original = image_bytes(signature, format="PNG")
    original_hash = digest(original)
    prepared, width, height = _printable_raster(original, VALUE_WIDTH - 16, 94, lossless=True)
    with Image.open(BytesIO(prepared)) as resized:
        assert resized.format == "PNG" and resized.mode == "RGBA"
        assert resized.width <= int((VALUE_WIDTH - 16) * EVIDENCE_DPI / 72)
        assert resized.height <= int(94 * EVIDENCE_DPI / 72)
        alpha = resized.getchannel("A")
        assert alpha.getextrema() == (0, 255), "Transparency or opaque ink disappeared"
        histogram = alpha.histogram()
        assert sum(histogram[200:]) > 1000, "Visible signature strokes disappeared"
        assert abs(resized.width / resized.height - width / height) < 0.02
    assert digest(original) == original_hash

    # Opaque signatures are also lossless; large opaque photos use compact JPEG.
    opaque = image_bytes(signature.convert("RGB"), format="PNG")
    for lossless, expected_format in ((True, "PNG"), (False, "JPEG")):
        prepared, _, _ = _printable_raster(opaque, VALUE_WIDTH - 16, 94, lossless=lossless)
        with Image.open(BytesIO(prepared)) as result:
            assert result.format == expected_format
    print("ok - camera orientation, alpha and lossless signature strokes survive export-only resizing")


def volume_fixture(directory):
    """Distinct 6 MP JPEG files, below the unchanged 5 MB upload limit each."""
    # Deterministic full-resolution sensor-like texture avoids an unrealistically
    # tiny flat-color stress fixture, without using a real person's/site's photo.
    noise = Image.frombytes("L", (3000, 2000), random.Random(50).randbytes(6_000_000))
    noise = noise.point(lambda value: 185 + value // 5)
    base = Image.merge("RGB", (noise, noise.point(lambda value: value - 15), noise))
    paths = {}
    for index in range(1, 51):
        picture = base.copy()
        draw = ImageDraw.Draw(picture)
        draw.rectangle((80, 80, 2920, 450), fill=(30, 65 + index * 2, 100))
        draw.text((120, 120), f"SYNTHETIC PHOTO {index:02d} OF 50", fill="white", font_size=100)
        draw.text((120, 300), "Camera-resolution volume test - not real site evidence", fill="white", font_size=55)
        for block in range(4):
            x = 200 + block * 700
            draw.rectangle((x, 650, x + 450, 1550), fill=(100 + index, 80 + block * 25, 40 + index * 3))
            draw.text((x + 60, 1000), f"{index:02d}", fill="white", font_size=160)
        if index % 10 == 0:
            picture = picture.transpose(Image.Transpose.ROTATE_90)
        name = f"volume-photo-{index:02d}.jpg"
        path = directory / name
        picture.save(path, format="JPEG", quality=94)
        picture.close()
        assert 250_000 < path.stat().st_size <= 5 * 1024 * 1024, path.stat().st_size
        paths[f"/uploads/{name}"] = path
    base.close()
    noise.close()
    signature_path = directory / "volume-signature.png"
    signature = Image.new("RGBA", (2400, 680), (0, 0, 0, 0))
    draw = ImageDraw.Draw(signature)
    draw.line([(70, 400), (190, 130), (210, 550), (600, 250), (900, 420), (1750, 160)],
              fill="navy", width=12)
    draw.text((100, 30), "SYNTHETIC SIGNATURE", fill="navy", font_size=65)
    signature.save(signature_path, format="PNG")
    signature.close()
    paths["/uploads/volume-signature.png"] = signature_path
    item = report_fixture(
        form_name="50-photo Report volume check",
        fields=[
            {"id": "discussion", "type": "textarea", "label": "Summary"},
            {"id": "signature", "type": "signature", "label": "Worker signature"},
            {"id": "name", "type": "text", "label": "Signed by"},
        ],
        answers={"discussion": "All fifty synthetic photos must remain in their saved order.",
                 "signature": "/uploads/volume-signature.png", "name": "SYNTHETIC SIGNER"},
        photo_urls=[f"/uploads/volume-photo-{index:02d}.jpg" for index in range(1, 51)],
        photo_metadata=[{"name": f"VOLUME-CAPTION-{index:02d}.jpg", "taken_at": f"2026-09-16T00:{index:02d}:00Z"}
                        for index in range(1, 51)],
    )
    return item, paths


def test_fifty_camera_resolution_photos(output=None):
    with TemporaryDirectory(prefix="report-pdf-volume-") as temporary:
        item, paths = volume_fixture(Path(temporary))
        before = {name: digest(path.read_bytes()) for name, path in paths.items()}
        assert len(set(before.values())) == 51, "The stress assets must be distinct"
        source_bytes = sum(path.stat().st_size for path in paths.values())
        loaded = []

        def load_image(value):
            loaded.append(value)
            return paths[value].read_bytes()

        started = time.perf_counter()
        data = build_report_pdf([item], image_loader=load_image)
        elapsed = time.perf_counter() - started
        assert loaded == [item["answers"]["signature"], *item["photo_urls"]], loaded
        assert before == {name: digest(path.read_bytes()) for name, path in paths.items()}, "Stored source evidence changed"
        assert len(data) < 15 * 1024 * 1024, f"50-photo PDF exceeded 15 MB: {len(data)}"
        assert len(data) < source_bytes / 3, (len(data), source_bytes)
        expected_photo_hashes = [
            digest(_printable_raster(paths[url].read_bytes(), VALUE_WIDTH - 16, 215)[0])
            for url in item["photo_urls"]
        ]
        reader = PdfReader(BytesIO(data))
        texts = page_texts(reader)
        assert len(reader.pages) == 26, len(reader.pages)
        assert_page_numbers(reader)
        complete_text = " ".join(texts)
        assert "unavailable" not in complete_text.lower()
        assert item["supervisor_note"] in complete_text
        assert re.findall(r"VOLUME-CAPTION-(\d{2})\.jpg", complete_text) == [f"{index:02d}" for index in range(1, 51)]
        all_rasters = {}
        painted_photo_hashes = []
        photo_paints = signature_paints = 0
        for page_number, page in enumerate(reader.pages, start=1):
            text = texts[page_number - 1]
            assert item["form_name"] in text and "Mutual" in text and "Version 7" in text
            resources = page["/Resources"]["/XObject"].get_object()
            photos_on_page = signatures_on_page = 0

            def visit(operator, operands, matrix, _text_matrix):
                nonlocal photo_paints, signature_paints, photos_on_page, signatures_on_page
                if operator != b"Do":
                    return
                reference = resources[operands[0]]
                raster = reference.get_object()
                if raster.get("/Subtype") != "/Image":
                    return
                size = int(raster["/Width"]), int(raster["/Height"])
                if size == (318, 318):
                    return  # Approved packaged Mutual artwork is not resized.
                all_rasters[reference.indirect_reference.idnum] = size
                assert size[0] <= int((VALUE_WIDTH - 16) * EVIDENCE_DPI / 72), size
                assert size[1] <= int(215 * EVIDENCE_DPI / 72), size
                assert matrix[1] == matrix[2] == 0, matrix
                assert matrix[4] >= 0 and matrix[5] >= 0, matrix
                assert matrix[4] + matrix[0] <= float(page.mediabox.width) + 0.1, matrix
                assert matrix[5] + matrix[3] <= float(page.mediabox.height) + 0.1, matrix
                assert abs(matrix[0] / matrix[3] - size[0] / size[1]) < 0.02
                if raster.get("/SMask"):
                    signature_paints += 1
                    signatures_on_page += 1
                    assert size[1] <= int(94 * EVIDENCE_DPI / 72)
                else:
                    photo_paints += 1
                    photos_on_page += 1
                    # ReportLab wraps opaque photo JPEGs in ASCII85; decoded
                    # DCT streams must still be the exact prepared image bytes.
                    painted_photo_hashes.append(digest(raster.get_data()))

            page.extract_text(visitor_operand_before=visit)
            assert photos_on_page == len(re.findall(r"VOLUME-CAPTION-\d{2}\.jpg", text)), (
                "Photo split from its caption", page_number, text,
            )
            if signatures_on_page:
                assert "SYNTHETIC SIGNER" in text, "Signature split from name"
        assert photo_paints == 50 and signature_paints == 1, (photo_paints, signature_paints)
        assert painted_photo_hashes == expected_photo_hashes, "Photo content/order changed in PDF"
        assert len(all_rasters) == 51, len(all_rasters)
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
        result = {"photos": photo_paints, "signatures": signature_paints, "pages": len(reader.pages),
                  "pdfBytes": len(data), "sourceBytes": source_bytes, "renderSeconds": round(elapsed, 2),
                  "maxRasterWidth": max(size[0] for size in all_rasters.values()),
                  "maxRasterHeight": max(size[1] for size in all_rasters.values()),
                  "sourceEvidenceUnchanged": True}
        print("ok - 50 distinct 6 MP photos: " + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    test_small_rasters_are_unchanged()
    test_orientation_alpha_and_signature_quality()
    test_fifty_camera_resolution_photos(args.output)
