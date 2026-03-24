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
            model="gpt-4.1-mini",
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
  model: gpt-4.1-mini
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
    assert parsed.metadata.judge.model == "gpt-4.1-mini"
    assert parsed.rubrics[0].judge is not None
    assert parsed.rubrics[0].judge.model == "gpt-4.1-mini"
    assert parsed.rubrics[0].judge.temperature == 0.25
    assert parsed.rubrics[0].judge.max_tokens == 777
