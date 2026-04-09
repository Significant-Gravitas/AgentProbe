#!/usr/bin/env python3
"""Validates relative markdown links in docs/ and AGENTS.md."""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

errors = 0


def check_file(file_path: Path) -> None:
    global errors
    content = file_path.read_text()
    for match in LINK_RE.finditer(content):
        target = match.group(2)
        if target.startswith(("http", "#", "mailto:")):
            continue
        # Strip anchor
        target_path = target.split("#")[0]
        if not target_path:
            continue
        resolved = (file_path.parent / target_path).resolve()
        if not resolved.exists():
            print(f"BROKEN LINK: {file_path} -> {target}")
            errors += 1


def walk_md(directory: Path) -> None:
    for path in sorted(directory.rglob("*.md")):
        check_file(path)


walk_md(REPO_ROOT / "docs")

for name in ["AGENTS.md", "README.md"]:
    p = REPO_ROOT / name
    if p.exists():
        check_file(p)

if errors > 0:
    print(f"\n{errors} broken link(s) found.")
    sys.exit(1)
else:
    print("All doc links OK.")
