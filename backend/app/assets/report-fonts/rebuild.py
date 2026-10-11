"""Rebuild the two packaged static Chinese fonts from the pinned upstream TTF.

Build-time only: ``pip install fonttools==4.60.1``; not a runtime dependency.
The source path is supplied explicitly. This script never downloads anything.
See provenance.json and LICENSE.txt in this directory.
"""
import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SOURCE_SHA256 = "990c807e79c25662a5a9ecf7f971baeb2bf2eab9a559e5ecf15cdfdb8561d21f"
# Retain the upstream Unicode mappings for Chinese, Latin, punctuation and
# symbols. Korean syllables and unencoded regional alternates are not needed by
# this renderer. Retain supplementary Han and compatibility ideographs too.
UNICODE_RANGES = (
    (0x0000, 0x2FFF), (0x3000, 0x303F), (0x3100, 0x312F),
    (0x31A0, 0x31EF), (0x3400, 0x9FFF), (0xF900, 0xFAFF),
    (0xFE00, 0xFE6F), (0xFF00, 0xFFEF), (0x20000, 0x323AF),
)


def rebuild(source_path, output_directory):
    source = source_path.read_bytes()
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("Unexpected source font: use the exact pinned upstream TTF")
    output_directory.mkdir(parents=True, exist_ok=True)
    for weight, style in ((400, "Regular"), (700, "Bold")):
        font = TTFont(source_path, recalcTimestamp=False)
        supported = {
            codepoint for codepoint in font.getBestCmap()
            if any(start <= codepoint <= end for start, end in UNICODE_RANGES)
        }
        options = subset.Options()
        options.layout_features = []
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
        options.name_languages = ["*"]
        options.recalc_timestamp = False
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=supported)
        subsetter.subset(font)
        instantiateVariableFont(font, {"wght": weight}, inplace=True)
        # Name the derivative independently; retain upstream copyright/license.
        family = "ReportFlow Chinese"
        postscript = f"ReportFlowChinese-{style}"
        names = {
            1: family, 2: style, 3: f"1.000;ReportFlow;{postscript}",
            4: f"{family} {style}", 5: "Version 1.000; derived from Noto Sans CJK 2.004",
            6: postscript, 16: family, 17: style,
        }
        for record in font["name"].names:
            if record.nameID in names:
                record.string = names[record.nameID]
        for name_id, value in names.items():
            font["name"].setName(value, name_id, 3, 1, 0x409)
        font["OS/2"].usWeightClass = weight
        font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x61) | (0x20 if weight == 700 else 0x40)
        font["head"].macStyle = 1 if weight == 700 else 0
        target = output_directory / f"{postscript}.ttf"
        font.save(target)
        font.close()
        content = target.read_bytes()
        print(f"{target.name}: {len(content)} bytes; SHA256 {hashlib.sha256(content).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    rebuild(args.source, args.output)
