from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
import openai

from pydantic import Field

from .adapters import (
    AdapterReply,
    EndpointAdapter,
    ToolCallRecord,
    build_endpoint_adapter,
)
from .data.common import AgentProbeModel
from .data.endpoints import Endpoints, parse_endpoints_yaml
from .data.personas import Persona, parse_persona_yaml
from .data.rubrics import Rubric, parse_rubrics_yaml
from .data.scenarios import (
    CheckpointAssertion,
    Scenario,
    ScenarioDefaults,
    parse_scenario_yaml,
)
from .errors import AgentProbeConfigError, AgentProbeRuntimeError
from .judge import RubricScore, judge
from .rendering import render_rubric, render_template
from .simulator import ConversationTurn, generate_next_step, resolve_persona_model


class CheckpointResult(AgentProbeModel):
    passed: bool
    failures: list[str] = Field(default_factory=list)


class ScenarioRunResult(AgentProbeModel):
    scenario_id: str
    scenario_name: str
    persona_id: str
    rubric_id: str
    passed: bool
    overall_score: float
    transcript: list[ConversationTurn] = Field(default_factory=list)
    checkpoints: list[CheckpointResult] = Field(default_factory=list)


class RunResult(AgentProbeModel):
    run_id: str | None = None
    passed: bool
    exit_code: int
    results: list[ScenarioRunResult] = Field(default_factory=list)


@dataclass(frozen=True, slots=True)
class RunProgressEvent:
    kind: Literal[
        "suite_started", "scenario_started", "scenario_finished", "scenario_error"
    ]
    scenario_id: str | None = None
    scenario_name: str | None = None
    scenario_index: int | None = None
    scenario_total: int | None = None
    passed: bool | None = None
    overall_score: float | None = None
    error: Exception | None = None


RunProgressCallback = Callable[[RunProgressEvent], None]


class RunRecorder(Protocol):
    def record_run_started(
        self,
        *,
        endpoint: str | Path,
        scenarios: str | Path,
        personas: str | Path,
        rubric: str | Path,
        scenario_filter: str | None,
        tags: str | None,
    ) -> str: ...

    def record_run_configuration(
        self,
        *,
        endpoint_config: Endpoints,
        scenario_collection: Any,
        persona_collection: Any,
        rubric_collection: Any,
        selected_scenarios: list[Scenario],
        scenario_filter: str | None,
        tags: str | None,
    ) -> None: ...

    def record_run_finished(self, result: RunResult) -> None: ...

    def record_run_error(self, exc: Exception, *, exit_code: int) -> None: ...

    def record_scenario_started(
        self,
        *,
        scenario: Scenario,
        persona: Persona,
        rubric: Rubric,
        ordinal: int | None,
    ) -> int: ...

    def record_scenario_finished(
        self,
        scenario_run_id: int,
        *,
        result: ScenarioRunResult,
    ) -> None: ...

    def record_scenario_error(
        self,
        scenario_run_id: int,
        exc: Exception,
    ) -> None: ...

    def record_turn(
        self,
        scenario_run_id: int,
        *,
        turn_index: int,
        turn: ConversationTurn,
        source: str,
        generator_model: str | None = None,
    ) -> None: ...

    def record_assistant_reply(
        self,
        scenario_run_id: int,
        *,
        turn_index: int,
        reply: AdapterReply,
    ) -> None: ...

    def record_checkpoint(
        self,
        scenario_run_id: int,
        *,
        checkpoint_index: int,
        preceding_turn_index: int | None,
        assertions: list[CheckpointAssertion],
        result: CheckpointResult,
    ) -> None: ...

    def record_judge_result(
        self,
        scenario_run_id: int,
        *,
        rubric: Rubric,
        score: RubricScore,
        overall_score: float,
    ) -> None: ...


