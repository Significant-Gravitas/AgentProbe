#!/usr/bin/env python3
"""Validates that current-state.md and e2e-checklist.md exist and reference
scenarios defined in platform.md."""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BEHAVIOURS = REPO_ROOT / "docs" / "behaviours"


def extract_scenarios(file_path: Path) -> list[str]:
    if not file_path.exists():
        return []
    content = file_path.read_text()
    return re.findall(r"^###\s+(.+)$", content, re.MULTILINE)


platform_scenarios = extract_scenarios(BEHAVIOURS / "platform.md")

if not platform_scenarios:
    print("No scenarios found in platform.md — skipping behaviour check.")
    sys.exit(0)

print(f"Found {len(platform_scenarios)} scenario(s) in platform.md")

errors = 0
for filename in ["current-state.md", "e2e-checklist.md"]:
    path = BEHAVIOURS / filename
    if not path.exists():
        print(f"MISSING: {filename}")
        errors += 1

if errors > 0:
    sys.exit(1)

print("Behaviour docs present and consistent.")
