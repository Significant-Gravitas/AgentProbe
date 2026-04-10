import type {
  AdapterReply,
  ConversationTurn,
  Endpoints,
  Persona,
  Rubric,
  RubricScore,
  Scenario,
  ScenarioDefaults,
  ScenarioRunResult,
  ScenarioTermination,
  Session,
  ToolCallRecord,
  RunProgressEvent,
  RunResult,
  CheckpointAssertion,
  CheckpointResult,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import {
  renderTemplate,
} from "../../shared/utils/template.ts";
import {
  parseEndpointsYaml,
  parsePersonaYaml,
  parseRubricsYaml,
  parseScenariosInput,
} from "../validation/load-suite.ts";
import { buildEndpointAdapter, type EndpointAdapter } from "../../providers/sdk/adapters.ts";
import { OpenAiResponsesClient } from "../../providers/sdk/openai-responses.ts";
import { generatePersonaStep, resolvePersonaModel } from "./simulator.ts";
import { judgeResponse } from "./judge.ts";

const resetsRequiringReinit = new Set(["new", "fresh_agent"]);

export type RunRecorder = {
  recordRunStarted?: (options: {
    endpoint: string;
    scenarios: string;
    personas: string;
    rubric: string;
    scenarioFilter?: string;
    tags?: string;
  }) => string;
  recordRunConfiguration?: (options: {
    endpointConfig: Endpoints;
    scenarioCollection: ReturnType<typeof parseScenariosInput>;
    personaCollection: ReturnType<typeof parsePersonaYaml>;
    rubricCollection: ReturnType<typeof parseRubricsYaml>;
    selectedScenarios: Scenario[];
    scenarioFilter?: string;
    tags?: string;
  }) => void;
  recordRunFinished?: (result: RunResult) => void;
  recordRunError?: (error: Error, options: { exitCode: number }) => void;
  recordScenarioStarted?: (options: {
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    ordinal?: number;
  }) => number;
  recordScenarioFinished?: (
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ) => void;
  recordScenarioError?: (scenarioRunId: number, error: Error) => void;
  recordTurn?: (scenarioRunId: number, options: {
    turnIndex: number;
    turn: ConversationTurn;
    source: string;
    generatorModel?: string;
  }) => void;
  recordAssistantReply?: (scenarioRunId: number, options: {
    turnIndex: number;
    reply: AdapterReply;
  }) => void;
  recordCheckpoint?: (scenarioRunId: number, options: {
    checkpointIndex: number;
    precedingTurnIndex?: number;
    assertions: CheckpointAssertion[];
    result: CheckpointResult;
  }) => void;
  recordJudgeResult?: (scenarioRunId: number, options: {
    rubric: Rubric;
    score: RubricScore;
    overallScore: number;
  }) => void;
};

function effectiveSessions(scenario: Scenario): Session[] {
  if (scenario.sessions.length > 0) {
    return scenario.sessions;
  }
  if (scenario.turns.length > 0) {
    return [
      {
        id: "__flat__",
        timeOffset: "0h",
        reset: "none",
        turns: scenario.turns,
      },
    ];
  }
  return [];
}

function renderTurnText(
  content: string | undefined,
  context: Record<string, unknown>,
): string | undefined {
  if (!content) {
    return undefined;
  }
  return renderTemplate(content, context);
}

function buildRunContext(options: {
  baseContext: Record<string, unknown>;
  sessionState: Record<string, unknown>;
  transcript: ConversationTurn[];
  lastMessage?: ConversationTurn;
  lastReply?: AdapterReply;
}): Record<string, unknown> {
  return {
    ...options.baseContext,
    ...options.sessionState,
    session: options.sessionState,
    session_state: options.sessionState,
    transcript: options.transcript,
    last_message: options.lastMessage,
    lastMessage: options.lastMessage,
    last_reply: options.lastReply
      ? {
          assistant_text: options.lastReply.assistantText,
          tool_calls: options.lastReply.toolCalls,
          raw_exchange: options.lastReply.rawExchange,
          usage: options.lastReply.usage,
          latency_ms: options.lastReply.latencyMs,
        }
      : undefined,
    lastReply: options.lastReply,
  };
}

function incrementUserTurnCount(
  current: number,
  options: { scenarioId: string; maxTurns?: number },
): number {
  const next = current + 1;
  if (options.maxTurns !== undefined && next > options.maxTurns) {
    throw new AgentProbeRuntimeError(
      `Scenario ${options.scenarioId} exceeded max_turns=${options.maxTurns}.`,
    );
  }
  return next;
}

function evaluateCheckpointTurn(
  assertions: CheckpointAssertion[],
  lastReply?: AdapterReply,
): CheckpointResult {
  const failures: string[] = [];
  if (!lastReply) {
    return {
      passed: false,
      failures: ["Checkpoint had no preceding assistant reply to evaluate."],
    };
  }

  for (const assertion of assertions) {
    if (assertion.toolCalled) {
      const matchingTool = lastReply.toolCalls.find(
        (toolCall) => toolCall.name === assertion.toolCalled,
      );
      if (!matchingTool) {
        failures.push(`Expected tool ${assertion.toolCalled} was not called.`);
      } else if (assertion.withArgs) {
        for (const [key, value] of Object.entries(assertion.withArgs)) {
          if (JSON.stringify(matchingTool.args[key]) !== JSON.stringify(value)) {
            failures.push(
              `Tool ${assertion.toolCalled} did not receive expected argument ${key}.`,
            );
          }
        }
      }
    }

    if (
      assertion.responseMentions &&
      !lastReply.assistantText.includes(assertion.responseMentions)
    ) {
      failures.push(
        `Assistant response did not mention ${assertion.responseMentions}.`,
      );
    }

    if (
      assertion.responseContainsAny.length > 0 &&
      !assertion.responseContainsAny.some((item) =>
        lastReply.assistantText.includes(item),
      )
    ) {
      failures.push(
        "Assistant response did not contain any required checkpoint text.",
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

function displayTurnRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "system") {
    return "System";
  }
  if (normalized === "assistant") {
    return "Assistant";
  }
  if (normalized === "user") {
    return "User";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatTranscriptForJudge(
  transcript: ConversationTurn[],
  toolCallsByTurn: Record<number, ToolCallRecord[]>,
  termination?: ScenarioTermination,
): string {
  const lines = ["Conversation Transcript", ""];
  if (termination) {
    lines.push(`Evaluator Note: ${termination.message}`, "");
  }

  transcript.forEach((turn, index) => {
    const content = (turn.content ?? "").trim();
    if (!content) {
      return;
    }
    lines.push(`${displayTurnRole(turn.role)}: ${content}`);
    const toolCalls = toolCallsByTurn[index] ?? [];
    if (toolCalls.length > 0) {
      lines.push("Tool Calls:");
      for (const toolCall of toolCalls) {
        lines.push(`- ${toolCall.name}: ${JSON.stringify(toolCall.args)}`);
        const output =
          toolCall.raw &&
          typeof toolCall.raw === "object" &&
          !Array.isArray(toolCall.raw) &&
          "output" in toolCall.raw
            ? toolCall.raw.output
            : undefined;
        if (output !== undefined) {
          lines.push(`  Output: ${JSON.stringify(output)}`);
        }
      }
    }
  });

  return lines.join("\n").trim();
}

function overallScore(rubric: Rubric, score: RubricScore): number {
  const totalWeight =
    rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) || 1;
  let weightedTotal = 0;
  for (const dimension of rubric.dimensions) {
    const rawScore = score.dimensions[dimension.id]?.score ?? 0;
    const normalized = rawScore / (dimension.scale.points ?? 1);
    weightedTotal += normalized * dimension.weight;
  }
  return weightedTotal / totalWeight;
}

function resolveMaxTurns(
  scenario: Scenario,
  defaults?: ScenarioDefaults,
): number | undefined {
  return scenario.maxTurns ?? defaults?.maxTurns;
}

function cloneRubric(rubric: Rubric): Rubric {
  return structuredClone(rubric);
}

function renderRubricTemplates(
  rubric: Rubric,
  context: Record<string, unknown>,
): Rubric {
  const rendered = cloneRubric(rubric);
  rendered.metaPrompt = renderTemplate(rendered.metaPrompt, context);
  rendered.dimensions = rendered.dimensions.map((dimension) => ({
    ...dimension,
    judgePrompt: renderTemplate(dimension.judgePrompt, context),
  }));
  return rendered;
}

export async function runScenario(
  adapter: EndpointAdapter,
  scenario: Scenario,
  persona: Persona,
  rubric: Rubric,
  options: {
    defaults?: ScenarioDefaults;
    client: OpenAiResponsesClient;
    recorder?: RunRecorder;
    scenarioOrdinal?: number;
    dryRun?: boolean;
    adapterFactory?: () => EndpointAdapter;
  },
): Promise<ScenarioRunResult> {
  if (options.dryRun) {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      personaId: persona.id,
      rubricId: rubric.id,
      passed: true,
      overallScore: 0,
      transcript: [],
      checkpoints: [],
      toolCallsByTurn: {},
      renderedTurns: [],
    };
  }

  const fullTranscript: ConversationTurn[] = [];
  let sessionTranscript: ConversationTurn[] = [];
  const checkpoints: CheckpointResult[] = [];
  const toolCallsByTurn: Record<number, ToolCallRecord[]> = {};
  const renderedTurns: Array<Record<string, unknown>> = [];
  let termination: ScenarioTermination | undefined;
  let lastMessage: ConversationTurn | undefined;
  let lastReply: AdapterReply | undefined;
  let sessionState: Record<string, unknown> = {};
  let userTurnCount = 0;
  let currentAdapter = adapter;
  const maxTurns = resolveMaxTurns(scenario, options.defaults);
  const personaModel = resolvePersonaModel(persona);
  const baseContext: Record<string, unknown> = {
    ...(scenario.context?.injectedData ?? {}),
    scenario,
    persona,
    rubric,
    expectations: scenario.expectations,
    context: scenario.context,
    defaults: options.defaults,
  };

  const scenarioRunId = options.recorder?.recordScenarioStarted?.({
    scenario,
    persona,
    rubric,
    ordinal: options.scenarioOrdinal,
  });

  const submitUserTurn = async (
    userText: string,
    optionsForTurn: { source: string; generatorModel?: string },
  ): Promise<void> => {
    userTurnCount = incrementUserTurnCount(userTurnCount, {
      scenarioId: scenario.id,
      maxTurns,
    });
    const userTurn: ConversationTurn = { role: "user", content: userText };
    lastMessage = userTurn;
    sessionTranscript.push(userTurn);
    fullTranscript.push(userTurn);
    const userTurnIndex = fullTranscript.length - 1;
    if (scenarioRunId !== undefined) {
      options.recorder?.recordTurn?.(scenarioRunId, {
        turnIndex: userTurnIndex,
        turn: userTurn,
        source: optionsForTurn.source,
        generatorModel: optionsForTurn.generatorModel,
      });
    }

    const replyContext = buildRunContext({
      baseContext,
      sessionState,
      transcript: sessionTranscript,
      lastMessage,
      lastReply,
    });
    const reply = await currentAdapter.sendUserTurn(replyContext);
    lastReply = reply;

    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: reply.assistantText,
    };
    sessionTranscript.push(assistantTurn);
    fullTranscript.push(assistantTurn);
    const assistantTurnIndex = fullTranscript.length - 1;
    if (scenarioRunId !== undefined) {
      options.recorder?.recordTurn?.(scenarioRunId, {
        turnIndex: assistantTurnIndex,
        turn: assistantTurn,
        source: "assistant",
      });
      options.recorder?.recordAssistantReply?.(scenarioRunId, {
        turnIndex: assistantTurnIndex,
        reply,
      });
    }
    if (reply.toolCalls.length > 0) {
      toolCallsByTurn[assistantTurnIndex] = [...reply.toolCalls];
    }
  };

  const sessions = effectiveSessions(scenario);
  const systemPrompt = scenario.context?.systemPrompt
    ? renderTemplate(scenario.context.systemPrompt, baseContext)
    : undefined;

  try {
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const session = sessions[sessionIndex];
      const isFirst = sessionIndex === 0;
      if (!isFirst && resetsRequiringReinit.has(session.reset)) {
        await currentAdapter.closeScenario(
          buildRunContext({
            baseContext,
            sessionState,
            transcript: sessionTranscript,
            lastMessage,
            lastReply,
          }),
        );
        if (session.reset === "fresh_agent" && options.adapterFactory) {
          currentAdapter = options.adapterFactory();
        }
        lastMessage = undefined;
        lastReply = undefined;
        sessionState = {};
        sessionTranscript = [];
      }

      if (!isFirst) {
        const boundaryTurn: ConversationTurn = {
          role: "system",
          content: `--- Session boundary: ${session.id ?? `session-${sessionIndex + 1}`} (reset=${session.reset}, time_offset=${session.timeOffset}) ---`,
        };
        fullTranscript.push(boundaryTurn);
        if (scenarioRunId !== undefined) {
          options.recorder?.recordTurn?.(scenarioRunId, {
            turnIndex: fullTranscript.length - 1,
            turn: boundaryTurn,
            source: "session_boundary",
          });
        }
      }

      if (isFirst || resetsRequiringReinit.has(session.reset)) {
        await currentAdapter.healthCheck(baseContext);
        sessionState = await currentAdapter.openScenario(baseContext);
        if (systemPrompt) {
          const systemTurn: ConversationTurn = {
            role: "system",
            content: systemPrompt,
          };
          sessionTranscript.push(systemTurn);
          fullTranscript.push(systemTurn);
          if (scenarioRunId !== undefined) {
            options.recorder?.recordTurn?.(scenarioRunId, {
              turnIndex: fullTranscript.length - 1,
              turn: systemTurn,
              source: "system_prompt",
            });
          }
        }
      }

      let scriptedUserTurnSeen = false;
      for (const turn of session.turns) {
        const renderContext = buildRunContext({
          baseContext,
          sessionState,
          transcript: sessionTranscript,
          lastMessage,
          lastReply,
        });

        if (turn.role === "checkpoint") {
          renderedTurns.push({
            role: "checkpoint",
            assert: turn.assertions,
          });
          const checkpointResult = evaluateCheckpointTurn(turn.assertions, lastReply);
          checkpoints.push(checkpointResult);
          if (scenarioRunId !== undefined) {
            options.recorder?.recordCheckpoint?.(scenarioRunId, {
              checkpointIndex: checkpoints.length - 1,
              precedingTurnIndex: fullTranscript.length > 0 ? fullTranscript.length - 1 : undefined,
              assertions: turn.assertions,
              result: checkpointResult,
            });
          }
          continue;
        }

        if (turn.role === "inject") {
          const rendered = renderTurnText(turn.content, renderContext);
          renderedTurns.push({
            role: "inject",
            content: rendered,
          });
          if (rendered) {
            const injectTurn: ConversationTurn = {
              role: "system",
              content: rendered,
            };
            sessionTranscript.push(injectTurn);
            fullTranscript.push(injectTurn);
            if (scenarioRunId !== undefined) {
              options.recorder?.recordTurn?.(scenarioRunId, {
                turnIndex: fullTranscript.length - 1,
                turn: injectTurn,
                source: "inject",
              });
            }
          }
          continue;
        }

        scriptedUserTurnSeen = true;
        const renderedGuidance = renderTurnText(turn.content, renderContext);
        let messageText: string;
        let source: string;
        let generatorModel: string | undefined;
        if (turn.useExactMessage) {
          messageText = renderedGuidance ?? "";
          source = "user_exact";
        } else {
          const step = await generatePersonaStep(
            persona,
            sessionTranscript,
            options.client,
            {
              guidance: renderedGuidance,
              requireResponse: true,
            },
          );
          if (!step.message) {
            throw new AgentProbeRuntimeError(
              "Persona simulator did not return a message for a required user turn.",
            );
          }
          messageText = step.message;
          source = "user_guided";
          generatorModel = personaModel;
        }

        renderedTurns.push({
          role: "user",
          content: messageText,
        });
        await submitUserTurn(messageText, { source, generatorModel });
      }

      if (scriptedUserTurnSeen) {
        while (true) {
          const step = await generatePersonaStep(
            persona,
            sessionTranscript,
            options.client,
            {
              requireResponse: false,
            },
          );
          if (step.status !== "continue") {
            break;
          }
          if (!step.message) {
            throw new AgentProbeRuntimeError(
              "Persona simulator returned `continue` without a follow-up message.",
            );
          }
          renderedTurns.push({
            role: "user",
            content: step.message,
            source: "user_generated",
          });
          await submitUserTurn(step.message, {
            source: "user_generated",
            generatorModel: personaModel,
          });
        }
      }
    }
  } catch (error) {
    if (
      error instanceof AgentProbeRuntimeError &&
      /exceeded max_turns=/.test(error.message)
    ) {
      termination = {
        reason: "max_turns_exceeded",
        message: error.message,
        maxTurns,
      };
    } else {
      if (scenarioRunId !== undefined) {
        options.recorder?.recordScenarioError?.(
          scenarioRunId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    }
  } finally {
    await currentAdapter.closeScenario(
      buildRunContext({
        baseContext,
        sessionState,
        transcript: sessionTranscript,
        lastMessage,
        lastReply,
      }),
    );
  }

  const rubricContext = buildRunContext({
    baseContext,
    sessionState,
    transcript: fullTranscript,
    lastMessage,
    lastReply,
  });
  rubricContext.turns = renderedTurns;
  rubricContext.termination = termination;
  const renderedRubric = renderRubricTemplates(rubric, rubricContext);
  const transcriptText = formatTranscriptForJudge(
    fullTranscript,
    toolCallsByTurn,
    termination,
  );
  const score = await judgeResponse(renderedRubric, transcriptText, options.client);
  const finalScore = overallScore(renderedRubric, score);
  if (scenarioRunId !== undefined) {
    options.recorder?.recordJudgeResult?.(scenarioRunId, {
      rubric: renderedRubric,
      score,
      overallScore: finalScore,
    });
  }

  const result: ScenarioRunResult = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    personaId: persona.id,
    rubricId: rubric.id,
    passed: score.passed,
    overallScore: finalScore,
    transcript: fullTranscript,
    checkpoints,
    toolCallsByTurn,
    judgeScore: score,
    renderedTurns,
  };
  if (scenarioRunId !== undefined) {
    options.recorder?.recordScenarioFinished?.(scenarioRunId, { result });
  }
  return result;
}

type PreparedRun = {
  adapterFactory: () => EndpointAdapter;
  scenario: Scenario;
  persona: Persona;
  rubric: Rubric;
  ordinal: number;
  total: number;
};

export async function runSuite(options: {
  endpoint: string;
  scenarios: string;
  personas: string;
  rubric: string;
  scenarioId?: string;
  tags?: string;
  adapterFactory?: (endpoint: Endpoints) => EndpointAdapter;
  client: OpenAiResponsesClient;
  recorder?: RunRecorder;
  progressCallback?: (event: RunProgressEvent) => void;
  parallel?: boolean;
  dryRun?: boolean;
}): Promise<RunResult> {
  const runId = options.recorder?.recordRunStarted?.({
    endpoint: options.endpoint,
    scenarios: options.scenarios,
    personas: options.personas,
    rubric: options.rubric,
    scenarioFilter: options.scenarioId,
    tags: options.tags,
  });

  try {
    const endpointConfig = parseEndpointsYaml(options.endpoint);
    const scenarioCollection = parseScenariosInput(options.scenarios);
    const personaCollection = parsePersonaYaml(options.personas);
    const rubricCollection = parseRubricsYaml(options.rubric);

    const personasById = new Map(
      personaCollection.personas.map((item) => [item.id, item]),
    );
    const rubricsById = new Map(
      rubricCollection.rubrics.map((item) => [item.id, item]),
    );
    const requestedTags = new Set(
      (options.tags ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

    let selectedScenarios = [...scenarioCollection.scenarios];
    if (options.scenarioId) {
      selectedScenarios = selectedScenarios.filter(
        (item) => item.id === options.scenarioId,
      );
    }
    if (requestedTags.size > 0) {
      selectedScenarios = selectedScenarios.filter((item) =>
        item.tags.some((tag) => requestedTags.has(tag)),
      );
    }
    if (selectedScenarios.length === 0) {
      throw new AgentProbeConfigError(
        "No scenarios matched the requested filters.",
      );
    }

    options.recorder?.recordRunConfiguration?.({
      endpointConfig,
      scenarioCollection,
      personaCollection,
      rubricCollection,
      selectedScenarios,
      scenarioFilter: options.scenarioId,
      tags: options.tags,
    });

    options.progressCallback?.({
      kind: "suite_started",
      scenarioTotal: selectedScenarios.length,
    });

    const preparedRuns: PreparedRun[] = selectedScenarios.map((scenario, ordinal) => {
      const personaId = scenario.persona;
      if (!personaId) {
        throw new AgentProbeConfigError(
          `Scenario ${scenario.id} has no persona (and no default was provided).`,
        );
      }
      const persona = personasById.get(personaId);
      if (!persona) {
        throw new AgentProbeConfigError(
          `Scenario ${scenario.id} references unknown persona \`${personaId}\`.`,
        );
      }
      const rubricId = scenario.rubric;
      if (!rubricId) {
        throw new AgentProbeConfigError(
          `Scenario ${scenario.id} has no rubric (and no default was provided).`,
        );
      }
      const rubric = rubricsById.get(rubricId);
      if (!rubric) {
        throw new AgentProbeConfigError(
          `Scenario ${scenario.id} references unknown rubric \`${rubricId}\`.`,
        );
      }

      return {
        scenario,
        persona,
        rubric,
        ordinal,
        total: selectedScenarios.length,
        adapterFactory: () =>
          options.adapterFactory
            ? options.adapterFactory(endpointConfig)
            : buildEndpointAdapter(endpointConfig),
      };
    });

    const executePrepared = async (
      prepared: PreparedRun,
    ): Promise<ScenarioRunResult> => {
      return await runScenario(prepared.adapterFactory(), prepared.scenario, prepared.persona, prepared.rubric, {
        defaults: scenarioCollection.metadata.defaults,
        client: options.client,
        recorder: options.recorder,
        scenarioOrdinal: prepared.ordinal,
        dryRun: options.dryRun,
        adapterFactory: prepared.adapterFactory,
      });
    };

    let results: ScenarioRunResult[] = [];
    if (options.parallel) {
      preparedRuns.forEach((prepared) => {
        options.progressCallback?.({
          kind: "scenario_started",
          scenarioId: prepared.scenario.id,
          scenarioName: prepared.scenario.name,
          scenarioIndex: prepared.ordinal + 1,
          scenarioTotal: prepared.total,
        });
      });

      const orderedResults = new Array<ScenarioRunResult>(preparedRuns.length);
      const failures: Error[] = [];
      await Promise.all(
        preparedRuns.map(async (prepared) => {
          try {
            const result = await executePrepared(prepared);
            orderedResults[prepared.ordinal] = result;
            options.progressCallback?.({
              kind: "scenario_finished",
              scenarioId: result.scenarioId,
              scenarioName: result.scenarioName,
              scenarioIndex: prepared.ordinal + 1,
              scenarioTotal: prepared.total,
              passed: result.passed,
              overallScore: result.overallScore,
            });
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failures.push(failure);
            options.progressCallback?.({
              kind: "scenario_error",
              scenarioId: prepared.scenario.id,
              scenarioName: prepared.scenario.name,
              scenarioIndex: prepared.ordinal + 1,
              scenarioTotal: prepared.total,
              error: failure,
            });
          }
        }),
      );
      if (failures.length > 0) {
        throw failures[0];
      }
      results = orderedResults.filter(Boolean);
    } else {
      for (const prepared of preparedRuns) {
        options.progressCallback?.({
          kind: "scenario_started",
          scenarioId: prepared.scenario.id,
          scenarioName: prepared.scenario.name,
          scenarioIndex: prepared.ordinal + 1,
          scenarioTotal: prepared.total,
        });
        try {
          const result = await executePrepared(prepared);
          results.push(result);
          options.progressCallback?.({
            kind: "scenario_finished",
            scenarioId: result.scenarioId,
            scenarioName: result.scenarioName,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            passed: result.passed,
            overallScore: result.overallScore,
          });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          options.progressCallback?.({
            kind: "scenario_error",
            scenarioId: prepared.scenario.id,
            scenarioName: prepared.scenario.name,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            error: failure,
          });
          throw failure;
        }
      }
    }

    const passed = results.every((item) => item.passed);
    const result: RunResult = {
      runId,
      passed,
      exitCode: passed ? 0 : 1,
      results,
    };
    options.recorder?.recordRunFinished?.(result);
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const exitCode =
      failure instanceof AgentProbeConfigError ? 2 : 3;
    options.recorder?.recordRunError?.(failure, { exitCode });
    throw failure;
  }
}
