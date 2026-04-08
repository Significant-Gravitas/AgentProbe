from __future__ import annotations

import json

import openai

from pydantic import ConfigDict, Field

from .data.common import AgentProbeModel
from .data.rubrics import JudgeConfig, Rubric


class JudgeDimensionScore(AgentProbeModel):
    model_config = ConfigDict(extra="forbid")

    reasoning: str
    evidence: list[str] = Field(default_factory=list)
    score: float


class RubricScore(AgentProbeModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dimensions: dict[str, JudgeDimensionScore] = Field(default_factory=dict)
    overall_notes: str = ""
    passed: bool = Field(alias="pass")

    def validate_dimensions(self, rubric: Rubric) -> None:
        expected_ids = {dimension.id for dimension in rubric.dimensions}
        actual_ids = set(self.dimensions)

        missing_ids = sorted(expected_ids - actual_ids)
        extra_ids = sorted(actual_ids - expected_ids)

        if missing_ids or extra_ids:
            details: list[str] = []
            if missing_ids:
                details.append(f"missing dimensions: {', '.join(missing_ids)}")
            if extra_ids:
                details.append(f"unexpected dimensions: {', '.join(extra_ids)}")
            raise ValueError(
                "Judge output did not match rubric dimensions: " + "; ".join(details)
            )


def _judge_json_schema(rubric: Rubric) -> dict[str, object]:
    dimension_score_schema: dict[str, object] = {
        "type": "object",
        "properties": {
            "reasoning": {
                "type": "string",
                "description": "Concise reasoning for the assigned score.",
            },
            "evidence": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Short evidence snippets or observations from the transcript.",
            },
            "score": {
                "type": "number",
                "description": "Numeric score for the rubric dimension.",
            },
        },
        "required": ["reasoning", "evidence", "score"],
        "additionalProperties": False,
    }

    dimensions_schema: dict[str, object] = {
        "type": "object",
        "properties": {
            dimension.id: {
                **dimension_score_schema,
                "description": f"Score details for rubric dimension `{dimension.id}`.",
            }
            for dimension in rubric.dimensions
        },
        "required": [dimension.id for dimension in rubric.dimensions],
        "additionalProperties": False,
    }

    return {
        "type": "object",
        "properties": {
            "dimensions": dimensions_schema,
            "overall_notes": {
                "type": "string",
                "description": "Short overall summary of strengths and failures.",
            },
            "pass": {
                "type": "boolean",
                "description": "Whether the evaluated response passes the rubric.",
            },
        },
        "required": ["dimensions", "overall_notes", "pass"],
        "additionalProperties": False,
    }


def _judge_instructions(rubric: Rubric, schema: dict[str, object]) -> str:
    dimension_ids = ", ".join(sorted(dimension.id for dimension in rubric.dimensions))
    return (
        "You are an expert rubric judge. Evaluate only the provided response.\n\n"
        f"{rubric.to_prompt_markdown()}\n\n"
        "Return structured output matching the requested schema exactly. "
        f"The `dimensions` object must contain exactly these rubric dimension ids: {dimension_ids}.\n\n"
        "JSON schema:\n"
        f"{json.dumps(schema, indent=2, sort_keys=True)}"
    )


def _judge_config(rubric: Rubric) -> JudgeConfig:
    if rubric.judge is None:
        raise ValueError("Rubric is missing judge configuration.")
    if rubric.judge.provider != "openai":
        raise ValueError(
            f"judge.py only supports OpenAI judges, got: {rubric.judge.provider}"
        )
    return rubric.judge


def _extract_response_text(response: object) -> str:
    direct_text = getattr(response, "output_text", None)
    if isinstance(direct_text, str) and direct_text.strip():
        return direct_text.strip()

    output = getattr(response, "output", None)
    if isinstance(output, list):
        chunks: list[str] = []
        for item in output:
            content = getattr(item, "content", None)
            if not isinstance(content, list):
                continue
            for part in content:
                text = getattr(part, "text", None)
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        if chunks:
            return "\n".join(chunks).strip()

    raise ValueError("Judge returned no text output.")


def _parse_rubric_score(payload: str) -> RubricScore:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ValueError("Judge returned invalid JSON output.") from exc

    if not isinstance(parsed, dict):
        raise ValueError("Judge returned invalid JSON output.")

    return RubricScore.model_validate(parsed)


async def judge(
    rubric: Rubric,
    response: str,
    oai_client: openai.AsyncClient,
) -> RubricScore:
    """
    Judge a response against a rubric using OpenAI structured outputs.

    Args:
        rubric: Rubric definition used for judging.
        response: Response text or transcript to evaluate.
        oai_client: OpenAI async client used for structured output parsing.

    Returns:
        Parsed rubric judgment with per-dimension scores and pass/fail.
    """
    if not rubric.dimensions:
        raise ValueError("Cannot judge a rubric with no dimensions.")

    judge_config = _judge_config(rubric)
    schema = _judge_json_schema(rubric)
    try:
        api_response = await oai_client.responses.create(
            model=judge_config.model,
            instructions=_judge_instructions(rubric, schema),
            input=f"Response to evaluate:\n\n{response}",
            text={
                "format": {
                    "type": "json_schema",
                    "name": "rubric_score",
                    "description": "Structured rubric evaluation for an agent response.",
                    "schema": schema,
                    "strict": True,
                }
            },
            temperature=judge_config.temperature,
            max_output_tokens=judge_config.max_tokens,
        )
    except openai.AuthenticationError as exc:
        raise openai.AuthenticationError(
            message=(
                f"Judge authentication failed for model '{judge_config.model}'. "
                "Set OPENAI_API_KEY (and OPENAI_BASE_URL for OpenRouter or other providers) "
                "environment variables before running agentprobe."
            ),
            response=exc.response,
            body=exc.body,
        ) from exc

    score = _parse_rubric_score(_extract_response_text(api_response))
    score.validate_dimensions(rubric)
    return score


__all__ = [
    "JudgeDimensionScore",
    "RubricScore",
    "judge",
]
