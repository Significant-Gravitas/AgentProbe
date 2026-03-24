from __future__ import annotations

from pathlib import Path
from typing import Literal, TypeAlias, cast

from pydantic import Field

from .common import (
    AgentProbeModel,
    YamlPath,
    coerce_path,
    read_yaml,
)

AggregationMode: TypeAlias = Literal["mean", "median", "majority_vote"]
JudgeProvider: TypeAlias = Literal["anthropic", "openai", "custom"]
ScaleType: TypeAlias = Literal["likert", "binary", "numeric", "rubric_levels"]


class RubricScale(AgentProbeModel):
    type: ScaleType
    points: int | None = None
    labels: dict[int | str, str] = Field(default_factory=dict)


class RubricDimension(AgentProbeModel):
    id: str
    name: str
    weight: float
    scale: RubricScale
    judge_prompt: str


class BiasMitigation(AgentProbeModel):
    randomize_order: bool | None = None
    chain_of_thought: bool | None = None
    structured_output: bool | None = None
    multiple_judges: bool | None = None
    judge_count: int | None = None
    aggregation: AggregationMode | None = None


class CostControls(AgentProbeModel):
    max_judge_calls_per_scenario: int | None = None
    cache_identical_judgments: bool | None = None


class JudgeConfig(AgentProbeModel):
    provider: JudgeProvider
    model: str
    temperature: float
    max_tokens: int
    bias_mitigation: BiasMitigation | None = None
    cost_controls: CostControls | None = None


class ScoreThreshold(AgentProbeModel):
    dimension: str
    below: int | float | None = None
    above: int | float | None = None


class ScoringOverrides(AgentProbeModel):
    auto_fail_conditions: list[ScoreThreshold] = Field(default_factory=list)
    auto_pass_conditions: list[ScoreThreshold] = Field(default_factory=list)


class Rubric(AgentProbeModel):
    id: str
    name: str
    description: str | None = None
    pass_threshold: float
    dimensions: list[RubricDimension] = Field(default_factory=list)
    scoring_overrides: ScoringOverrides | None = None
    meta_prompt: str
    judge: JudgeConfig | None = None

    def to_prompt_markdown(self) -> str:
        sections = [
            f"# Rubric: {self.name}",
            f"- ID: `{self.id}`",
            f"- Pass threshold: {self.pass_threshold:.2f}",
        ]

        if self.description:
            sections.append(f"- Description: {self.description}")

        sections.extend(["", "## Dimensions"])

        for dimension in self.dimensions:
            sections.extend(
                [
                    f"### {dimension.name}",
                    f"- ID: `{dimension.id}`",
                    f"- Weight: {dimension.weight:.2f}",
                    f"- Scale type: {dimension.scale.type}",
                ]
            )

            if dimension.scale.points is not None:
                sections.append(f"- Scale points: {dimension.scale.points}")

            sections.append("- Scale labels:")
            for score, label in dimension.scale.labels.items():
                sections.append(f"  - `{score}`: {label}")

            sections.extend(
                [
                    "",
                    "#### Judge Prompt",
                    dimension.judge_prompt.strip(),
                    "",
                ]
            )

        sections.append("## Scoring Overrides")
        if self.scoring_overrides and self.scoring_overrides.auto_fail_conditions:
            sections.append("### Auto-Fail Conditions")
            for condition in self.scoring_overrides.auto_fail_conditions:
                threshold = (
                    f"below {condition.below}"
                    if condition.below is not None
                    else f"above {condition.above}"
                )
                sections.append(f"- `{condition.dimension}`: {threshold}")
        else:
            sections.append("- Auto-fail conditions: none")

        if self.scoring_overrides and self.scoring_overrides.auto_pass_conditions:
            sections.append("")
            sections.append("### Auto-Pass Conditions")
            for condition in self.scoring_overrides.auto_pass_conditions:
                threshold = (
                    f"below {condition.below}"
                    if condition.below is not None
                    else f"above {condition.above}"
                )
                sections.append(f"- `{condition.dimension}`: {threshold}")
        else:
            sections.append("- Auto-pass conditions: none")

        sections.extend(
            [
                "",
                "## Meta Prompt",
                self.meta_prompt.strip(),
            ]
        )

        return "\n".join(sections)

    def __str__(self) -> str:
        return self.to_prompt_markdown()


class RubricsMetadata(AgentProbeModel):
    version: str | None = None
    id: str | None = None
    name: str | None = None
    source_path: Path | None = None
    judge: JudgeConfig | None = None


class Rubrics(AgentProbeModel):
    metadata: RubricsMetadata = Field(default_factory=RubricsMetadata)
    rubrics: list[Rubric] = Field(default_factory=list)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def parse_rubrics_yaml(path: YamlPath) -> Rubrics:
    raw = read_yaml(path)
    raw_judge = raw.get("judge")
    judge = (
        JudgeConfig.model_validate(raw_judge) if isinstance(raw_judge, dict) else None
    )

    rubrics: list[Rubric] = []
    for raw_rubric in cast(list[object], raw.get("rubrics", [])):
        if not isinstance(raw_rubric, dict):
            raise ValueError("Each rubric entry must be a mapping.")

        payload = dict(raw_rubric)
        payload.setdefault("judge", judge.model_dump() if judge is not None else None)
        rubrics.append(Rubric.model_validate(payload))

    return Rubrics(
        metadata=RubricsMetadata(
            version=_optional_str(raw.get("version")),
            id=_optional_str(raw.get("id")),
            name=_optional_str(raw.get("name")),
            source_path=coerce_path(path),
            judge=judge,
        ),
        rubrics=rubrics,
    )


__all__ = [
    "BiasMitigation",
    "CostControls",
    "JudgeConfig",
    "Rubric",
    "RubricDimension",
    "RubricScale",
    "Rubrics",
    "RubricsMetadata",
    "ScoreThreshold",
    "ScoringOverrides",
    "parse_rubrics_yaml",
]
