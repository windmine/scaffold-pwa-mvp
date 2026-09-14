"""Generate deterministic ReportFlow install QR downloads and an A4 PDF guide.

Requires the existing Pillow and ReportLab tooling. Run from any directory:
    python scripts/generate-install-qr.py
The QR always points to the permanent install page, never a preview channel.
"""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

from PIL import Image, ImageDraw, PngImagePlugin
from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
INSTALL_URL = "https://geo-attendance-system-db9ca.web.app/install.html"
QUIET_MODULES = 4
PIXELS_PER_MODULE = 20
PDF_QR_SIZE = 95 * mm
BLUE = colors.HexColor("#123b72")
INK = colors.HexColor("#172438")
MUTED = colors.HexColor("#4d5d71")
PALE = colors.HexColor("#f1f5fa")


def qr_matrix() -> list[list[bool]]:
    qr = QRCode(None, QRErrorCorrectLevel.Q)
    qr.addData(INSTALL_URL)
    qr.make()
    return qr.modules


def black_runs(matrix: list[list[bool]]):
    """Yield exact whole-module horizontal runs, retaining a white quiet zone."""
    for row_index, row in enumerate(matrix):
        column = 0
        while column < len(row):
            if not row[column]:
                column += 1
                continue
            start = column
            while column < len(row) and row[column]:
                column += 1
            yield start + QUIET_MODULES, row_index + QUIET_MODULES, column - start


def png_bytes(matrix: list[list[bool]]) -> bytes:
    size = (len(matrix) + 2 * QUIET_MODULES) * PIXELS_PER_MODULE
    image = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(image)
    for x, y, width in black_runs(matrix):
        draw.rectangle(
            (
                x * PIXELS_PER_MODULE,
                y * PIXELS_PER_MODULE,
                (x + width) * PIXELS_PER_MODULE - 1,
                (y + 1) * PIXELS_PER_MODULE - 1,
            ),
            fill="black",
        )
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Title", "ReportFlow install QR - PNG")
    metadata.add_text("Description", INSTALL_URL)
    output = BytesIO()
    image.save(output, format="PNG", pnginfo=metadata, optimize=False, dpi=(300, 300))
    return output.getvalue()


def svg_bytes(matrix: list[list[bool]]) -> bytes:
    size = len(matrix) + 2 * QUIET_MODULES
    pixels = size * PIXELS_PER_MODULE
    paths = " ".join(f"M{x} {y}h{width}v1h-{width}z" for x, y, width in black_runs(matrix))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{pixels}" height="{pixels}" '
        f'viewBox="0 0 {size} {size}" role="img" aria-labelledby="title description" '
        'shape-rendering="crispEdges">\n'
        '  <title id="title">ReportFlow install QR - SVG</title>\n'
        f'  <desc id="description">Scan to open {INSTALL_URL}</desc>\n'
        f'  <rect width="{size}" height="{size}" fill="white"/>\n'
        f'  <path d="{paths}" fill="black"/>\n'
        '</svg>\n'
    ).encode("utf-8")


def draw_vector_qr(pdf: canvas.Canvas, matrix: list[list[bool]], x: float, y: float):
    total_modules = len(matrix) + 2 * QUIET_MODULES
    module_size = PDF_QR_SIZE / total_modules
    pdf.setFillColor(colors.white)
    pdf.rect(x, y, PDF_QR_SIZE, PDF_QR_SIZE, fill=1, stroke=0)
    path = pdf.beginPath()
    for column, row, width in black_runs(matrix):
        path.rect(
            x + column * module_size,
            y + (total_modules - row - 1) * module_size,
            width * module_size,
            module_size,
        )
    pdf.setFillColor(colors.black)
    pdf.drawPath(path, fill=1, stroke=0)


def instruction_card(pdf: canvas.Canvas, x: float, heading: str, lines: list[str]):
    width, height, y = 81 * mm, 44 * mm, 51 * mm
    pdf.setFillColor(PALE)
    pdf.roundRect(x, y, width, height, 3 * mm, fill=1, stroke=0)
    pdf.setFillColor(BLUE)
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(x + 5 * mm, y + height - 8 * mm, heading)
    style = ParagraphStyle(
        "install-step", fontName="Helvetica", fontSize=9.5, leading=13,
        textColor=INK, alignment=TA_LEFT,
    )
    current_y = y + height - 14 * mm
    for line in lines:
        paragraph = Paragraph(line, style)
        _, used_height = paragraph.wrap(width - 10 * mm, height)
        current_y -= used_height
        if current_y < y + 4 * mm:
            raise ValueError(f"Install instructions exceed the {heading} card")
        paragraph.drawOn(pdf, x + 5 * mm, current_y)
        current_y -= 2 * mm


