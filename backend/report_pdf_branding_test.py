"""Focused packaged-branding checks; run with python backend/report_pdf_branding_test.py."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

from app.use_cases import report_pdf_branding as branding


def main():
    expected = {
        "Leader": "Leader Scaffolding",
        "Mutual": "Mutual",
        "MC": "MC",
        "Stech": "Stech",
        "BOP": "BOP",
    }
    logos = []
    for department_name, expected_display in expected.items():
        display_name, logo = branding.report_department_branding(department_name)
        assert display_name == expected_display
        assert logo, f"Missing packaged logo for {department_name}"
        with Image.open(BytesIO(logo)) as image:
            assert image.format == "PNG"
            assert image.width > 0 and image.height > 0
            image.verify()
        assert branding.report_department_branding(f"  {department_name.swapcase()}  ") == (
            display_name, logo
        )
        logos.append(logo)
    assert len(set(logos)) == len(expected), "Departments must not share another brand's logo"

    neutral_name, neutral_logo = branding.report_department_branding(None)
    assert neutral_name == "ReportFlow" and neutral_logo
    assert neutral_logo not in logos
    for unknown_name in ("New Department", "../../private", "C:\\secrets", "LEADER/logo.png"):
        display_name, logo = branding.report_department_branding(f"  {unknown_name}  ")
        assert display_name == unknown_name
        assert logo == neutral_logo, "Unrecognized input must only select the neutral logo"

    backend_directory = Path(__file__).resolve().parent
    assert branding._LOGO_DIRECTORY.is_relative_to(backend_directory)
    assert len(list(branding._LOGO_DIRECTORY.glob("*.png"))) == 6
    assert (branding._LOGO_DIRECTORY / "leader.png").read_bytes() == (
        backend_directory.parent / "assets" / "icons" / "leader-logo-export.png"
    ).read_bytes()
    mutual_source = (
        backend_directory.parent / "assets" / "icons" / "mutual-logo-export.png"
    ).read_bytes()
    assert (branding._LOGO_DIRECTORY / "mutual.png").read_bytes() == mutual_source
    # Intentional approved-artwork fixture: preserve the user's supplied logo exactly.
    assert sha256(mutual_source).hexdigest() == (
        "3ab6dbe9fb1228c41a7d0e9f4898d0ffa9c1bd9193d7e9ec44bcc60f8d676d14"
    )
    with Image.open(BytesIO(mutual_source)) as image:
        assert image.size == (318, 318)

    with TemporaryDirectory(prefix="report-branding-") as directory:
        with patch.object(branding, "_LOGO_DIRECTORY", Path(directory)):
            branding._packaged_logo.cache_clear()
            assert branding.report_department_branding("Mutual") == ("Mutual", None)
            assert branding.report_department_branding("New Department") == ("New Department", None)
        branding._packaged_logo.cache_clear()
    print("Report PDF branding checks passed: six packaged logos, name normalization, neutral fallback, missing assets.")


if __name__ == "__main__":
    main()