async def run_scenario(
    adapter: EndpointAdapter,
    scenario: Scenario,
    persona: Persona,
    rubric: Rubric,
    *,
    defaults: ScenarioDefaults | None = None,
    oai_client: openai.AsyncClient,
    recorder: RunRecorder | None = None,
    scenario_ordinal: int | None = None,
) -> ScenarioRunResult:
    transcript: list[ConversationTurn] = []
    checkpoints: list[CheckpointResult] = []
    tool_calls_by_turn: dict[int, list[ToolCallRecord]] = {}
    rendered_turns: list[dict[str, object]] = []

    system_prompt = (
        scenario.context.system_prompt if scenario.context is not None else None
    )
    injected_data = (
        dict(scenario.context.injected_data) if scenario.context is not None else {}
    )

    base_context: dict[str, object] = {
        **injected_data,
        "scenario": scenario,
        "persona": persona,
        "rubric": rubric,
        "expectations": scenario.expectations,
        "context": scenario.context,
        "defaults": defaults,
    }

    session_state: dict[str, object] = {}
    last_message: ConversationTurn | None = None
    last_reply: AdapterReply | None = None
    user_turn_count = 0
    scenario_run_id = (
        recorder.record_scenario_started(
            scenario=scenario,
            persona=persona,
            rubric=rubric,
            ordinal=scenario_ordinal,
        )
        if recorder is not None
        else None
    )

    try:
        await adapter.health_check(dict(base_context))

        try:
            session_state = await adapter.open_scenario(dict(base_context))

            if isinstance(system_prompt, str) and system_prompt.strip():
                system_turn = ConversationTurn(
                    role="system",
                    content=render_template(system_prompt, base_context),
                )
                transcript.append(system_turn)
                if recorder is not None and scenario_run_id is not None:
                    recorder.record_turn(
                        scenario_run_id,
                        turn_index=len(transcript) - 1,
                        turn=system_turn,
                        source="system_prompt",
                    )

            for turn in scenario.turns:
                render_context = _build_run_context(
                    base_context=base_context,
                    session_state=session_state,
                    transcript=transcript,
                    last_message=last_message,
                    last_reply=last_reply,
                )

                if turn.role == "checkpoint":
                    rendered_turns.append(turn.model_dump(by_alias=True))
                    checkpoint_result = _evaluate_checkpoint_turn(
                        turn.assert_, last_reply
                    )
                    checkpoints.append(checkpoint_result)
                    if recorder is not None and scenario_run_id is not None:
                        recorder.record_checkpoint(
                            scenario_run_id,
                            checkpoint_index=len(checkpoints) - 1,
                            preceding_turn_index=len(transcript) - 1
                            if transcript
                            else None,
                            assertions=turn.assert_,
                            result=checkpoint_result,
                        )
                    continue

                if turn.role == "inject":
                    rendered = _render_turn_text(turn.content, render_context)
                    rendered_turns.append(
                        {
                            **turn.model_dump(by_alias=True),
                            "content": rendered,
                        }
                    )
                    if rendered:
                        inject_turn = ConversationTurn(role="system", content=rendered)
                        transcript.append(inject_turn)
                        if recorder is not None and scenario_run_id is not None:
                            recorder.record_turn(
                                scenario_run_id,
                                turn_index=len(transcript) - 1,
                                turn=inject_turn,
                                source="inject",
                            )
                    continue

                user_turn_count += 1
                max_turns = scenario.max_turns
                if max_turns is None and defaults is not None:
                    max_turns = defaults.max_turns
                if max_turns is not None and user_turn_count > max_turns:
                    raise AgentProbeRuntimeError(
                        f"Scenario {scenario.id} exceeded max_turns={max_turns}."
                    )

                generator_model: str | None = None
                if turn.content is None:
                    generator_model = resolve_persona_model(persona)
                    rendered_user_text = await generate_next_step(
                        persona,
                        transcript,
                        oai_client=oai_client,
                    )
                else:
                    rendered_user_text = _render_turn_text(turn.content, render_context)

                rendered_turns.append(
                    {
                        **turn.model_dump(by_alias=True),
                        "content": rendered_user_text,
                    }
                )
                last_message = ConversationTurn(role="user", content=rendered_user_text)
                transcript.append(last_message)
                if recorder is not None and scenario_run_id is not None:
                    recorder.record_turn(
                        scenario_run_id,
                        turn_index=len(transcript) - 1,
                        turn=last_message,
                        source="user_generated"
                        if turn.content is None
                        else "user_static",
                        generator_model=generator_model,
                    )

                reply_context = _build_run_context(
                    base_context=base_context,
                    session_state=session_state,
                    transcript=transcript,
                    last_message=last_message,
                    last_reply=last_reply,
                )
                adapter_reply = await adapter.send_user_turn(reply_context)
                last_reply = adapter_reply

                assistant_turn = ConversationTurn(
                    role="assistant",
                    content=adapter_reply.assistant_text,
                )
                transcript.append(assistant_turn)
                assistant_turn_index = len(transcript) - 1
                if recorder is not None and scenario_run_id is not None:
                    recorder.record_turn(
                        scenario_run_id,
                        turn_index=assistant_turn_index,
                        turn=assistant_turn,
                        source="assistant",
                    )
                    recorder.record_assistant_reply(
                        scenario_run_id,
                        turn_index=assistant_turn_index,
                        reply=adapter_reply,
                    )
                if adapter_reply.tool_calls:
                    tool_calls_by_turn[assistant_turn_index] = list(
                        adapter_reply.tool_calls
                    )
        finally:
            if session_state or last_message is not None or last_reply is not None:
                close_context = _build_run_context(
                    base_context=base_context,
                    session_state=session_state,
                    transcript=transcript,
                    last_message=last_message,
                    last_reply=last_reply,
                )
                await adapter.close_scenario(close_context)

        rubric_context = _build_run_context(
            base_context=base_context,
            session_state=session_state,
            transcript=transcript,
            last_message=last_message,
            last_reply=last_reply,
        )
        rubric_context["turns"] = rendered_turns
        rendered_rubric = render_rubric(rubric, rubric_context)
        transcript_text = _format_transcript_for_judge(transcript, tool_calls_by_turn)
        score = await judge(rendered_rubric, transcript_text, oai_client)
        overall_score = _overall_score(rendered_rubric, score)
        if recorder is not None and scenario_run_id is not None:
            recorder.record_judge_result(
                scenario_run_id,
                rubric=rendered_rubric,
                score=score,
                overall_score=overall_score,
            )

        result = ScenarioRunResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            persona_id=persona.id,
            rubric_id=rubric.id,
            passed=score.passed,
            overall_score=overall_score,
            transcript=transcript,
            checkpoints=checkpoints,
        )
        if recorder is not None and scenario_run_id is not None:
            recorder.record_scenario_finished(scenario_run_id, result=result)
        return result
    except Exception as exc:
        if recorder is not None and scenario_run_id is not None:
            recorder.record_scenario_error(scenario_run_id, exc)
        raise