def pdf_bytes(matrix: list[list[bool]]) -> bytes:
    output = BytesIO()
    pdf = canvas.Canvas(output, pagesize=A4, invariant=1, pageCompression=1, lang="en-NZ")
    pdf.setTitle("ReportFlow - A4 installation guide")
    pdf.setAuthor("ReportFlow")
    pdf.setSubject(f"Print guide and QR for {INSTALL_URL}")
    width, height = A4
    center = width / 2

    pdf.setFillColor(colors.white)
    pdf.rect(0, 0, width, height, stroke=0, fill=1)
    pdf.drawImage(str(ROOT / "assets/icons/reportflow-512.png"), 20 * mm, 258 * mm,
                  width=19 * mm, height=19 * mm, mask="auto")
    pdf.setFillColor(BLUE)
    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawString(44 * mm, 268 * mm, "ReportFlow")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(44 * mm, 260.5 * mm, "Reports, ready for your phone")

    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 25)
    pdf.drawCentredString(center, 240 * mm, "Scan to install ReportFlow")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 10.5)
    pdf.drawCentredString(center, 230.5 * mm, "Open your phone camera, scan the code, then tap the link.")

    draw_vector_qr(pdf, matrix, (width - PDF_QR_SIZE) / 2, 125 * mm)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawCentredString(center, 119 * mm, "OR OPEN THIS LINK IN YOUR BROWSER")
    pdf.setFillColor(BLUE)
    pdf.setFont("Helvetica", 10)
    pdf.drawCentredString(center, 111 * mm, INSTALL_URL)
    pdf.linkURL(INSTALL_URL, (20 * mm, 108 * mm, width - 20 * mm, 116 * mm), relative=0)

    instruction_card(pdf, 20 * mm, "Android / Chrome", [
        "1. Open the link in Chrome.",
        "2. Open the browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.",
        "3. Confirm the install prompt.",
    ])
    instruction_card(pdf, 109 * mm, "iPhone / Safari", [
        "1. Open the link in Safari.",
        "2. Tap <b>Share</b> &gt; <b>Add to Home Screen</b>.",
        "3. Turn on <b>Open as Web App</b> if shown, then tap <b>Add</b>.",
    ])

    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawCentredString(center, 37 * mm, "Invited accounts only")
    pdf.setFont("Helvetica", 9.5)
    pdf.drawCentredString(center, 30 * mm, "After installing, sign in with your Supervisor-provided account.")
    pdf.setFillColor(MUTED)
    pdf.drawCentredString(center, 24 * mm, "An internet connection is required for first setup.")
    pdf.setFont("Helvetica", 8)
    pdf.drawCentredString(center, 12 * mm, "ReportFlow | Printable A4 installation guide | PDF")
    pdf.showPage()
    pdf.save()
    return output.getvalue()


def main():
    matrix = qr_matrix()
    pdf = pdf_bytes(matrix)
    svg = svg_bytes(matrix)
    artifacts = {
        "assets/icons/reportflow-install-qr.svg": svg,
        "public/downloads/reportflow-install-qr.svg": svg,
        "public/downloads/reportflow-install-qr.png": png_bytes(matrix),
        "public/downloads/reportflow-install-a4.pdf": pdf,
        "output/pdf/reportflow-install-a4.pdf": pdf,
    }
    for relative_path, contents in artifacts.items():
        target = ROOT / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
    print(json.dumps({
        "url": INSTALL_URL,
        "qrModules": len(matrix),
        "quietZoneModules": QUIET_MODULES,
        "pngPixels": (len(matrix) + 2 * QUIET_MODULES) * PIXELS_PER_MODULE,
        "pdfPage": "A4 portrait, one page",
        "pdfQrSizeMm": PDF_QR_SIZE / mm,
        "artifacts": {
            path: {"bytes": len(contents), "sha256": sha256(contents).hexdigest()}
            for path, contents in artifacts.items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
