"""Coverage for data/scenarios.py helpers (parse_time_offset, defaults injection)."""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from agentprobe.data.scenarios import parse_scenarios_input, parse_time_offset


def test_parse_time_offset_hours_days_minutes() -> None:
    assert parse_time_offset("0h") == timedelta()
    assert parse_time_offset("3h") == timedelta(hours=3)
    assert parse_time_offset("7d") == timedelta(days=7)
    assert parse_time_offset("15m") == timedelta(minutes=15)


def test_parse_time_offset_invalid_returns_zero() -> None:
    assert parse_time_offset("") == timedelta()
    assert parse_time_offset("not-a-duration") == timedelta()
    assert parse_time_offset("10y") == timedelta()


def test_parse_scenarios_input_applies_defaults_to_missing_context(tmp_path: Path) -> None:
    path = tmp_path / "scenarios.yaml"
    path.write_text(
        """
defaults:
  persona: p
  rubric: r
  user_name: Taylor
  copilot_mode: fast
scenarios:
  - id: without-ctx
    name: Without ctx
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
  - id: with-partial-ctx
    name: With partial ctx
    context:
      system_prompt: Keep it brief.
    turns:
      - {role: user, content: hi}
    expectations:
      expected_behavior: Help.
      expected_outcome: resolved
""".strip(),
        encoding="utf-8",
    )

    parsed = parse_scenarios_input(path)
    by_id = {s.id: s for s in parsed.scenarios}

    # Scenario without any context dict: defaults create a fresh context with
    # user_name and copilot_mode populated.
    first = by_id["without-ctx"]
    assert first.persona == "p"
    assert first.rubric == "r"
    assert first.context is not None
    assert first.context.user_name == "Taylor"
    assert first.context.copilot_mode == "fast"

    # Scenario that already has a context dict keeps its system_prompt and
    # picks up the defaulted user_name / copilot_mode.
    second = by_id["with-partial-ctx"]
    assert second.context is not None
    assert second.context.system_prompt == "Keep it brief."
    assert second.context.user_name == "Taylor"
    assert second.context.copilot_mode == "fast"
