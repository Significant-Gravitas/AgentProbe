from __future__ import annotations

import json
from collections.abc import Mapping

from jinja2 import Environment, StrictUndefined

from .data.rubrics import Rubric
from .errors import AgentProbeConfigError

_ENV = Environment(
    autoescape=False,
    trim_blocks=True,
    lstrip_blocks=True,
    undefined=StrictUndefined,
)


def render_template(template: str, context: Mapping[str, object]) -> str:
    try:
        return _ENV.from_string(template).render(**context)
    except Exception as exc:  # pragma: no cover - jinja error types vary
        raise AgentProbeConfigError(f"Template rendering failed: {exc}") from exc


def render_optional_template(
    template: str | None,
    context: Mapping[str, object],
) -> str | None:
    if template is None:
        return None
    return render_template(template, context)


def render_json_template(
    template: str | None,
    context: Mapping[str, object],
) -> object | None:
    rendered = render_optional_template(template, context)
    if rendered is None:
        return None

    stripped = rendered.strip()
    if not stripped:
        return None

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return rendered


def render_rubric(
    rubric: Rubric,
    context: Mapping[str, object],
) -> Rubric:
    rendered = rubric.model_copy(deep=True)
    rendered.meta_prompt = render_template(rendered.meta_prompt, context)
    for dimension in rendered.dimensions:
        dimension.judge_prompt = render_template(dimension.judge_prompt, context)
    return rendered


__all__ = [
    "render_json_template",
    "render_optional_template",
    "render_rubric",
    "render_template",
]
