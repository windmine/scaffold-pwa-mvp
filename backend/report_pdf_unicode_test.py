"""Chinese/mixed Report export regressions using synthetic immutable records.

Run ``python backend/report_pdf_unicode_test.py``. These exercise the real PDF
renderer; rendered-page QA remains separate from Unicode extraction checks.
"""
import re
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics

from app.use_cases.report_pdf import build_report_pdf
from report_pdf_layout_test import (
    assert_page_numbers, drawing_events, report_fixture, synthetic_image,
)


def compact(value):
    return re.sub(r"\s+", "", value)


def chinese_fixture(**overrides):
    item = report_fixture(
        form_name="现场安全检查 / 現場安全檢查 Safety report",
        form_description="中文导出验证：保留原始答案、照片及签名。繁體中文也須完整保留。",
        department_name="工程部門",
        worker_name="张伟 / 陳小明",
        worker_email="",
        site_name="奥克兰工地 / 奧克蘭工地 A-12",
        fields=[
            {"id": "checks", "type": "section", "label": "检查记录 / 檢查記錄"},
            {"id": "finding", "type": "textarea", "label": "发现的问题 / 發現的問題"},
            {"id": "name", "type": "text", "label": "签署人姓名 / 簽署人姓名"},
            {"id": "sign", "type": "signature", "label": "手写签名 / 手寫簽名"},
        ],
        answers={
            "finding": "护栏已安装；通道保持畅通。護欄已安裝；通道保持暢通。\n"
                       "尺寸 1200 mm，温度 18°C。文字 <b>原样</b> & literal content。",
            "name": "李华 / 李華",
            "sign": "/uploads/synthetic-unicode-signature.png",
        },
        photo_urls=["/uploads/synthetic-unicode-photo.png"],
        reviewing_supervisor_name="王主管 / 黃主管",
        supervisor_note="已复查并完成整改。已複查並完成整改。Reviewed and resolved.",
    )
    item.update(overrides)
    return item


ASSETS = {
    "/uploads/synthetic-unicode-signature.png": synthetic_image(181, 61, "navy"),
    "/uploads/synthetic-unicode-photo.png": synthetic_image(224, 140, "orange"),
}


def read(items):
    return PdfReader(BytesIO(build_report_pdf(items, image_loader=ASSETS.get)))


def test_parallel_exports_keep_font_registration_and_subsets_isolated():
    def export(index):
        # Different characters and subset mappings in simultaneous documents.
        marker = ("𠮷明甲", "𠀋华乙", "𠮟文丙", "陳偉丁")[index]
        item = chinese_fixture(worker_name=marker, worker_email=f"synthetic-{index}@example.invalid")
        text = compact("".join(page.extract_text() or "" for page in read([item]).pages))
        assert marker in text and item["worker_email"] in text, (index, text)
        for other in range(4):
            if other != index:
                assert f"synthetic-{other}@example.invalid" not in text, index
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(export, range(4)))
    print("ok - concurrent first-use exports register fonts safely and keep document subsets separate")


def test_simplified_traditional_and_mixed_content_survives_export():
    item = chinese_fixture()
    reader = read([item])
    text = compact("".join(page.extract_text() or "" for page in reader.pages))
    expected = [item[key] for key in (
        "form_name", "form_description", "department_name", "worker_name",
        "site_name", "reviewing_supervisor_name", "supervisor_note",
    )]
    expected += [field["label"] for field in item["fields"]]
    expected += [item["answers"]["finding"], item["answers"]["name"]]
    for value in expected:
        assert compact(value) in text, f"PDF lost Unicode text: {value!r}"
    assert "\u25a0" not in text and "\ufffd" not in text, "Missing-glyph replacements in PDF"
    assert_page_numbers(reader)
    images = [value for kind, value in drawing_events(reader) if kind == "image"]
    assert (181, 61) in images and (224, 140) in images, images
    print("ok - Simplified/Traditional Chinese and mixed English survive every Report text location")


