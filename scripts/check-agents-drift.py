#!/usr/bin/env python3
"""Checks that the repo map in AGENTS.md reflects the actual directory structure."""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
agents_md = (REPO_ROOT / "AGENTS.md").read_text()

# Extract the repo map code block
map_match = re.search(r"```text\n([\s\S]*?)```", agents_md)
if not map_match:
    print("No repo map code block found in AGENTS.md — skipping drift check.")
    sys.exit(0)

map_text = map_match.group(1)

# Match tree lines like "├── src/agentprobe/   # comment"
# Captures the path portion (e.g. "src/agentprobe/")
TREE_LINE_RE = re.compile(r"[│\s]*[├└]──\s+(\S+)")

errors = 0
for match in TREE_LINE_RE.finditer(map_text):
    entry = match.group(1).rstrip("/")
    if not entry or entry.startswith(".") or "#" in entry:
        continue
    if not (REPO_ROOT / entry).exists():
        print(f'DRIFT: AGENTS.md lists "{entry}/" but it does not exist')
        errors += 1

if errors > 0:
    print(f"\n{errors} drift issue(s). Update the repo map in AGENTS.md.")
    sys.exit(1)
else:
    print("AGENTS.md repo map matches directory structure.")
