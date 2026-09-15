"""Allowlisted department branding packaged with the backend PDF renderer."""

from functools import lru_cache
from pathlib import Path


_LOGO_DIRECTORY = Path(__file__).resolve().parent.parent / "assets" / "report-logos"
_DEPARTMENT_BRANDS = {
    "leader": ("Leader Scaffolding", "leader.png"),
    "mutual": ("Mutual", "mutual.png"),
    "mc": ("MC", "mc.png"),
    "stech": ("Stech", "stech.png"),
    "bop": ("BOP", "bop.png"),
}


@lru_cache(maxsize=6)
def _packaged_logo(filename: str) -> bytes | None:
    try:
        return (_LOGO_DIRECTORY / filename).read_bytes()
    except OSError:
        # Missing optional branding must not prevent a Report from exporting.
        return None


def report_department_branding(department_name: str | None) -> tuple[str, bytes | None]:
    """Return a display name and raster logo without using names as file paths.

    The allowlist mirrors the app's department brands. Unknown departments retain
    their own name and use the neutral ReportFlow mark, never another department's
    identity. Assets are inside ``backend`` so Cloud Run images include them.
    """
    name = str(department_name or "").strip()
    display_name, filename = _DEPARTMENT_BRANDS.get(
        name.casefold(), (name or "ReportFlow", "reportflow.png")
    )
    return display_name, _packaged_logo(filename)
