"""Render synthetic Chinese and mixed-language PDFs for visual QA, offline."""
import argparse
from pathlib import Path

from app.use_cases.report_pdf import build_report_pdf
from report_pdf_unicode_test import ASSETS, chinese_fixture


def mixed_long_fixture():
    return chinese_fixture(
        id=4102, form_name="工地巡查 / Site inspection - 繁體與简体中文",
        worker_name="𠮷明 / 陳小明", department_name="Mutual",
        form_description="SYNTHETIC PREVIEW ONLY - 中文与 English 混合排版，非真实报告。",
        fields=[
            {"id": "checks", "type": "section", "label": "现场检查记录 / 現場檢查記錄"},
            {"id": "finding", "type": "textarea", "label": "检查结果及采取的措施 / 檢查結果及採取的措施"},
            {"id": "signers", "type": "repeat", "label": "参与人员签署 / 參與人員簽署"},
            {"id": "name", "type": "text", "label": "姓名 / Name", "repeat": "signers"},
            {"id": "sign", "type": "signature", "label": "签名 / 簽名", "repeat": "signers"},
        ],
        answers={
            "finding": "\n".join(
                f"检查项目 {index:02d}：护栏已安装，通道保持畅通，所有原始记录均已保留。"
                "檢查項目已完成；主管確認作業區域安全，並保留照片與簽名。"
                "Clear access confirmed; scaffold bay A-12 remains ready for inspection."
                for index in range(1, 26)
            ) + "\n长答案结尾 / 長答案結尾 - END OF FINDINGS",
            "signers": [
                {"name": "张伟 / 張偉", "sign": "/uploads/synthetic-unicode-signature.png"},
                {"name": "李华 / 李華", "sign": "/uploads/synthetic-unicode-signature.png"},
            ],
        },
        supervisor_note=("已复查并完成整改。已複查並完成整改。 "
                         "Evidence reviewed; all actions recorded.\n") * 16
                         + "主管批注结尾 / 主管批註結尾 - END OF FINAL NOTE",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path,
                        default=Path("output/pdf/report-chinese-validation.local"))
    args = parser.parse_args()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    for filename, items in (
        ("chinese-report.pdf", [chinese_fixture()]),
        ("mixed-chinese-collection.pdf", [chinese_fixture(), mixed_long_fixture()]),
    ):
        path = args.output_directory / filename
        path.write_bytes(build_report_pdf(items, image_loader=ASSETS.get))
        print(path.resolve())
