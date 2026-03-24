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

TechLiteracy: TypeAlias = Literal["low", "medium", "high", "expert"]
DomainExpertise: TypeAlias = Literal["none", "basic", "intermediate", "expert"]
LanguageStyle: TypeAlias = Literal["formal", "casual", "terse", "verbose", "varies"]
TopicDrift: TypeAlias = Literal["none", "low", "medium", "high"]
ClarificationCompliance: TypeAlias = Literal["low", "medium", "high"]


class PersonaDemographics(AgentProbeModel):
    role: str
    tech_literacy: TechLiteracy
    domain_expertise: DomainExpertise
    language_style: LanguageStyle


class PersonaPersonality(AgentProbeModel):
    patience: int
    assertiveness: int
    detail_orientation: int
    cooperativeness: int
    emotional_intensity: int


class PersonaBehavior(AgentProbeModel):
    opening_style: str
    follow_up_style: str
    escalation_triggers: list[str] = Field(default_factory=list)
    topic_drift: TopicDrift
    clarification_compliance: ClarificationCompliance


class Persona(AgentProbeModel):
    id: str
    name: str
    description: str | None = None
    demographics: PersonaDemographics
    personality: PersonaPersonality
    behavior: PersonaBehavior
    system_prompt: str

    def to_prompt_markdown(self) -> str:
        sections = [
            f"# Persona: {self.name}",
            f"- ID: `{self.id}`",
        ]

        if self.description:
            sections.append(f"- Description: {self.description}")

        sections.extend(
            [
                "",
                "## Demographics",
                f"- Role: {self.demographics.role}",
                f"- Tech literacy: {self.demographics.tech_literacy}",
                f"- Domain expertise: {self.demographics.domain_expertise}",
                f"- Language style: {self.demographics.language_style}",
                "",
                "## Personality",
                f"- Patience: {self.personality.patience}/5",
                f"- Assertiveness: {self.personality.assertiveness}/5",
                f"- Detail orientation: {self.personality.detail_orientation}/5",
                f"- Cooperativeness: {self.personality.cooperativeness}/5",
                f"- Emotional intensity: {self.personality.emotional_intensity}/5",
                "",
                "## Behavior",
                "### Opening Style",
                self.behavior.opening_style.strip(),
                "",
                "### Follow-Up Style",
                self.behavior.follow_up_style.strip(),
                "",
                "### Escalation Triggers",
            ]
        )

        if self.behavior.escalation_triggers:
            sections.extend(
                f"- {trigger}" for trigger in self.behavior.escalation_triggers
            )
        else:
            sections.append("- None")

        sections.extend(
            [
                "",
                f"- Topic drift: {self.behavior.topic_drift}",
                f"- Clarification compliance: {self.behavior.clarification_compliance}",
                "",
                "## System Prompt",
                self.system_prompt.strip(),
            ]
        )

        return "\n".join(sections)

    def __str__(self) -> str:
        return self.to_prompt_markdown()


class PersonasMetadata(AgentProbeModel):
    version: str | None = None
    id: str | None = None
    name: str | None = None
    source_path: Path | None = None


class Personas(AgentProbeModel):
    metadata: PersonasMetadata = Field(default_factory=PersonasMetadata)
    personas: list[Persona] = Field(default_factory=list)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def parse_persona_yaml(path: YamlPath) -> Personas:
    raw = read_yaml(path)
    return Personas(
        metadata=PersonasMetadata(
            version=_optional_str(raw.get("version")),
            id=_optional_str(raw.get("id")),
            name=_optional_str(raw.get("name")),
            source_path=coerce_path(path),
        ),
        personas=cast(list[Persona], raw.get("personas", [])),
    )


__all__ = [
    "Persona",
    "PersonaBehavior",
    "PersonaDemographics",
    "PersonaPersonality",
    "Personas",
    "PersonasMetadata",
    "parse_persona_yaml",
]
