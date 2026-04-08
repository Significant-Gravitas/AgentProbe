from __future__ import annotations

import asyncio
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
    ResetPolicy,
    Scenario,
    ScenarioDefaults,
    Session,
    parse_scenario_yaml,
)
from .errors import AgentProbeConfigError, AgentProbeRuntimeError
from .judge import RubricScore, judge
from .rendering import render_rubric, render_template
from .simulator import ConversationTurn, generate_persona_step, resolve_persona_model


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


@dataclass(frozen=True, slots=True)
class ScenarioTermination:
    reason: Literal["max_turns_exceeded"]
    message: str
    max_turns: int | None = None


@dataclass(frozen=True, slots=True)
class _PreparedScenarioRun:
    adapter_factory: Callable[[], EndpointAdapter]
    scenario: Scenario
    persona: Persona
    rubric: Rubric
    ordinal: int
    total: int

    @property
    def index(self) -> int:
        return self.ordinal + 1


@dataclass(frozen=True, slots=True)
class _ScenarioExecutionOutcome:
    prepared: _PreparedScenarioRun
    result: ScenarioRunResult | None = None
    error: Exception | None = None


class _ScenarioMaxTurnsExceeded(AgentProbeRuntimeError):
    def __init__(self, *, scenario_id: str, max_turns: int) -> None:
        self.scenario_id = scenario_id
        self.max_turns = max_turns
        super().__init__(f"Scenario {scenario_id} exceeded max_turns={max_turns}.")


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