async def run_suite(
    *,
    endpoint: str | Path,
    scenarios: str | Path,
    personas: str | Path,
    rubric: str | Path,
    scenario_id: str | None = None,
    tags: str | None = None,
    adapter_factory: Callable[[Endpoints], EndpointAdapter] | None = None,
    oai_client: openai.AsyncClient,
    recorder: RunRecorder | None = None,
    progress_callback: RunProgressCallback | None = None,
) -> RunResult:
    run_id = (
        recorder.record_run_started(
            endpoint=endpoint,
            scenarios=scenarios,
            personas=personas,
            rubric=rubric,
            scenario_filter=scenario_id,
            tags=tags,
        )
        if recorder is not None
        else None
    )

    try:
        endpoint_config = parse_endpoints_yaml(endpoint)
        scenario_collection = parse_scenario_yaml(scenarios)
        persona_collection = parse_persona_yaml(personas)
        rubric_collection = parse_rubrics_yaml(rubric)

        persona_by_id = {item.id: item for item in persona_collection.personas}
        rubric_by_id = {item.id: item for item in rubric_collection.rubrics}

        requested_tags = (
            {tag.strip() for tag in tags.split(",") if tag.strip()} if tags else set()
        )

        selected_scenarios = list(scenario_collection.scenarios)
        if scenario_id:
            selected_scenarios = [
                item for item in selected_scenarios if item.id == scenario_id
            ]
        if requested_tags:
            selected_scenarios = [
                item
                for item in selected_scenarios
                if requested_tags.intersection(set(item.tags))
            ]
        if not selected_scenarios:
            raise AgentProbeConfigError("No scenarios matched the requested filters.")

        if recorder is not None:
            recorder.record_run_configuration(
                endpoint_config=endpoint_config,
                scenario_collection=scenario_collection,
                persona_collection=persona_collection,
                rubric_collection=rubric_collection,
                selected_scenarios=selected_scenarios,
                scenario_filter=scenario_id,
                tags=tags,
            )

        results: list[ScenarioRunResult] = []
        scenario_total = len(selected_scenarios)
        if progress_callback is not None:
            progress_callback(
                RunProgressEvent(kind="suite_started", scenario_total=scenario_total)
            )
        for scenario_ordinal, item in enumerate(selected_scenarios):
            persona = persona_by_id.get(item.persona)
            if persona is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} references unknown persona `{item.persona}`."
                )
            rubric_item = rubric_by_id.get(item.rubric)
            if rubric_item is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} references unknown rubric `{item.rubric}`."
                )

            adapter = (
                adapter_factory(endpoint_config)
                if adapter_factory is not None
                else build_endpoint_adapter(endpoint_config)
            )
            scenario_index = scenario_ordinal + 1
            if progress_callback is not None:
                progress_callback(
                    RunProgressEvent(
                        kind="scenario_started",
                        scenario_id=item.id,
                        scenario_name=item.name,
                        scenario_index=scenario_index,
                        scenario_total=scenario_total,
                    )
                )
            try:
                scenario_result = await run_scenario(
                    adapter,
                    item,
                    persona,
                    rubric_item,
                    defaults=scenario_collection.metadata.defaults,
                    oai_client=oai_client,
                    recorder=recorder,
                    scenario_ordinal=scenario_ordinal,
                )
            except Exception as exc:
                if progress_callback is not None:
                    progress_callback(
                        RunProgressEvent(
                            kind="scenario_error",
                            scenario_id=item.id,
                            scenario_name=item.name,
                            scenario_index=scenario_index,
                            scenario_total=scenario_total,
                            error=exc,
                        )
                    )
                raise
            results.append(scenario_result)
            if progress_callback is not None:
                progress_callback(
                    RunProgressEvent(
                        kind="scenario_finished",
                        scenario_id=scenario_result.scenario_id,
                        scenario_name=scenario_result.scenario_name,
                        scenario_index=scenario_index,
                        scenario_total=scenario_total,
                        passed=scenario_result.passed,
                        overall_score=scenario_result.overall_score,
                    )
                )

        passed = all(item.passed for item in results)
        run_result = RunResult(
            run_id=run_id,
            passed=passed,
            exit_code=0 if passed else 1,
            results=results,
        )
        if recorder is not None:
            recorder.record_run_finished(run_result)
        return run_result
    except AgentProbeConfigError as exc:
        if recorder is not None:
            recorder.record_run_error(exc, exit_code=2)
        raise
    except AgentProbeRuntimeError as exc:
        if recorder is not None:
            recorder.record_run_error(exc, exit_code=3)
        raise
    except Exception as exc:
        if recorder is not None:
            recorder.record_run_error(exc, exit_code=3)
        raise


