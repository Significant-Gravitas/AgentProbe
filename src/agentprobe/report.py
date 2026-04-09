from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Environment, select_autoescape

from .db import DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME, get_run, list_runs
from .errors import AgentProbeRuntimeError

_ENV = Environment(
    autoescape=select_autoescape(default=True),
    trim_blocks=True,
    lstrip_blocks=True,
)


def _pretty_json(value: object) -> str:
    if value in (None, "", [], {}):
        return ""
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)


def _db_url_for_path(path: Path) -> str:
    return f"sqlite:///{path.expanduser().resolve()}"


def _discover_db_urls(search_root: Path | None = None) -> list[str]:
    root = (search_root or Path.cwd()).expanduser().resolve()
    candidates: list[Path] = []

    direct = root / DEFAULT_DB_DIRNAME / DEFAULT_DB_FILENAME
    if direct.exists():
        candidates.append(direct)

    for path in root.rglob(DEFAULT_DB_FILENAME):
        if path.parent.name != DEFAULT_DB_DIRNAME:
            continue
        candidates.append(path)

    unique_paths: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_paths.append(resolved)

    return [_db_url_for_path(path) for path in unique_paths]


def _format_timestamp(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return "n/a"

    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return value

    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _timestamp_sort_key(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return float("-inf")

    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return float("-inf")
    return parsed.astimezone(timezone.utc).timestamp()


def _format_number(value: object) -> str:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return "n/a"


def _format_score(value: object) -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.2f}"
    return "n/a"


def _score_percent(value: object) -> int:
    if not isinstance(value, (int, float)):
        return 0
    return max(0, min(100, int(round(float(value) * 100))))


_CREDENTIAL_ERROR_PATTERNS = (
    "401",
    "403",
    "unauthorized",
    "authentication",
    "credential",
    "api key",
    "api_key",
    "apikey",
    "invalid key",
    "invalid token",
    "access denied",
    "permission denied",
    "token expired",
    "auth failed",
)


def _is_credential_error(error: object) -> bool:
    if not isinstance(error, dict):
        return False
    message = str(error.get("message", "")).lower()
    error_type = str(error.get("type", "")).lower()
    combined = f"{error_type} {message}"
    return any(pattern in combined for pattern in _CREDENTIAL_ERROR_PATTERNS)


def _status_tone(passed: object) -> str:
    if passed is True:
        return "success"
    if passed is False:
        return "danger"
    return "neutral"


def _status_label(passed: object) -> str:
    if passed is True:
        return "PASS"
    if passed is False:
        return "FAIL"
    return "PENDING"


def _role_tone(role: object) -> str:
    normalized = str(role or "").strip().lower()
    if normalized == "assistant":
        return "assistant"
    if normalized == "user":
        return "user"
    return "system"


def _role_label(role: object) -> str:
    normalized = str(role or "").strip().lower()
    if normalized == "assistant":
        return "Assistant"
    if normalized == "user":
        return "User"
    if normalized == "inject":
        return "Inject"
    if normalized == "checkpoint":
        return "Checkpoint"
    if normalized == "system":
        return "System"
    return normalized.capitalize() or "Unknown"


def _build_turn_rows(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    tool_calls_by_turn: dict[int, list[dict[str, Any]]] = {}
    for tool_call in scenario.get("tool_calls", []):
        turn_index = int(tool_call.get("turn_index", -1))
        tool_calls_by_turn.setdefault(turn_index, []).append(
            {
                **tool_call,
                "args_pretty": _pretty_json(tool_call.get("args")),
                "raw_pretty": _pretty_json(tool_call.get("raw")),
            }
        )

    target_events_by_turn: dict[int, list[dict[str, Any]]] = {}
    for event in scenario.get("target_events", []):
        turn_index = int(event.get("turn_index", -1))
        target_events_by_turn.setdefault(turn_index, []).append(
            {
                **event,
                "raw_exchange_pretty": _pretty_json(event.get("raw_exchange")),
                "usage_pretty": _pretty_json(event.get("usage")),
            }
        )

    checkpoints_by_turn: dict[int | None, list[dict[str, Any]]] = {}
    for checkpoint in scenario.get("checkpoints", []):
        preceding_turn_index = checkpoint.get("preceding_turn_index")
        key = (
            int(preceding_turn_index) if isinstance(preceding_turn_index, int) else None
        )
        checkpoints_by_turn.setdefault(key, []).append(
            {
                **checkpoint,
                "tone": _status_tone(checkpoint.get("passed")),
                "assertions_pretty": _pretty_json(checkpoint.get("assertions")),
            }
        )

    rows: list[dict[str, Any]] = []
    for turn in scenario.get("turns", []):
        turn_index = int(turn.get("turn_index", -1))
        rows.append(
            {
                **turn,
                "created_at_label": _format_timestamp(turn.get("created_at")),
                "role_label": _role_label(turn.get("role")),
                "tone": _role_tone(turn.get("role")),
                "tool_calls": tool_calls_by_turn.get(turn_index, []),
                "target_events": target_events_by_turn.get(turn_index, []),
                "checkpoints": checkpoints_by_turn.get(turn_index, []),
                "usage_pretty": _pretty_json(turn.get("usage")),
            }
        )

    leading = checkpoints_by_turn.get(None, [])
    if leading:
        rows.insert(
            0,
            {
                "turn_index": -1,
                "role_label": "Checkpoint",
                "tone": "system",
                "content": None,
                "created_at_label": "n/a",
                "tool_calls": [],
                "target_events": [],
                "checkpoints": leading,
                "usage_pretty": "",
            },
        )

    return rows


def _build_dimension_rows(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dimension in scenario.get("judge_dimension_scores", []):
        normalized_score = dimension.get("normalized_score")
        raw_score = dimension.get("raw_score")
        scale_points = dimension.get("scale_points")
        rows.append(
            {
                **dimension,
                "percent": _score_percent(normalized_score),
                "raw_score_label": _format_number(raw_score),
                "scale_points_label": _format_number(scale_points),
                "weight_label": _format_number(dimension.get("weight")),
            }
        )
    return rows


def _prepare_scenario_view(scenario: dict[str, Any], index: int) -> dict[str, Any]:
    overall_score = scenario.get("overall_score")
    pass_threshold = scenario.get("pass_threshold")
    judge = scenario.get("judge") or {}
    error = scenario.get("error")

    tags = scenario.get("tags") or []

    return {
        **scenario,
        "index": index,
        "dom_id": f"scenario-{index}",
        "nav_label": f"{index + 1}. {scenario.get('scenario_name') or scenario.get('scenario_id')}",
        "status_label": _status_label(scenario.get("passed")),
        "status_tone": _status_tone(scenario.get("passed")),
        "is_credential_error": _is_credential_error(error),
        "tags": tags,
        "tags_csv": ",".join(str(t) for t in tags),
        "score_label": _format_score(overall_score),
        "score_percent": _score_percent(overall_score),
        "threshold_label": _format_score(pass_threshold),
        "threshold_percent": _score_percent(pass_threshold),
        "turn_rows": _build_turn_rows(scenario),
        "dimension_rows": _build_dimension_rows(scenario),
        "overall_notes": str(judge.get("overall_notes") or ""),
        "judge_output_pretty": _pretty_json(judge.get("output")),
        "error_pretty": _pretty_json(error),
        "expectations_pretty": _pretty_json(scenario.get("expectations")),
        "scenario_snapshot_pretty": _pretty_json(scenario.get("scenario_snapshot")),
        "started_at_label": _format_timestamp(scenario.get("started_at")),
        "completed_at_label": _format_timestamp(scenario.get("completed_at")),
    }


def _prepare_run_view(run: dict[str, Any]) -> dict[str, Any]:
    scenarios = [
        _prepare_scenario_view(scenario, index)
        for index, scenario in enumerate(run.get("scenarios", []))
    ]
    aggregate_counts = run.get("aggregate_counts") or {}

    credential_error_count = sum(
        1 for s in run.get("scenarios", []) if _is_credential_error(s.get("error"))
    )

    all_tags: list[str] = []
    seen_tags: set[str] = set()
    for s in scenarios:
        for tag in s.get("tags") or []:
            if tag not in seen_tags:
                seen_tags.add(tag)
                all_tags.append(tag)

    return {
        **run,
        "scenarios": scenarios,
        "all_tags": sorted(all_tags),
        "run_id_short": str(run.get("run_id", ""))[:8],
        "started_at_label": _format_timestamp(run.get("started_at")),
        "completed_at_label": _format_timestamp(run.get("completed_at")),
        "source_paths_pretty": _pretty_json(run.get("source_paths")),
        "endpoint_snapshot_pretty": _pretty_json(run.get("endpoint_snapshot")),
        "scenario_total": aggregate_counts.get("scenario_total", 0),
        "scenario_passed_count": aggregate_counts.get("scenario_passed_count", 0),
        "scenario_failed_count": aggregate_counts.get("scenario_failed_count", 0),
        "scenario_errored_count": aggregate_counts.get("scenario_errored_count", 0),
        "credential_error_count": credential_error_count,
    }


_ENV.filters["prettyjson"] = _pretty_json


_TEMPLATE = _ENV.from_string(
    """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentProbe Report {{ run.run_id }}</title>
    <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
              body: ["IBM Plex Sans", "ui-sans-serif", "system-ui"]
            },
            colors: {
              report: {
                sand: "#f5f0e8",
                ink: "#111827",
                moss: "#2f6a4f",
                ember: "#b74d2c",
                gold: "#d4a84f",
                slate: "#30475e"
              }
            },
            boxShadow: {
              panel: "0 24px 60px rgba(17, 24, 39, 0.12)"
            }
          }
        }
      };
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap"
      rel="stylesheet"
    />
    <style>
      body {
        background:
          radial-gradient(circle at top left, rgba(212, 168, 79, 0.18), transparent 28rem),
          radial-gradient(circle at top right, rgba(47, 106, 79, 0.16), transparent 26rem),
          linear-gradient(180deg, #fcfbf7 0%, #f4efe6 100%);
      }
      .report-grid {
        background-image:
          linear-gradient(rgba(17, 24, 39, 0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(17, 24, 39, 0.04) 1px, transparent 1px);
        background-size: 28px 28px;
      }
    </style>
  </head>
  <body class="report-grid min-h-screen font-body text-report-ink">
    <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header class="overflow-hidden rounded-[2rem] border border-black/10 bg-white/80 shadow-panel backdrop-blur">
        <div class="grid gap-8 px-6 py-8 lg:grid-cols-[1.5fr,1fr] lg:px-8">
          <div class="space-y-4">
            <div class="inline-flex items-center gap-2 rounded-full border border-black/10 bg-report-sand/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-report-slate">
              AgentProbe Run Report
            </div>
            <div>
              <h1 class="font-display text-4xl font-bold tracking-tight text-report-ink">
                Run {{ run.run_id_short }}
              </h1>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-black/65">
                Inspect the recorded conversation, tool activity, and rubric breakdown for every scenario in this run.
              </p>
            </div>
            <dl class="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Status</dt>
                <dd class="mt-1 font-semibold">{{ run.status }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Started</dt>
                <dd class="mt-1 font-semibold">{{ run.started_at_label }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Completed</dt>
                <dd class="mt-1 font-semibold">{{ run.completed_at_label }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Preset</dt>
                <dd class="mt-1 font-semibold">{{ run.preset or "custom" }}</dd>
              </div>
            </dl>
          </div>
          <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <div class="rounded-[1.5rem] border border-emerald-950/10 bg-report-moss px-5 py-5 text-white">
              <div class="text-xs uppercase tracking-[0.24em] text-white/70">Passed</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_passed_count }}</div>
            </div>
            <div class="rounded-[1.5rem] border border-amber-950/10 bg-report-gold px-5 py-5 text-report-ink">
              <div class="text-xs uppercase tracking-[0.24em] text-black/55">Failed</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_failed_count }}</div>
              {% if run.credential_error_count > 0 %}
              <div class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/10 px-2.5 py-1 text-xs font-semibold text-report-ember">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                {{ run.credential_error_count }} credential
              </div>
              {% endif %}
            </div>
            <div class="rounded-[1.5rem] border border-rose-950/10 bg-report-ember px-5 py-5 text-white">
              <div class="text-xs uppercase tracking-[0.24em] text-white/70">Errored</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_errored_count }}</div>
              {% if run.credential_error_count > 0 %}
              <div class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                {{ run.credential_error_count }} credential
              </div>
              {% endif %}
            </div>
          </div>
        </div>
      </header>

      <div class="mt-8 grid gap-8 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <aside class="space-y-5">
          <section class="rounded-[1.75rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur">
            <h2 class="font-display text-lg font-bold">Scenarios</h2>
            <div class="mt-4 space-y-3">
              <input
                id="scenario-search"
                type="text"
                placeholder="Search scenarios..."
                class="w-full rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 text-sm outline-none transition placeholder:text-black/40 focus:border-black/25 focus:bg-white"
              />
              {% if run.all_tags %}
              <select
                id="scenario-tag-filter"
                class="w-full rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 text-sm outline-none transition focus:border-black/25 focus:bg-white"
              >
                <option value="">All tags</option>
                {% for tag in run.all_tags %}
                <option value="{{ tag }}">{{ tag }}</option>
                {% endfor %}
              </select>
              {% endif %}
            </div>
            <div id="scenario-list" class="mt-4 space-y-3">
              {% for scenario in run.scenarios %}
              <button
                type="button"
                data-scenario-button="{{ scenario.dom_id }}"
                data-scenario-tags="{{ scenario.tags_csv }}"
                data-scenario-name="{{ scenario.nav_label|lower }}"
                data-persona="{{ scenario.persona_id|lower }}"
                data-rubric="{{ scenario.rubric_id|lower }}"
                class="scenario-nav w-full rounded-2xl border border-black/10 bg-black/[0.03] px-4 py-3 text-left transition hover:border-black/20 hover:bg-black/[0.05]"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold scenario-label">{{ scenario.nav_label }}</div>
                    <div class="mt-1 text-xs scenario-meta text-black/55">{{ scenario.persona_id }} • {{ scenario.rubric_id }}</div>
                  </div>
                  <div data-tone="{{ scenario.status_tone }}" class="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] scenario-badge
                    {% if scenario.status_tone == 'success' %}
                      bg-emerald-100 text-emerald-800
                    {% elif scenario.status_tone == 'danger' %}
                      bg-rose-100 text-rose-800
                    {% else %}
                      bg-slate-100 text-slate-700
                    {% endif %}
                  ">
                    {{ scenario.status_label }}
                  </div>
                </div>
                {% if scenario.is_credential_error %}
                <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                  Credential error
                </div>
                {% endif %}
                <div class="mt-3">
                  <div class="flex items-center justify-between text-xs scenario-score text-black/55">
                    <span>Score</span>
                    <span>{{ scenario.score_label }}</span>
                  </div>
                  <div class="mt-2 h-2 rounded-full bg-black/10">
                    <div
                      class="h-2 rounded-full {% if scenario.status_tone == 'success' %}bg-report-moss{% elif scenario.status_tone == 'danger' %}bg-report-ember{% else %}bg-report-slate{% endif %}"
                      style="width: {{ scenario.score_percent }}%"
                    ></div>
                  </div>
                </div>
              </button>
              {% endfor %}
            </div>
            <div id="scenario-no-results" class="mt-4 hidden text-center text-sm text-black/45">No matching scenarios</div>
          </section>

          <section class="rounded-[1.75rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur">
            <h2 class="font-display text-lg font-bold">Run Metadata</h2>
            <div class="mt-4 space-y-4 text-sm">
              <div>
                <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Sources</div>
                <pre class="mt-2 overflow-x-auto rounded-2xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ run.source_paths_pretty }}</pre>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Endpoint Snapshot</div>
                <pre class="mt-2 max-h-72 overflow-auto rounded-2xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ run.endpoint_snapshot_pretty }}</pre>
              </div>
            </div>
          </section>
        </aside>

        <main>
          {% for scenario in run.scenarios %}
          <section
            data-scenario-panel="{{ scenario.dom_id }}"
            class="scenario-panel rounded-[2rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur sm:p-6"
          >
            <div class="space-y-5">
              <button
                type="button"
                data-open-tab="rubric"
                data-scenario-open="{{ scenario.dom_id }}"
                class="block w-full overflow-hidden rounded-[1.75rem] border border-black/10 bg-gradient-to-r px-5 py-5 text-left transition hover:shadow-lg
                  {% if scenario.status_tone == 'success' %}
                    from-report-moss to-emerald-500 text-white
                  {% elif scenario.status_tone == 'danger' %}
                    from-report-ember to-orange-500 text-white
                  {% else %}
                    from-report-slate to-slate-500 text-white
                  {% endif %}
                "
              >
                <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <div class="text-xs font-semibold uppercase tracking-[0.26em] text-white/70">Score Header</div>
                    <h2 class="mt-2 font-display text-3xl font-bold">{{ scenario.scenario_name }}</h2>
                    <p class="mt-2 max-w-3xl text-sm text-white/80">
                      Click this score bar to open the rubric tab and inspect the dimension-by-dimension scoring breakdown.
                    </p>
                  </div>
                  <div class="flex flex-wrap items-end gap-6">
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Overall</div>
                      <div class="mt-2 font-display text-4xl font-bold">{{ scenario.score_label }}</div>
                    </div>
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Threshold</div>
                      <div class="mt-2 text-lg font-semibold">{{ scenario.threshold_label }}</div>
                    </div>
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Status</div>
                      <div class="mt-2 text-lg font-semibold">{{ scenario.status_label }}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-5 h-3 rounded-full bg-white/20">
                  <div class="h-3 rounded-full bg-white" style="width: {{ scenario.score_percent }}%"></div>
                </div>
              </button>

              <div class="flex flex-wrap gap-3 border-b border-black/10 pb-4">
                <button
                  type="button"
                  data-tab-button="conversation"
                  data-tab-scenario="{{ scenario.dom_id }}"
                  class="scenario-tab rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-black/20"
                >
                  Conversation
                </button>
                <button
                  type="button"
                  data-tab-button="rubric"
                  data-tab-scenario="{{ scenario.dom_id }}"
                  class="scenario-tab rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-black/20"
                >
                  Rubric
                </button>
              </div>

              <div data-tab-panel="conversation" data-tab-scenario="{{ scenario.dom_id }}" class="tab-panel space-y-4">
                <div class="grid gap-4 md:grid-cols-3">
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Started</div>
                    <div class="mt-2 text-sm font-semibold">{{ scenario.started_at_label }}</div>
                  </div>
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Completed</div>
                    <div class="mt-2 text-sm font-semibold">{{ scenario.completed_at_label }}</div>
                  </div>
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Counts</div>
                    <div class="mt-2 text-sm font-semibold">
                      {{ scenario.counts.turn_count }} turns • {{ scenario.counts.tool_call_count }} tool calls • {{ scenario.counts.checkpoint_count }} checkpoints
                    </div>
                  </div>
                </div>

                {% if scenario.expectations_pretty %}
                <details class="rounded-2xl border border-black/10 bg-report-sand/70 p-4">
                  <summary class="cursor-pointer text-sm font-semibold">Scenario Expectations</summary>
                  <pre class="mt-3 overflow-x-auto text-xs leading-5 text-black/70">{{ scenario.expectations_pretty }}</pre>
                </details>
                {% endif %}

                <div class="space-y-4">
                  {% for turn in scenario.turn_rows %}
                  <article class="rounded-[1.5rem] border border-black/10 p-4
                    {% if turn.tone == 'assistant' %}
                      bg-emerald-50/70
                    {% elif turn.tone == 'user' %}
                      bg-sky-50/80
                    {% else %}
                      bg-white
                    {% endif %}
                  ">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="flex items-center gap-3">
                        <span class="rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em]
                          {% if turn.tone == 'assistant' %}
                            bg-emerald-100 text-emerald-800
                          {% elif turn.tone == 'user' %}
                            bg-sky-100 text-sky-800
                          {% else %}
                            bg-stone-100 text-stone-700
                          {% endif %}
                        ">
                          {{ turn.role_label }}
                        </span>
                        {% if turn.source %}
                        <span class="text-xs text-black/45">{{ turn.source }}</span>
                        {% endif %}
                      </div>
                      <div class="text-xs text-black/45">Turn {{ turn.turn_index if turn.turn_index >= 0 else "–" }} • {{ turn.created_at_label }}</div>
                    </div>

                    {% if turn.content %}
                    <div class="mt-4 whitespace-pre-wrap text-sm leading-7 text-black/80">{{ turn.content }}</div>
                    {% endif %}

                    {% if turn.tool_calls %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Tool Calls</div>
                      {% for tool in turn.tool_calls %}
                      <div class="rounded-2xl border border-black/10 bg-white/80 p-4">
                        <div class="flex items-center justify-between gap-3">
                          <div class="font-semibold">{{ tool.name }}</div>
                          <div class="text-xs text-black/45">Order {{ tool.call_order or "n/a" }}</div>
                        </div>
                        {% if tool.args_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ tool.args_pretty }}</pre>
                        {% endif %}
                        {% if tool.raw_pretty %}
                        <details class="mt-3">
                          <summary class="cursor-pointer text-xs font-semibold text-black/55">Raw tool record</summary>
                          <pre class="mt-2 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ tool.raw_pretty }}</pre>
                        </details>
                        {% endif %}
                      </div>
                      {% endfor %}
                    </div>
                    {% endif %}

                    {% if turn.checkpoints %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Checkpoints</div>
                      {% for checkpoint in turn.checkpoints %}
                      <div class="rounded-2xl border p-4
                        {% if checkpoint.tone == 'success' %}
                          border-emerald-200 bg-emerald-50
                        {% elif checkpoint.tone == 'danger' %}
                          border-rose-200 bg-rose-50
                        {% else %}
                          border-black/10 bg-white/70
                        {% endif %}
                      ">
                        <div class="flex items-center justify-between gap-3">
                          <div class="font-semibold">Checkpoint {{ checkpoint.checkpoint_index }}</div>
                          <div class="text-xs font-semibold uppercase tracking-[0.2em]">{{ "PASS" if checkpoint.passed else "FAIL" }}</div>
                        </div>
                        {% if checkpoint.failures %}
                        <div class="mt-3 space-y-2">
                          {% for failure in checkpoint.failures %}
                          <div class="rounded-xl bg-white/80 px-3 py-2 text-sm text-black/75">{{ failure }}</div>
                          {% endfor %}
                        </div>
                        {% endif %}
                        {% if checkpoint.assertions_pretty %}
                        <details class="mt-3">
                          <summary class="cursor-pointer text-xs font-semibold text-black/55">Assertions</summary>
                          <pre class="mt-2 overflow-x-auto rounded-xl bg-white/80 p-3 text-xs leading-5 text-black/70">{{ checkpoint.assertions_pretty }}</pre>
                        </details>
                        {% endif %}
                      </div>
                      {% endfor %}
                    </div>
                    {% endif %}

                    {% if turn.target_events %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Target Exchanges</div>
                      {% for event in turn.target_events %}
                      <details class="rounded-2xl border border-black/10 bg-white/75 p-4">
                        <summary class="cursor-pointer text-sm font-semibold">
                          Exchange {{ event.exchange_index }} • {{ event.latency_ms or "n/a" }} ms
                        </summary>
                        {% if event.usage_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ event.usage_pretty }}</pre>
                        {% endif %}
                        {% if event.raw_exchange_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ event.raw_exchange_pretty }}</pre>
                        {% endif %}
                      </details>
                      {% endfor %}
                    </div>
                    {% endif %}
                  </article>
                  {% endfor %}
                </div>
              </div>

              <div data-tab-panel="rubric" data-tab-scenario="{{ scenario.dom_id }}" class="tab-panel hidden space-y-5">
                <div class="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
                  <section class="rounded-[1.5rem] border border-black/10 bg-report-sand/70 p-5">
                    <div class="text-xs font-semibold uppercase tracking-[0.24em] text-black/45">Overall Notes</div>
                    {% if scenario.overall_notes %}
                    <div class="mt-3 whitespace-pre-wrap text-sm leading-7 text-black/75">{{ scenario.overall_notes }}</div>
                    {% else %}
                    <div class="mt-3 text-sm text-black/55">No overall notes were recorded.</div>
                    {% endif %}
                  </section>
                  <section class="rounded-[1.5rem] border border-black/10 bg-black/[0.03] p-5">
                    <div class="text-xs font-semibold uppercase tracking-[0.24em] text-black/45">Judge</div>
                    <div class="mt-3 space-y-2 text-sm text-black/70">
                      <div><span class="font-semibold text-black/80">Provider:</span> {{ scenario.judge.provider or "n/a" }}</div>
                      <div><span class="font-semibold text-black/80">Model:</span> {{ scenario.judge.model or "n/a" }}</div>
                      <div><span class="font-semibold text-black/80">Temperature:</span> {{ scenario.judge.temperature if scenario.judge.temperature is not none else "n/a" }}</div>
                      <div><span class="font-semibold text-black/80">Max Tokens:</span> {{ scenario.judge.max_tokens if scenario.judge.max_tokens is not none else "n/a" }}</div>
                    </div>
                  </section>
                </div>

                {% if scenario.dimension_rows %}
                <div class="grid gap-4 lg:grid-cols-2">
                  {% for dimension in scenario.dimension_rows %}
                  <section class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <h3 class="font-display text-xl font-bold">{{ dimension.dimension_name }}</h3>
                        <div class="mt-1 text-xs uppercase tracking-[0.2em] text-black/45">{{ dimension.dimension_id }}</div>
                      </div>
                      <div class="text-right">
                        <div class="font-display text-2xl font-bold">{{ dimension.raw_score_label }}{% if dimension.scale_points %}/{{ dimension.scale_points_label }}{% endif %}</div>
                        <div class="text-xs text-black/45">Weight {{ dimension.weight_label }}</div>
                      </div>
                    </div>
                    <div class="mt-4 h-3 rounded-full bg-black/10">
                      <div class="h-3 rounded-full bg-report-slate" style="width: {{ dimension.percent }}%"></div>
                    </div>
                    <div class="mt-4 whitespace-pre-wrap text-sm leading-7 text-black/75">{{ dimension.reasoning }}</div>
                    {% if dimension.evidence %}
                    <div class="mt-4 space-y-2">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Evidence</div>
                      {% for item in dimension.evidence %}
                      <div class="rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-black/75">{{ item }}</div>
                      {% endfor %}
                    </div>
                    {% endif %}
                  </section>
                  {% endfor %}
                </div>
                {% else %}
                <section class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                  <div class="text-sm text-black/60">No rubric dimension scores were recorded for this scenario.</div>
                </section>
                {% endif %}

                {% if scenario.error_pretty %}
                <details class="rounded-[1.5rem] border border-rose-200 bg-rose-50 p-5">
                  <summary class="cursor-pointer text-sm font-semibold text-rose-800">Scenario Error</summary>
                  <pre class="mt-3 overflow-x-auto rounded-xl bg-white/80 p-3 text-xs leading-5 text-rose-900">{{ scenario.error_pretty }}</pre>
                </details>
                {% endif %}

                {% if scenario.judge_output_pretty %}
                <details class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                  <summary class="cursor-pointer text-sm font-semibold">Raw Judge Output</summary>
                  <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ scenario.judge_output_pretty }}</pre>
                </details>
                {% endif %}
              </div>
            </div>
          </section>
          {% endfor %}
        </main>
      </div>
    </div>

    <script>
      const scenarioButtons = [...document.querySelectorAll("[data-scenario-button]")];
      const scenarioPanels = [...document.querySelectorAll("[data-scenario-panel]")];
      const tabButtons = [...document.querySelectorAll("[data-tab-button]")];
      const tabPanels = [...document.querySelectorAll("[data-tab-panel]")];
      const scoreOpeners = [...document.querySelectorAll("[data-open-tab]")];
      const defaultScenario = scenarioPanels[0]?.dataset.scenarioPanel;

      const searchInput = document.getElementById("scenario-search");
      const tagFilter = document.getElementById("scenario-tag-filter");
      const noResults = document.getElementById("scenario-no-results");

      function updateScenarioNav(activeScenario) {
        scenarioButtons.forEach((button) => {
          const active = button.dataset.scenarioButton === activeScenario;
          button.classList.toggle("bg-report-ink", active);
          button.classList.toggle("text-white", active);
          button.classList.toggle("border-transparent", active);
          button.classList.toggle("shadow-lg", active);

          /* Fix child text visibility when selected */
          button.querySelectorAll(".scenario-meta, .scenario-score").forEach((el) => {
            el.classList.toggle("text-black/55", !active);
            el.classList.toggle("text-white/70", active);
          });
          button.querySelectorAll(".scenario-label").forEach((el) => {
            el.classList.toggle("text-white", active);
          });
          button.querySelectorAll(".scenario-badge").forEach((el) => {
            if (active) {
              el.classList.add("bg-white/20", "text-white");
              el.classList.remove("bg-emerald-100", "text-emerald-800", "bg-rose-100", "text-rose-800", "bg-slate-100", "text-slate-700");
            } else {
              el.classList.remove("bg-white/20", "text-white");
              /* Restore original badge colors from data attribute */
              const tone = el.dataset.tone;
              if (tone === "success") { el.classList.add("bg-emerald-100", "text-emerald-800"); }
              else if (tone === "danger") { el.classList.add("bg-rose-100", "text-rose-800"); }
              else { el.classList.add("bg-slate-100", "text-slate-700"); }
            }
          });
        });
      }

      function updateScenarioPanels(activeScenario) {
        scenarioPanels.forEach((panel) => {
          panel.classList.toggle("hidden", panel.dataset.scenarioPanel !== activeScenario);
        });
      }

      function setTab(activeScenario, activeTab) {
        tabButtons.forEach((button) => {
          const active =
            button.dataset.tabScenario === activeScenario &&
            button.dataset.tabButton === activeTab;
          button.classList.toggle("bg-report-ink", active);
          button.classList.toggle("text-white", active);
          button.classList.toggle("border-transparent", active);
        });

        tabPanels.forEach((panel) => {
          const active =
            panel.dataset.tabScenario === activeScenario &&
            panel.dataset.tabPanel === activeTab;
          panel.classList.toggle("hidden", !active);
        });
      }

      function setScenario(activeScenario, preferredTab = "conversation") {
        updateScenarioNav(activeScenario);
        updateScenarioPanels(activeScenario);
        setTab(activeScenario, preferredTab);
      }

      /* Search and tag filter */
      function filterScenarios() {
        const query = (searchInput?.value || "").toLowerCase().trim();
        const selectedTag = tagFilter?.value || "";
        let visibleCount = 0;

        scenarioButtons.forEach((button) => {
          const name = button.dataset.scenarioName || "";
          const persona = button.dataset.persona || "";
          const rubric = button.dataset.rubric || "";
          const tags = button.dataset.scenarioTags || "";

          const matchesSearch = !query ||
            name.includes(query) ||
            persona.includes(query) ||
            rubric.includes(query) ||
            tags.toLowerCase().includes(query);

          const matchesTag = !selectedTag ||
            tags.split(",").includes(selectedTag);

          const visible = matchesSearch && matchesTag;
          button.classList.toggle("hidden", !visible);
          if (visible) visibleCount++;
        });

        if (noResults) {
          noResults.classList.toggle("hidden", visibleCount > 0);
        }
      }

      if (searchInput) searchInput.addEventListener("input", filterScenarios);
      if (tagFilter) tagFilter.addEventListener("change", filterScenarios);

      scenarioButtons.forEach((button) => {
        button.addEventListener("click", () => setScenario(button.dataset.scenarioButton));
      });

      tabButtons.forEach((button) => {
        button.addEventListener("click", () => {
          setScenario(button.dataset.tabScenario, button.dataset.tabButton);
        });
      });

      scoreOpeners.forEach((button) => {
        button.addEventListener("click", () => {
          setScenario(button.dataset.scenarioOpen, button.dataset.openTab);
        });
      });

      if (defaultScenario) {
        setScenario(defaultScenario, "conversation");
      }
    </script>
  </body>
</html>
"""
)


def render_run_report(run: dict[str, Any]) -> str:
    return _TEMPLATE.render(run=_prepare_run_view(run))


def resolve_run_id(run_id: str | None, *, db_url: str | None = None) -> str:
    if db_url is None:
        raise AgentProbeRuntimeError("resolve_run_id() requires an explicit db_url.")

    if isinstance(run_id, str) and run_id.strip():
        return run_id.strip()

    runs = list_runs(db_url=db_url, limit=1)
    if not runs:
        raise AgentProbeRuntimeError("No recorded runs were found.")

    latest_run_id = runs[0].get("run_id")
    if not isinstance(latest_run_id, str) or not latest_run_id:
        raise AgentProbeRuntimeError("The latest recorded run is missing a run_id.")
    return latest_run_id


def _load_run_from_discovered_dbs(run_id: str | None = None) -> dict[str, Any]:
    db_urls = _discover_db_urls()
    if not db_urls:
        raise AgentProbeRuntimeError("No recorded runs were found.")

    if isinstance(run_id, str) and run_id.strip():
        for candidate_db_url in db_urls:
            run = get_run(run_id.strip(), include_trace=True, db_url=candidate_db_url)
            if run is not None:
                return run
        raise AgentProbeRuntimeError(f"Run `{run_id.strip()}` was not found.")

    latest_summary: dict[str, Any] | None = None
    latest_db_url: str | None = None
    latest_started_at = float("-inf")

    for candidate_db_url in db_urls:
        summaries = list_runs(db_url=candidate_db_url, limit=1)
        if not summaries:
            continue
        summary = summaries[0]
        started_at = _timestamp_sort_key(summary.get("started_at"))
        if started_at > latest_started_at:
            latest_summary = summary
            latest_db_url = candidate_db_url
            latest_started_at = started_at

    if latest_summary is None or latest_db_url is None:
        raise AgentProbeRuntimeError("No recorded runs were found.")

    latest_run_id = latest_summary.get("run_id")
    if not isinstance(latest_run_id, str) or not latest_run_id:
        raise AgentProbeRuntimeError("The latest recorded run is missing a run_id.")

    run = get_run(latest_run_id, include_trace=True, db_url=latest_db_url)
    if run is None:
        raise AgentProbeRuntimeError(f"Run `{latest_run_id}` was not found.")
    return run


def load_run_report_data(
    run_id: str | None = None, *, db_url: str | None = None
) -> dict[str, Any]:
    if db_url is None:
        return _load_run_from_discovered_dbs(run_id)

    resolved_run_id = resolve_run_id(run_id, db_url=db_url)
    run = get_run(resolved_run_id, include_trace=True, db_url=db_url)
    if run is None:
        raise AgentProbeRuntimeError(f"Run `{resolved_run_id}` was not found.")
    return run


def write_run_report(
    run_id: str | None = None,
    *,
    output_path: str | Path | None = None,
    db_url: str | None = None,
) -> Path:
    run = load_run_report_data(run_id, db_url=db_url)
    resolved_output = (
        Path(output_path).expanduser().resolve()
        if output_path is not None
        else (Path.cwd() / f"agentprobe-report-{run['run_id']}.html").resolve()
    )
    resolved_output.parent.mkdir(parents=True, exist_ok=True)
    resolved_output.write_text(render_run_report(run), encoding="utf-8")
    return resolved_output


__all__ = [
    "load_run_report_data",
    "render_run_report",
    "resolve_run_id",
    "write_run_report",
]