async def _run_session_turns(
    *,
    adapter: EndpointAdapter,
    session: Session,
    scenario: Scenario,
    persona: Persona,
    base_context: dict[str, object],
    session_state: dict[str, object],
    transcript: list[ConversationTurn],
    checkpoints: list[CheckpointResult],
    tool_calls_by_turn: dict[int, list[ToolCallRecord]],
    rendered_turns: list[dict[str, object]],
    last_message_box: list[ConversationTurn | None],
    last_reply_box: list[AdapterReply | None],
    user_turn_count_box: list[int],
    max_turns: int | None,
    persona_model: str,
    oai_client: openai.AsyncClient,
    recorder: RunRecorder | None,
    scenario_run_id: int | None,
) -> ScenarioTermination | None:
    """Execute all turns within a single session. Returns a termination if
    max_turns was exceeded, otherwise ``None``."""

    termination: ScenarioTermination | None = None

    async def submit_user_turn(
        user_text: str,
        *,
        source: str,
        generator_model: str | None = None,
    ) -> None:
        last_message = ConversationTurn(role="user", content=user_text)
        last_message_box[0] = last_message
        transcript.append(last_message)
        if recorder is not None and scenario_run_id is not None:
            recorder.record_turn(
                scenario_run_id,
                turn_index=len(transcript) - 1,
                turn=last_message,
                source=source,
                generator_model=generator_model,
            )

        user_turn_count_box[0] = _increment_user_turn_count(
            user_turn_count_box[0],
            scenario_id=scenario.id,
            max_turns=max_turns,
        )

        reply_context = _build_run_context(
            base_context=base_context,
            session_state=session_state,
            transcript=transcript,
            last_message=last_message_box[0],
            last_reply=last_reply_box[0],
        )
        adapter_reply = await adapter.send_user_turn(reply_context)
        last_reply_box[0] = adapter_reply

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

    scripted_user_turn_seen = False

    try:
        turn_index = 0
        while turn_index < len(session.turns):
            turn = session.turns[turn_index]

            if turn.role == "checkpoint":
                rendered_turns.append(turn.model_dump(by_alias=True))
                checkpoint_result = _evaluate_checkpoint_turn(
                    turn.assert_, last_reply_box[0]
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
                turn_index += 1
                continue

            # Build render context only for turns that need it (inject / user).
            render_context = _build_run_context(
                base_context=base_context,
                session_state=session_state,
                transcript=transcript,
                last_message=last_message_box[0],
                last_reply=last_reply_box[0],
            )

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
                turn_index += 1
                continue

            scripted_user_turn_seen = True
            rendered_guidance = _render_turn_text(turn.content, render_context)
            generator_model: str | None = None
            if turn.use_exact_message:
                rendered_user_text = rendered_guidance
                source = "user_exact"
            else:
                generator_model = persona_model
                step = await generate_persona_step(
                    persona,
                    transcript,
                    oai_client=oai_client,
                    guidance=rendered_guidance or None,
                    require_response=True,
                )
                if step.message is None:
                    raise ValueError(
                        "Persona simulator did not return a message for a required user turn."
                    )
                rendered_user_text = step.message
                source = "user_guided"

            rendered_turns.append(
                {
                    **turn.model_dump(by_alias=True),
                    "content": rendered_user_text,
                }
            )
            await submit_user_turn(
                rendered_user_text,
                source=source,
                generator_model=generator_model,
            )
            turn_index += 1

        # Continue after scripted turns until persona stops
        if scripted_user_turn_seen:
            while True:
                step = await generate_persona_step(
                    persona,
                    transcript,
                    oai_client=oai_client,
                    require_response=False,
                )
                if step.status != "continue":
                    break
                if step.message is None:
                    raise ValueError(
                        "Persona simulator returned `continue` without a follow-up message."
                    )

                rendered_turns.append(
                    {
                        "role": "user",
                        "content": step.message,
                        "source": "user_generated",
                    }
                )
                await submit_user_turn(
                    step.message,
                    source="user_generated",
                    generator_model=persona_model,
                )
    except _ScenarioMaxTurnsExceeded as exc:
        termination = ScenarioTermination(
            reason="max_turns_exceeded",
            message=str(exc),
            max_turns=exc.max_turns,
        )

    return termination


_RESETS_REQUIRING_REINIT: frozenset[str] = frozenset({"new", "fresh_agent"})


async def _maybe_close_scenario(
    adapter: EndpointAdapter,
    *,
    base_context: dict[str, object],
    session_state: dict[str, object],
    transcript: list[ConversationTurn],
    last_message: ConversationTurn | None,
    last_reply: AdapterReply | None,
) -> None:
    """Close the current scenario on *adapter* if any interaction occurred."""
    if session_state or last_message is not None or last_reply is not None:
        close_context = _build_run_context(
            base_context=base_context,
            session_state=session_state,
            transcript=transcript,
            last_message=last_message,
            last_reply=last_reply,
        )
        await adapter.close_scenario(close_context)


def _clear_session_state(
    transcript: list[ConversationTurn],
    last_message_box: list[ConversationTurn | None],
    last_reply_box: list[AdapterReply | None],
) -> None:
    """Reset per-session mutable state for *new* or *fresh_agent* resets."""
    transcript.clear()
    last_message_box[0] = None
    last_reply_box[0] = None


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
    adapter_factory: Callable[[], EndpointAdapter] | None = None,
) -> ScenarioRunResult:
    transcript: list[ConversationTurn] = []
    checkpoints: list[CheckpointResult] = []
    tool_calls_by_turn: dict[int, list[ToolCallRecord]] = {}
    rendered_turns: list[dict[str, object]] = []
    termination: ScenarioTermination | None = None

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

    last_message_box: list[ConversationTurn | None] = [None]
    last_reply_box: list[AdapterReply | None] = [None]
    user_turn_count_box: list[int] = [0]
    max_turns = _resolve_max_turns(scenario, defaults)
    persona_model = resolve_persona_model(persona)
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

    sessions = scenario.effective_sessions()

    # Pre-render the system prompt once (it only depends on base_context
    # which is constant across sessions).
    rendered_system_prompt: str | None = None
    if isinstance(system_prompt, str) and system_prompt.strip():
        rendered_system_prompt = render_template(system_prompt, base_context)

    try:
        # If no sessions, fall back to legacy empty-scenario handling
        if not sessions:
            await adapter.health_check(dict(base_context))
            session_state: dict[str, object] = {}
            try:
                session_state = await adapter.open_scenario(dict(base_context))
            finally:
                await _maybe_close_scenario(
                    adapter,
                    base_context=base_context,
                    session_state=session_state,
                    transcript=transcript,
                    last_message=last_message_box[0],
                    last_reply=last_reply_box[0],
                )
        else:
            current_adapter = adapter
            session_state = {}

            for session_idx, session in enumerate(sessions):
                is_first = session_idx == 0
                reset = session.reset

                # Handle reset policy
                if not is_first and reset in _RESETS_REQUIRING_REINIT:
                    # Close the previous session
                    await _maybe_close_scenario(
                        current_adapter,
                        base_context=base_context,
                        session_state=session_state,
                        transcript=transcript,
                        last_message=last_message_box[0],
                        last_reply=last_reply_box[0],
                    )

                    if reset == "fresh_agent" and adapter_factory is not None:
                        current_adapter = adapter_factory()

                    _clear_session_state(
                        transcript, last_message_box, last_reply_box,
                    )
                    session_state = {}

                # Health check and open for each new session
                if is_first or reset in _RESETS_REQUIRING_REINIT:
                    await current_adapter.health_check(dict(base_context))
                    session_state = await current_adapter.open_scenario(
                        dict(base_context)
                    )

                # Inject system prompt at the start of each session
                # (for fresh_agent/new, the context is cleared so we re-inject)
                if is_first or reset in _RESETS_REQUIRING_REINIT:
                    if rendered_system_prompt is not None:
                        system_turn = ConversationTurn(
                            role="system",
                            content=rendered_system_prompt,
                        )
                        transcript.append(system_turn)
                        if recorder is not None and scenario_run_id is not None:
                            recorder.record_turn(
                                scenario_run_id,
                                turn_index=len(transcript) - 1,
                                turn=system_turn,
                                source="system_prompt",
                            )

                session_termination = await _run_session_turns(
                    adapter=current_adapter,
                    session=session,
                    scenario=scenario,
                    persona=persona,
                    base_context=base_context,
                    session_state=session_state,
                    transcript=transcript,
                    checkpoints=checkpoints,
                    tool_calls_by_turn=tool_calls_by_turn,
                    rendered_turns=rendered_turns,
                    last_message_box=last_message_box,
                    last_reply_box=last_reply_box,
                    user_turn_count_box=user_turn_count_box,
                    max_turns=max_turns,
                    persona_model=persona_model,
                    oai_client=oai_client,
                    recorder=recorder,
                    scenario_run_id=scenario_run_id,
                )
                if session_termination is not None:
                    termination = session_termination
                    break

            # Close the final session
            await _maybe_close_scenario(
                current_adapter,
                base_context=base_context,
                session_state=session_state,
                transcript=transcript,
                last_message=last_message_box[0],
                last_reply=last_reply_box[0],
            )

        rubric_context = _build_run_context(
            base_context=base_context,
            session_state=session_state if sessions else {},
            transcript=transcript,
            last_message=last_message_box[0],
            last_reply=last_reply_box[0],
        )
        rubric_context["turns"] = rendered_turns
        rubric_context["termination"] = (
            {
                "reason": termination.reason,
                "message": termination.message,
                "max_turns": termination.max_turns,
            }
            if termination is not None
            else None
        )
        rendered_rubric = render_rubric(rubric, rubric_context)
        transcript_text = _format_transcript_for_judge(
            transcript,
            tool_calls_by_turn,
            termination=termination,
        )
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
    parallel: bool = False,
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

        scenario_total = len(selected_scenarios)
        if progress_callback is not None:
            progress_callback(
                RunProgressEvent(kind="suite_started", scenario_total=scenario_total)
            )
        def _make_adapter() -> EndpointAdapter:
            if adapter_factory is not None:
                return adapter_factory(endpoint_config)
            return build_endpoint_adapter(endpoint_config)

        prepared_runs: list[_PreparedScenarioRun] = []
        for scenario_ordinal, item in enumerate(selected_scenarios):
            # Resolve persona: scenario-level, then defaults, then error
            persona_id = item.persona
            if persona_id is None and scenario_collection.metadata.defaults is not None:
                persona_id = scenario_collection.metadata.defaults.persona
            if persona_id is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} has no persona and no default persona is set."
                )

            persona = persona_by_id.get(persona_id)
            if persona is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} references unknown persona `{persona_id}`."
                )

            # Resolve rubric: scenario-level, then defaults, then error
            rubric_id = item.rubric
            if rubric_id is None and scenario_collection.metadata.defaults is not None:
                rubric_id = scenario_collection.metadata.defaults.rubric
            if rubric_id is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} has no rubric and no default rubric is set."
                )

            rubric_item = rubric_by_id.get(rubric_id)
            if rubric_item is None:
                raise AgentProbeConfigError(
                    f"Scenario {item.id} references unknown rubric `{rubric_id}`."
                )

            prepared_runs.append(
                _PreparedScenarioRun(
                    adapter_factory=_make_adapter,
                    scenario=item,
                    persona=persona,
                    rubric=rubric_item,
                    ordinal=scenario_ordinal,
                    total=scenario_total,
                )
            )

        results: list[ScenarioRunResult] = []
        if parallel:
            for prepared in prepared_runs:
                if progress_callback is not None:
                    progress_callback(
                        RunProgressEvent(
                            kind="scenario_started",
                            scenario_id=prepared.scenario.id,
                            scenario_name=prepared.scenario.name,
                            scenario_index=prepared.index,
                            scenario_total=prepared.total,
                        )
                    )

            tasks = [
                asyncio.create_task(
                    _run_prepared_scenario_capturing_errors(
                        prepared,
                        defaults=scenario_collection.metadata.defaults,
                        oai_client=oai_client,
                        recorder=recorder,
                    )
                )
                for prepared in prepared_runs
            ]
            results_by_ordinal: dict[int, ScenarioRunResult] = {}
            first_error: Exception | None = None
            for task in asyncio.as_completed(tasks):
                outcome = await task
                prepared = outcome.prepared
                if outcome.error is not None:
                    if progress_callback is not None:
                        progress_callback(
                            RunProgressEvent(
                                kind="scenario_error",
                                scenario_id=prepared.scenario.id,
                                scenario_name=prepared.scenario.name,
                                scenario_index=prepared.index,
                                scenario_total=prepared.total,
                                error=outcome.error,
                            )
                        )
                    if first_error is None:
                        first_error = outcome.error
                    continue

                scenario_result = outcome.result
                if scenario_result is None:
                    continue
                results_by_ordinal[prepared.ordinal] = scenario_result
                if progress_callback is not None:
                    progress_callback(
                        RunProgressEvent(
                            kind="scenario_finished",
                            scenario_id=scenario_result.scenario_id,
                            scenario_name=scenario_result.scenario_name,
                            scenario_index=prepared.index,
                            scenario_total=prepared.total,
                            passed=scenario_result.passed,
                            overall_score=scenario_result.overall_score,
                        )
                    )

            if first_error is not None:
                raise first_error
            results = [
                results_by_ordinal[index] for index in range(len(prepared_runs))
            ]
        else:
            for prepared in prepared_runs:
                if progress_callback is not None:
                    progress_callback(
                        RunProgressEvent(
                            kind="scenario_started",
                            scenario_id=prepared.scenario.id,
                            scenario_name=prepared.scenario.name,
                            scenario_index=prepared.index,
                            scenario_total=prepared.total,
                        )
                    )
                try:
                    scenario_result = await _run_prepared_scenario(
                        prepared,
                        defaults=scenario_collection.metadata.defaults,
                        oai_client=oai_client,
                        recorder=recorder,
                    )
                except Exception as exc:
                    if progress_callback is not None:
                        progress_callback(
                            RunProgressEvent(
                                kind="scenario_error",
                                scenario_id=prepared.scenario.id,
                                scenario_name=prepared.scenario.name,
                                scenario_index=prepared.index,
                                scenario_total=prepared.total,
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
                            scenario_index=prepared.index,
                            scenario_total=prepared.total,
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


async def _run_prepared_scenario(
    prepared: _PreparedScenarioRun,
    *,
    defaults: ScenarioDefaults | None,
    oai_client: openai.AsyncClient,
    recorder: RunRecorder | None,
) -> ScenarioRunResult:
    adapter = prepared.adapter_factory()
    return await run_scenario(
        adapter,
        prepared.scenario,
        prepared.persona,
        prepared.rubric,
        defaults=defaults,
        oai_client=oai_client,
        recorder=recorder,
        scenario_ordinal=prepared.ordinal,
        adapter_factory=prepared.adapter_factory,
    )


async def _run_prepared_scenario_capturing_errors(
    prepared: _PreparedScenarioRun,
    *,
    defaults: ScenarioDefaults | None,
    oai_client: openai.AsyncClient,
    recorder: RunRecorder | None,
) -> _ScenarioExecutionOutcome:
    try:
        result = await _run_prepared_scenario(
            prepared,
            defaults=defaults,
            oai_client=oai_client,
            recorder=recorder,
        )
    except Exception as exc:
        return _ScenarioExecutionOutcome(prepared=prepared, error=exc)
    return _ScenarioExecutionOutcome(prepared=prepared, result=result)


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


def _resolve_max_turns(
    scenario: Scenario,
    defaults: ScenarioDefaults | None,
) -> int | None:
    if scenario.max_turns is not None:
        return scenario.max_turns
    if defaults is not None:
        return defaults.max_turns
    return None


def _increment_user_turn_count(
    current: int,
    *,
    scenario_id: str,
    max_turns: int | None,
) -> int:
    next_count = current + 1
    if max_turns is not None and next_count > max_turns:
        raise _ScenarioMaxTurnsExceeded(
            scenario_id=scenario_id,
            max_turns=max_turns,
        )
    return next_count


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
    *,
    termination: ScenarioTermination | None = None,
) -> str:
    lines = ["Conversation Transcript", ""]

    if termination is not None:
        lines.append(f"Evaluator Note: {termination.message}")
        lines.append("")

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
