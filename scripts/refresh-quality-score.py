#!/usr/bin/env python3
"""Regenerates docs/QUALITY_SCORE.md from current repo state."""

from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def check(name: str, condition: bool) -> dict:
    return {
        "name": name,
        "status": "\U0001f7e2" if condition else "\U0001f7e1",
        "ok": condition,
    }


checks = [
    check("CI config", (REPO_ROOT / ".github" / "workflows").exists()),
    check(
        "Test suite",
        (REPO_ROOT / "tests").is_dir() and any((REPO_ROOT / "tests").glob("test_*.py")),
    ),
    check(
        "Behaviour spec", (REPO_ROOT / "docs" / "behaviours" / "platform.md").exists()
    ),
    check("AGENTS.md", (REPO_ROOT / "AGENTS.md").exists()),
    check("Harness doc", (REPO_ROOT / "docs" / "HARNESS.md").exists()),
]

date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
rows = "\n".join(
    f"| {c['name']:<18} | {c['status']}     | {'Present' if c['ok'] else 'Missing'} |"
    for c in checks
)

content = f"""# Quality Score

Last updated: {date}

## Health summary

| Area               | Status | Notes                     |
|--------------------|--------|---------------------------|
{rows}

## Incidents

_No incidents yet._

## Next cleanup targets

1. Expand test coverage
2. Fill out remaining behavior scenarios
3. Add integration tests for core paths
"""

(REPO_ROOT / "docs" / "QUALITY_SCORE.md").write_text(content)
print("Refreshed docs/QUALITY_SCORE.md")
