from __future__ import annotations

import json
from types import SimpleNamespace
from typing import cast

import openai
import pytest

from agentprobe.data.rubrics import (
    JudgeConfig,
    Rubric,
    RubricDimension,
    RubricScale,
    parse_rubrics_yaml,
)
from agentprobe.judge import (
    RubricScore,
    judge,
)


class FakeResponsesAPI:
    def __init__(self, parsed: RubricScore | None):
        self.calls: list[dict[str, object]] = []
        self._parsed = parsed

    async def create(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(kwargs)
        if self._parsed is None:
            return SimpleNamespace(output_text=None)
        return SimpleNamespace(
            output_text=json.dumps(self._parsed.model_dump(by_alias=True))
        )


class FakeClient:
    def __init__(self, parsed: RubricScore | None):
        self.responses = FakeResponsesAPI(parsed)


def build_rubric() -> Rubric:
    return Rubric(
        id="support",
        name="Support Rubric",
        pass_threshold=0.7,
        meta_prompt="Score the assistant response.",
        judge=JudgeConfig(
            provider="openai",
            model="anthropic/claude-opus-4.6",
            temperature=0.15,
            max_tokens=321,
        ),
        dimensions=[
            RubricDimension(
                id="accuracy",
                name="Accuracy",
                weight=1.0,
                scale=RubricScale(
                    type="likert", points=5, labels={1: "bad", 5: "good"}
                ),
                judge_prompt="Check factual accuracy.",
            )
        ],
    )


def build_score(*, dimension_id: str = "accuracy") -> RubricScore:
    return RubricScore.model_validate(
        {
            "dimensions": {
                dimension_id: {
                    "reasoning": "The answer stayed on topic.",
                    "evidence": ["It addressed the user request directly."],
                    "score": 4,
                }
            },
            "overall_notes": "Solid response.",
            "pass": True,
        }
    )


@pytest.mark.anyio
async def test_judge_uses_structured_openai_parse(monkeypatch):
    rubric = build_rubric()
    parsed = build_score()
    client = FakeClient(parsed)

    result = await judge(
        rubric,
        "Reset your password from settings.",
        cast(openai.AsyncClient, client),
    )

    assert rubric.judge is not None
    assert result == parsed
    assert len(client.responses.calls) == 1
    call = client.responses.calls[0]
    text_config = cast(dict[str, object], call["text"])
    text_format = cast(dict[str, object], text_config["format"])
    schema = cast(dict[str, object], text_format["schema"])
    schema_properties = cast(dict[str, object], schema["properties"])
    dimensions = cast(dict[str, object], schema_properties["dimensions"])
    dimension_properties = cast(dict[str, object], dimensions["properties"])
    accuracy = cast(dict[str, object], dimension_properties["accuracy"])
    assert call["model"] == rubric.judge.model
    assert text_format["type"] == "json_schema"
    assert text_format["strict"] is True
    assert schema["additionalProperties"] is False
    assert accuracy["additionalProperties"] is False
    assert call["temperature"] == rubric.judge.temperature
    assert call["max_output_tokens"] == rubric.judge.max_tokens
    assert (
        call["input"] == "Response to evaluate:\n\nReset your password from settings."
    )
    assert "accuracy" in str(call["instructions"])
    assert '"additionalProperties": false' in str(call["instructions"])


@pytest.mark.anyio
async def test_judge_requires_rubric_judge_config():
    rubric = build_rubric()
    rubric.judge = None

    with pytest.raises(ValueError, match="missing judge configuration"):
        await judge(
            rubric, "Test response", cast(openai.AsyncClient, FakeClient(build_score()))
        )


@pytest.mark.anyio
async def test_judge_rejects_non_openai_provider():
    rubric = build_rubric()
    rubric.judge = JudgeConfig(
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        temperature=0.0,
        max_tokens=4096,
    )

    with pytest.raises(ValueError, match="only supports OpenAI"):
        await judge(
            rubric, "Test response", cast(openai.AsyncClient, FakeClient(build_score()))
        )


@pytest.mark.anyio
async def test_judge_rejects_missing_structured_output():
    with pytest.raises(ValueError, match="no text output"):
        await judge(
            build_rubric(), "Test response", cast(openai.AsyncClient, FakeClient(None))
        )


@pytest.mark.anyio
async def test_judge_rejects_dimension_mismatch():
    with pytest.raises(ValueError, match="missing dimensions: accuracy"):
        await judge(
            build_rubric(),
            "Test response",
            cast(openai.AsyncClient, FakeClient(build_score(dimension_id="relevance"))),
        )


@pytest.mark.anyio
async def test_judge_rejects_empty_rubric():
    empty_rubric = Rubric(
        id="empty",
        name="Empty Rubric",
        pass_threshold=0.7,
        meta_prompt="Score it.",
        dimensions=[],
    )

    with pytest.raises(ValueError, match="no dimensions"):
        await judge(
            empty_rubric,
            "Test response",
            cast(openai.AsyncClient, FakeClient(build_score())),
        )


def test_parse_rubrics_yaml_applies_top_level_judge_config(tmp_path):
    path = tmp_path / "rubric.yaml"
    path.write_text(
        """
version: "1.0"
judge:
  provider: openai
  model: anthropic/claude-opus-4.6
  temperature: 0.25
  max_tokens: 777
rubrics:
  - id: support
    name: Support
    pass_threshold: 0.7
    meta_prompt: Score it.
    dimensions:
      - id: accuracy
        name: Accuracy
        weight: 1.0
        scale:
          type: likert
          points: 5
          labels:
            1: bad
            5: good
        judge_prompt: Check accuracy.
""".strip(),
        encoding="utf-8",
    )

    parsed = parse_rubrics_yaml(path)

    assert parsed.metadata.judge is not None
    assert parsed.metadata.judge.model == "anthropic/claude-opus-4.6"
    assert parsed.rubrics[0].judge is not None
    assert parsed.rubrics[0].judge.model == "anthropic/claude-opus-4.6"
    assert parsed.rubrics[0].judge.temperature == 0.25
    assert parsed.rubrics[0].judge.max_tokens == 777


# ---------------------------------------------------------------------------
# Retry / error-handling coverage for judge() (lines 213-214, 238-254).
# ---------------------------------------------------------------------------


class _ScriptedClient:
    def __init__(self, script: list[object]) -> None:
        self.script = list(script)
        self.calls = 0

        class _API:
            async def create(_self, **kwargs: object) -> object:
                self.calls += 1
                item = self.script.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item

        self.responses = _API()


def _fake_auth_error() -> openai.AuthenticationError:
    class _Resp:
        status_code = 401
        request = None
        headers: dict[str, str] = {}

    return openai.AuthenticationError(
        message="bad key",
        response=_Resp(),  # type: ignore[arg-type]
        body={"error": "unauthorized"},
    )


def _fake_api_status_error(status: int) -> openai.APIStatusError:
    class _Resp:
        status_code = status
        request = None
        headers: dict[str, str] = {}

    return openai.APIStatusError(
        message=f"boom {status}",
        response=_Resp(),  # type: ignore[arg-type]
        body={"error": "x"},
    )


@pytest.mark.anyio
async def test_judge_wraps_authentication_error_with_actionable_message():
    rubric = build_rubric()
    client = _ScriptedClient([_fake_auth_error()])

    with pytest.raises(openai.AuthenticationError, match="OPEN_ROUTER_API_KEY"):
        await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert client.calls == 1  # no retry on auth error


@pytest.mark.anyio
async def test_judge_reraises_non_retryable_client_error(monkeypatch):
    rubric = build_rubric()
    client = _ScriptedClient([_fake_api_status_error(400)])

    with pytest.raises(openai.APIStatusError):
        await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert client.calls == 1  # non-retryable


@pytest.mark.anyio
async def test_judge_retries_on_server_error_then_succeeds(monkeypatch):
    rubric = build_rubric()
    parsed = build_score()
    good = SimpleNamespace(
        output_text=json.dumps(parsed.model_dump(by_alias=True))
    )
    client = _ScriptedClient([_fake_api_status_error(503), good])

    # Skip the 2s sleep between retries.
    import agentprobe.judge as judge_mod

    async def instant_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(judge_mod.asyncio, "sleep", instant_sleep)

    result = await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert result == parsed
    assert client.calls == 2


@pytest.mark.anyio
async def test_judge_retries_on_429_rate_limit(monkeypatch):
    rubric = build_rubric()
    parsed = build_score()
    good = SimpleNamespace(
        output_text=json.dumps(parsed.model_dump(by_alias=True))
    )
    client = _ScriptedClient([_fake_api_status_error(429), good])

    import agentprobe.judge as judge_mod

    async def instant_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(judge_mod.asyncio, "sleep", instant_sleep)

    result = await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert result == parsed
    assert client.calls == 2


@pytest.mark.anyio
async def test_judge_retries_on_invalid_json_then_succeeds():
    rubric = build_rubric()
    parsed = build_score()
    bad = SimpleNamespace(output_text="not json at all")
    good = SimpleNamespace(
        output_text=json.dumps(parsed.model_dump(by_alias=True))
    )
    client = _ScriptedClient([bad, good])

    result = await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert result == parsed
    assert client.calls == 2


@pytest.mark.anyio
async def test_judge_exhausts_retries_and_raises_last_exception(monkeypatch):
    rubric = build_rubric()
    bad = SimpleNamespace(output_text="still not json")
    client = _ScriptedClient([bad, bad, bad])

    with pytest.raises(ValueError, match="invalid JSON"):
        await judge(rubric, "resp", cast(openai.AsyncClient, client))
    assert client.calls == 3
