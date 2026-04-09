#!/usr/bin/env python3
"""Generates a workspace inventory for mechanical repo-map verification.
Output: docs/generated/workspace-inventory.md"""

from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "docs" / "generated" / "workspace-inventory.md"

IGNORE = {
    ".git",
    "node_modules",
    ".local-data",
    "test-results",
    "dist",
    "build",
    ".venv",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    ".DS_Store",
}


def walk(directory: Path, depth: int = 0, max_depth: int = 3) -> list[dict]:
    if depth > max_depth:
        return []
    entries = []
    try:
        children = sorted(directory.iterdir(), key=lambda p: p.name)
    except PermissionError:
        return entries
    for child in children:
        if child.name in IGNORE or child.name.startswith("."):
            continue
        rel = child.relative_to(REPO_ROOT)
        if child.is_dir():
            entries.append({"path": str(rel) + "/", "type": "dir"})
            entries.extend(walk(child, depth + 1, max_depth))
        else:
            entries.append({"path": str(rel), "type": "file"})
    return entries


entries = walk(REPO_ROOT)
lines = [
    "# Workspace Inventory",
    "",
    f"Generated: {datetime.now(timezone.utc).isoformat()}",
    "",
    "```text",
    *[f"{'  ' if e['type'] == 'file' else ''}{e['path']}" for e in entries],
    "```",
    "",
]

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text("\n".join(lines))
print(f"Wrote {OUTPUT}")