def _build_run_context(
    *,
    base_context: dict[str, object],
    session_state: dict[str, object],
    transcript: list[ConversationTurn],
    last_message: ConversationTurn | None,
    last_reply: AdapterReply | None,
) -> dict[str, object]:
    return {
        **base_context,
        **session_state,
        "session": session_state,
        "session_state": session_state,
        "transcript": transcript,
        "last_message": last_message,
        "last_reply": last_reply,
    }


def _render_turn_text(content: str | None, context: dict[str, object]) -> str:
    if content is None:
        return ""
    return render_template(content, context)


def _evaluate_checkpoint_turn(
    assertions: list[CheckpointAssertion],
    last_reply: AdapterReply | None,
) -> CheckpointResult:
    if last_reply is None:
        return CheckpointResult(
            passed=False,
            failures=["Checkpoint evaluated before any assistant reply was available."],
        )

    failures: list[str] = []
    for assertion in assertions:
        if assertion.tool_called:
            matching_call = next(
                (
                    call
                    for call in last_reply.tool_calls
                    if call.name == assertion.tool_called
                ),
                None,
            )
            if matching_call is None:
                failures.append(f"Missing tool call `{assertion.tool_called}`.")
                continue
            if (
                assertion.with_args is not None
                and matching_call.args != assertion.with_args
            ):
                failures.append(
                    f"Tool call `{assertion.tool_called}` arguments did not match."
                )

        if (
            assertion.response_mentions
            and assertion.response_mentions not in last_reply.assistant_text
        ):
            failures.append(
                f"Assistant response did not mention `{assertion.response_mentions}`."
            )

        if assertion.response_contains_any and not any(
            needle in last_reply.assistant_text
            for needle in assertion.response_contains_any
        ):
            failures.append(
                "Assistant response did not contain any required checkpoint text."
            )

    return CheckpointResult(passed=not failures, failures=failures)


def _format_transcript_for_judge(
    transcript: list[ConversationTurn],
    tool_calls_by_turn: dict[int, list[ToolCallRecord]],
) -> str:
    lines = ["Conversation Transcript", ""]

    for index, turn in enumerate(transcript):
        content = (turn.content or "").strip()
        if not content:
            continue

        lines.append(f"{_display_turn_role(turn.role)}: {content}")
        tool_calls = tool_calls_by_turn.get(index, [])
        if tool_calls:
            lines.append("Tool Calls:")
            for call in tool_calls:
                lines.append(f"- {call.name}: {json.dumps(call.args, sort_keys=True)}")

    return "\n".join(lines).strip()


def _display_turn_role(role: str) -> str:
    normalized = role.strip().lower()
    if normalized == "system":
        return "System"
    if normalized == "assistant":
        return "Assistant"
    if normalized == "user":
        return "User"
    return normalized.capitalize()


def _overall_score(rubric: Rubric, score: RubricScore) -> float:
    total_weight = sum(dimension.weight for dimension in rubric.dimensions) or 1.0
    weighted_total = 0.0

    for dimension in rubric.dimensions:
        dimension_score = score.dimensions[dimension.id].score
        scale_points = dimension.scale.points or 1
        normalized = float(dimension_score) / float(scale_points)
        weighted_total += normalized * dimension.weight

    return weighted_total / total_weight


__all__ = [
    "CheckpointResult",
    "RunResult",
    "RunProgressEvent",
    "ScenarioRunResult",
    "run_scenario",
    "run_suite",
]
