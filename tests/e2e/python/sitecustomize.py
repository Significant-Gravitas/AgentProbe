from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

SCRIPT_PATH = os.getenv("AGENTPROBE_E2E_OPENAI_SCRIPT", "").strip()
LOG_PATH = os.getenv("AGENTPROBE_E2E_OPENAI_LOG", "").strip()


def _normalize_json(value: object) -> object:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): _normalize_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_json(item) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _normalize_json(model_dump())
    if hasattr(value, "__dict__"):
        return _normalize_json(vars(value))
    return repr(value)


def _load_rules() -> list[dict[str, Any]]:
    if not SCRIPT_PATH:
        return []
    payload = json.loads(Path(SCRIPT_PATH).read_text(encoding="utf-8"))
    rules = payload.get("rules", [])
    return rules if isinstance(rules, list) else []


def _append_log(record: dict[str, object]) -> None:
    if not LOG_PATH:
        return
    path = Path(LOG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")


if SCRIPT_PATH or LOG_PATH:
    import openai

    _RULES = _load_rules()

    def _match_rule(kwargs: dict[str, object]) -> dict[str, Any]:
        text = kwargs.get("text")
        format_name = ""
        if isinstance(text, dict):
            format_payload = text.get("format")
            if isinstance(format_payload, dict):
                raw_name = format_payload.get("name")
                if isinstance(raw_name, str):
                    format_name = raw_name

        input_text = str(kwargs.get("input", ""))
        instructions_text = str(kwargs.get("instructions", ""))

        for rule in _RULES:
            if str(rule.get("kind", "")) != format_name:
                continue

            input_contains = rule.get("inputContains", [])
            if isinstance(input_contains, list) and any(
                str(needle) not in input_text for needle in input_contains
            ):
                continue

            instructions_contains = rule.get("instructionsContains", [])
            if isinstance(instructions_contains, list) and any(
                str(needle) not in instructions_text for needle in instructions_contains
            ):
                continue

            return rule

        raise RuntimeError(
            "No fake OpenAI response matched the request. "
            f"kind={format_name!r} input={input_text!r}"
        )

    class _FakeResponsesAPI:
        def __init__(self, client_kwargs: dict[str, object]) -> None:
            self._client_kwargs = client_kwargs

        async def create(self, **kwargs: object) -> SimpleNamespace:
            request_kwargs = dict(kwargs)
            rule = _match_rule(request_kwargs)
            text = request_kwargs.get("text")
            format_payload: dict[str, object] = {}
            if isinstance(text, dict):
                raw_format = text.get("format")
                if isinstance(raw_format, dict):
                    format_payload = raw_format
            _append_log(
                {
                    "kind": str(format_payload.get("name", "")),
                    "matched_rule": str(rule.get("name", "")),
                    "model": str(request_kwargs.get("model", "")) or None,
                    "input": str(request_kwargs.get("input", "")),
                    "client_kwargs": _normalize_json(self._client_kwargs),
                    "request": _normalize_json(request_kwargs),
                }
            )
            output = rule.get("output")
            if isinstance(output, str):
                payload = output
            else:
                payload = json.dumps(_normalize_json(output))
            return SimpleNamespace(output_text=payload)

    class _FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            self._client_kwargs = dict(kwargs)
            self.responses = _FakeResponsesAPI(self._client_kwargs)

        async def __aenter__(self) -> "_FakeAsyncClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

    openai.AsyncClient = _FakeAsyncClient
