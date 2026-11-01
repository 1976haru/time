#!/usr/bin/env python3
"""Build a shareable 83-language Creator Studio source ZIP from tracked files only."""
from __future__ import annotations
import pathlib
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAME = "CreatorStudio_Friend_83_Languages_MultiAccount.zip"
SENSITIVE_PATH = re.compile(
    r"(^|/)(?:\.yt_oauth(?:\.json(?:\.bak)?)?|\.gemini_key(?:_paid)?|\.env(?:\..+)?|"
    r"credentials\.json|token\.json|client_secret[^/]*\.json|\.yt_translation_cache\.json)(?:$|/)",
    flags=re.IGNORECASE,
)
# These are supporting fonts for other optional tools, not required by the translator.
SKIP_SUFFIXES = {".otf", ".ttf", ".woff", ".woff2"}

def main() -> int:
    language_src = (ROOT / "lib/ytLanguages.js").read_text(encoding="utf-8")
    match = re.search(r"export const FALLBACK_LANGUAGE_CATALOG = Object\.freeze\(\[(.*?)\]\.map\(", language_src, re.S)
    if not match:
        raise RuntimeError("83-language fallback catalogue is missing")
    codes = re.findall(r"\['([^']+)',\s*'[^']+'\]", match.group(1))
    if len(codes) != 83 or len({x.lower() for x in codes}) != 83:
        raise RuntimeError(f"Invalid fallback catalogue: {len(codes)} entries")
    route = (ROOT / "routes/yt.js").read_text(encoding="utf-8")
    oauth = (ROOT / "lib/ytOAuth.js").read_text(encoding="utf-8")
    if "getLanguageCatalog" not in route or re.search(r"languages\.length\s*>\s*50", route):
        raise RuntimeError("83 language routing not active or 50-language cap found")
    if "assertAccountOwnsChannel" not in oauth or "listOAuthClients" not in oauth:
        raise RuntimeError("Multi-account OAuth protections missing")
    tracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"]).decode("utf-8").split("\0")
    output = ROOT / NAME
    safe = []
    for path in tracked:
        if not path or path.startswith(".github/") or path.startswith(".git/"):
            continue
        if SENSITIVE_PATH.search(path):
            raise RuntimeError(f"Sensitive tracked path prevents distribution: {path}")
        file_path = ROOT / path
        if not file_path.is_file() or file_path.suffix.lower() in SKIP_SUFFIXES:
            continue
        if file_path.suffix.lower() in {".js", ".mjs", ".json", ".txt", ".md", ".html", ".css", ".yml", ".yaml", ".bat", ".ps1"}:
            try:
                data = file_path.read_text(encoding="utf-8", errors="strict")
            except UnicodeDecodeError:
                data = ""
            if re.search(r"AIza[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}", data):
                raise RuntimeError(f"Possible embedded Google secret in tracked file: {path}")
        safe.append(path)
    if not safe or "start-creator-studio.bat" not in safe:
        raise RuntimeError("No deployable launcher found")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=7) as bundle:
        for path in sorted(safe):
            bundle.write(ROOT / path, arcname=path)
    with zipfile.ZipFile(output) as bundle:
        names = set(bundle.namelist())
        if "lib/ytLanguages.js" not in names or "lib/ytOAuth.js" not in names or "친구용_사용설명서_83언어.txt" not in names:
            raise RuntimeError("ZIP verification failed")
    print(f"PASS: 83 distinct languages; 82 targets for Japanese source")
    print(f"PASS: multi-account OAuth present; clean ZIP with {len(safe)} files")
    print(f"File: {output.name} ({output.stat().st_size:,} bytes)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
