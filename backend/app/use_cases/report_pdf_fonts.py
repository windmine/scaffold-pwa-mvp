"""Packaged, embedded Chinese PDF fonts; no host font or network dependency."""
from pathlib import Path
import re
from threading import Lock

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


_FONT_DIRECTORY = Path(__file__).resolve().parent.parent / "assets" / "report-fonts"
_REGULAR = "ReportFlowChinese-Regular"
_BOLD = "ReportFlowChinese-Bold"
_REGISTRATION_LOCK = Lock()
_REGISTERED = False
_CHINESE_TEXT = re.compile(
    "[\u2e80-\u2fff\u3000-\u303f\u3100-\u312f\u31a0-\u31ef"
    "\u3400-\u9fff\uf900-\ufaff\ufe00-\ufe6f\uff00-\uffef"
    "\U00020000-\U000323af]"
)


class _ChineseTTFont(TTFont):
    def addObjects(self, doc):
        # ReportLab 4.5.1 writes non-BMP destinations as bare five/six-digit
        # codepoints. PDF ToUnicode requires UTF-16BE surrogate pairs instead.
        # Repair only this font's affected streams, never the global formatter.
        state = self.state.get(doc)
        affected = [self.getSubsetInternalName(index, doc)[1:]
                    for index, subset in enumerate(state.subsets if state else ())
                    if any(codepoint > 0xFFFF for codepoint in subset)]
        super().addObjects(doc)
        for name in affected:
            font = doc.idToObject["BasicFonts"].dict[name]
            stream = doc.idToObject[font.ToUnicode.name]
            stream.content = re.sub(
                r"(?m)^(<[0-9A-Fa-f]+>) <([0-9A-Fa-f]{5,6})>$",
                lambda match: f"{match[1]} <{chr(int(match[2], 16)).encode('utf-16-be').hex().upper()}>",
                stream.content,
            )


def chinese_pdf_font(text: str, *, bold: bool = False) -> str | None:
    """Choose an embedded font only when needed; preserve existing Latin layout.

    One guarded registration per process avoids racing ReportLab's global font
    registry. Its TrueType subset state is then local to each PDF document.
    Missing/damaged required fonts raise instead of silently exporting boxes.
    """
    if not _CHINESE_TEXT.search(text):
        return None
    global _REGISTERED
    with _REGISTRATION_LOCK:
        if not _REGISTERED:
            regular = _ChineseTTFont(_REGULAR, str(_FONT_DIRECTORY / f"{_REGULAR}.ttf"))
            bold_font = _ChineseTTFont(_BOLD, str(_FONT_DIRECTORY / f"{_BOLD}.ttf"))
            pdfmetrics.registerFont(regular)
            pdfmetrics.registerFont(bold_font)
            pdfmetrics.registerFontFamily(_REGULAR, normal=_REGULAR, bold=_BOLD,
                                          italic=_REGULAR, boldItalic=_BOLD)
            _REGISTERED = True
    return _BOLD if bold else _REGULAR
