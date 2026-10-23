"""Public, account-independent invitation attachment; no remote assets or tokens."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


PUBLIC_APP_URL = "https://geo-attendance-system-db9ca.web.app"
GUIDE_FILENAME = "ReportFlow-Getting-Started.pdf"
MAX_GUIDE_BYTES = 512 * 1024
GUIDE_VERSION = "2026-10-23"


def _draw_qr(pdf, x, y, size):
    # The only payload is the fixed public app URL. Four white modules surround it.
    qr = QRCode(None, QRErrorCorrectLevel.Q)
    qr.addData(PUBLIC_APP_URL)
    qr.make()
    modules = len(qr.modules)
    unit = size / (modules + 8)
    pdf.setFillColor(colors.white)
    pdf.rect(x, y, size, size, fill=1, stroke=0)
    pdf.setFillColor(colors.black)
    path = pdf.beginPath()
    for row, values in enumerate(qr.modules):
        for column, dark in enumerate(values):
            if dark:
                path.rect(x + (column + 4) * unit, y + (modules + 3 - row) * unit, unit, unit)
    pdf.drawPath(path, fill=1, stroke=0)


@lru_cache(maxsize=1)
def getting_started_pdf():
    """Generate once per process, from packaged assets and constant public text."""
    output = BytesIO()
    pdf = canvas.Canvas(output, pagesize=A4, invariant=1, pageCompression=1, lang="en-NZ")
    pdf.setTitle("ReportFlow | Getting started")
    pdf.setAuthor("ReportFlow")
    pdf.setSubject("Public installation and first-report guide")
    blue = colors.HexColor("#123b72")
    ink = colors.HexColor("#172438")
    muted = colors.HexColor("#4d5d71")
    width, _ = A4
    pdf.setFillColor(blue)
    pdf.rect(0, 267 * mm, width, 30 * mm, fill=1, stroke=0)
    logo = Path(__file__).resolve().parent.parent / "assets/report-logos/reportflow.png"
    pdf.drawImage(str(logo), 18 * mm, 273 * mm, width=18 * mm, height=18 * mm,
                  preserveAspectRatio=True, anchor="c", mask="auto")
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 21)
    pdf.drawString(42 * mm, 282 * mm, "ReportFlow")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(42 * mm, 274 * mm, "Getting started")
    body_style = ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=14, textColor=ink)
    small_style = ParagraphStyle("small", parent=body_style, fontSize=9, leading=12, textColor=muted)

    def paragraph(text, x, top, available_width, style=body_style):
        p = Paragraph(text, style)
        _, height = p.wrap(available_width, 250 * mm)
        p.drawOn(pdf, x, top - height)
        return top - height

    _draw_qr(pdf, 148 * mm, 211 * mm, 45 * mm)
    top = paragraph("<b>Accept your invitation first</b><br/>Open the private link in your invitation email and set your own password. The link works once and expires at the exact date and time shown in that email. If it has expired, ask the person who invited you for a new invitation.",
                    18 * mm, 254 * mm, 120 * mm)
    paragraph("Keep your invitation link private. This QR opens the public app only; scanning it does not accept an invitation or create an account.",
              18 * mm, top - 3 * mm, 120 * mm, small_style)
    paragraph("<b>Scan to open the app</b>", 148 * mm, 207 * mm, 49 * mm, small_style)
    top = paragraph(f'<link href="{PUBLIC_APP_URL}" color="#123b72">{PUBLIC_APP_URL}</link>',
                    18 * mm, 196 * mm, 174 * mm)

    sections = [
        ("1  Add ReportFlow to your device", "ReportFlow is a web app (PWA). Use it in your browser or install it from the website; no App Store download is needed.<br/><b>iPhone / Safari:</b> Open the app link in Safari. Tap Share (or Page Menu, then Share), choose Add to Home Screen, keep Open as Web App on if shown, then tap Add.<br/><b>Android / Chrome:</b> Open the app link in Chrome. Open More, then Install and create shortcut &gt; Install. Some versions show Install app or Add to Home screen. Confirm the prompt.<br/><b>Computer / Chrome:</b> Choose the address-bar Install icon if available, or More &gt; Cast, save, and share &gt; Install page as app. You can also keep using the browser."),
        ("2  Sign in", "Open ReportFlow and sign in with the email address that received your invitation and the password you just set. Installing the app does not grant access. Connect to the internet for first setup and signing in."),
        ("3  Complete your first Report", "Choose New Report (Supervisors: Submit form &gt; New Report), then an available Department template. Enter the Report Date, optional Site, answers and any required photos or signatures. Review your entries and submit. Check My Reports to confirm it is submitted; a queued Report is still waiting to sync."),
        ("4  Keep your work safe", "Use a connection whenever possible. Offline availability depends on what has already been downloaded on that device; first-time offline form loading is not guaranteed. Do not uninstall or clear browser data while Reports are queued. For access, missing templates or an expired invitation, contact the person who invited you."),
    ]
    top -= 8 * mm
    for heading, text in sections:
        pdf.setFillColor(blue)
        pdf.setFont("Helvetica-Bold", 11)
        pdf.drawString(18 * mm, top, heading)
        top = paragraph(text, 18 * mm, top - 3 * mm, 174 * mm) - 7 * mm
    if top < 16 * mm:
        raise ValueError("Getting-started guide exceeds one page")
    pdf.setStrokeColor(colors.HexColor("#dce4ee"))
    pdf.line(18 * mm, 14 * mm, 192 * mm, 14 * mm)
    pdf.setFillColor(muted)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(18 * mm, 9 * mm, f"ReportFlow | Public getting-started guide | {GUIDE_VERSION}")
    pdf.showPage()
    pdf.save()
    result = output.getvalue()
    if not result.startswith(b"%PDF-") or len(result) > MAX_GUIDE_BYTES:
        raise ValueError("Invalid getting-started guide")
    return result