def test_long_unspaced_chinese_content_splits_without_loss():
    # Distinct Han alphabets let us count every input glyph independently of
    # repeated page headers and footers, even when a page splits the phrase.
    label = "甲乙丙丁" * 450 + "标签结尾標籤結尾"
    answer = "戊己庚辛壬癸" * 850 + "答案结尾答案結尾"
    note = "子丑寅卯辰巳午未申酉戌亥" * 220 + "批注结尾批註結尾"
    item = chinese_fixture(
        fields=[{"id": "long", "type": "textarea", "label": label}],
        answers={"long": answer}, supervisor_note=note, photo_urls=[],
    )
    reader = read([item, chinese_fixture(id=4102, form_name="第二份報告 / Second Report")])
    text = compact("".join(page.extract_text() or "" for page in reader.pages))
    for alphabet, value in (("甲乙丙丁", label), ("戊己庚辛壬癸", answer), ("子丑寅卯辰巳午未申酉戌亥", note)):
        for character in alphabet:
            assert text.count(character) == value.count(character), f"PDF lost/repeated {character}"
    for value in ("标签结尾標籤結尾", "答案结尾答案結尾", "批注结尾批註結尾", "第二份報告 / Second Report"):
        assert compact(value) in text, f"PDF lost long Chinese text: {value!r}"
    assert len(reader.pages) >= 5, len(reader.pages)
    assert_page_numbers(reader)
    print("ok - long unspaced Chinese labels, answers and notes span collection pages without lost tails")


def test_supplementary_han_names_keep_valid_unicode_mapping():
    item = chinese_fixture(worker_name="𠮷明 / 𠀋华", supervisor_note="𠮟字检查完成。")
    reader = read([item])
    text = compact("".join(page.extract_text() or "" for page in reader.pages))
    assert compact(item["worker_name"]) in text, "Rare Chinese name lost in PDF Unicode mapping"
    assert compact(item["supervisor_note"]) in text, "Supplementary Han note lost in PDF"
    for page in reader.pages:
        for font in page["/Resources"]["/Font"].values():
            font = font.get_object()
            if "/ToUnicode" in font:
                cmap = font["/ToUnicode"].get_data().decode("ascii")
                assert not re.search(r"<[0-9A-Fa-f]+> <[0-9A-Fa-f]{5,6}>", cmap), cmap
    # Exercise more than one embedded 256-character subset, not just the first
    # mapping stream. Every selected glyph exists in the packaged font.
    supported = pdfmetrics.getFont("ReportFlowChinese-Regular").face.charToGlyph
    rare_text = "".join(chr(codepoint) for codepoint in sorted(supported)
                        if codepoint > 0xFFFF and supported[codepoint])[:350]
    assert len(rare_text) == 350
    reader = read([chinese_fixture(answers={"finding": rare_text})])
    text = "".join(page.extract_text() or "" for page in reader.pages)
    assert all(character in text for character in rare_text), "A supplementary subset lost glyphs"
    print("ok - supplementary Han names use valid UTF-16 PDF Unicode mappings")


def test_fonts_are_packaged_licensed_and_embedded_with_real_glyphs():
    directory = Path(__file__).resolve().parent / "app" / "assets" / "report-fonts"
    provenance = json.loads((directory / "provenance.json").read_text(encoding="utf-8"))
    for asset in provenance["files"]:
        content = (directory / asset["name"]).read_bytes()
        assert len(content) == asset["bytes"], asset["name"]
        assert hashlib.sha256(content).hexdigest() == asset["sha256"], asset["name"]
    license_bytes = (directory / provenance["licenseFile"]).read_bytes()
    assert hashlib.sha256(license_bytes).hexdigest() == provenance["licenseSha256"]
    assert b"SIL OPEN FONT LICENSE Version 1.1" in license_bytes
    reader = read([chinese_fixture()])
    embedded = set()
    for page in reader.pages:
        for reference in page["/Resources"]["/Font"].values():
            font = reference.get_object()
            name = str(font["/BaseFont"])
            if "ReportFlowChinese" not in name:
                continue
            embedded.add("Bold" if "Bold" in name else "Regular")
            assert font.get("/ToUnicode"), name
            descriptor = font["/FontDescriptor"].get_object()
            assert len(descriptor["/FontFile2"].get_data()) > 1000, name
    assert embedded == {"Regular", "Bold"}, embedded
    for name in ("ReportFlowChinese-Regular", "ReportFlowChinese-Bold"):
        font = pdfmetrics.getFont(name)
        for character in "现场检查张伟护栏簽名黃主管陳華繁體𠮷𠮟𠀋":
            assert font.face.charToGlyph.get(ord(character), 0) != 0, (name, character)
    print("ok - licensed packaged regular/bold fonts contain and embed Chinese glyphs")


if __name__ == "__main__":
    test_parallel_exports_keep_font_registration_and_subsets_isolated()
    test_simplified_traditional_and_mixed_content_survives_export()
    test_long_unspaced_chinese_content_splits_without_loss()
    test_supplementary_han_names_keep_valid_unicode_mapping()
    test_fonts_are_packaged_licensed_and_embedded_with_real_glyphs()
