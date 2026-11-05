#!/usr/bin/env python3
"""Create minimal timeline SRT patch ZIP, leaving translations and OAuth untouched."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
paths = ["tools/timeline/index.html", "tools/timeline/srt.js", "타임라인_SRT_사용안내.txt"]
out = root / "CreatorStudio_Timeline_SRT_12to15s_Patch.zip"
with ZipFile(out, "w", ZIP_DEFLATED) as archive:
    for name in paths:
        source = root / name
        if not source.is_file():
            raise RuntimeError(f"Missing patch source: {name}")
        archive.write(source, arcname=name)
with ZipFile(out) as archive:
    assert set(archive.namelist()) == set(paths)
    html = archive.read("tools/timeline/index.html").decode("utf-8")
    js = archive.read("tools/timeline/srt.js").decode("utf-8")
    assert 'id="srtSeconds"' in html
    assert 'id="downloadSrtBtn"' in html
    assert 'buildTimelineSrt' in js
print(f"PASS: SRT-only patch ZIP {out.name} ({out.stat().st_size:,} bytes)")
