import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  buildEndpointAdapter,
  type EndpointAdapter,
} from "../../providers/sdk/adapters.ts";
import { resolveAuth } from "../../providers/sdk/autogpt-auth.ts";
import type { OpenAiResponsesClient } from "../../providers/sdk/openai-responses.ts";
import type {
  AdapterReply,
  CheckpointAssertion,
  CheckpointResult,
  ConversationTurn,
  Endpoints,
  Persona,
  Rubric,
  RubricScore,
  RunProgressEvent,
  RunResult,
  Scenario,
  ScenarioDefaults,
  ScenarioRunResult,
  ScenarioTermination,
  Session,
  ToolCallRecord,
  UploadedFile,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeHarnessError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import { logDebug, logInfo, logWarn } from "../../shared/utils/logging.ts";
import { renderTemplate } from "../../shared/utils/template.ts";
import {
  parseEndpointsYaml,
  parsePersonaYaml,
  parseRubricsYaml,
  parseScenariosInput,
  parseTimeOffset,
} from "../validation/load-suite.ts";
import { judgeResponse } from "./judge.ts";
import { generatePersonaStep, resolvePersonaModel } from "./simulator.ts";

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
    userId?: string;
  }) => number;
  recordScenarioFinished?: (
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ) => void;
  recordScenarioError?: (scenarioRunId: number, error: Error) => void;
  recordTurn?: (
    scenarioRunId: number,
    options: {
      turnIndex: number;
      turn: ConversationTurn;
      source: string;
      generatorModel?: string;
    },
  ) => void;
  recordAssistantReply?: (
    scenarioRunId: number,
    options: {
      turnIndex: number;
      reply: AdapterReply;
    },
  ) => void;
  recordCheckpoint?: (
    scenarioRunId: number,
    options: {
      checkpointIndex: number;
      precedingTurnIndex?: number;
      assertions: CheckpointAssertion[];
      result: CheckpointResult;
    },
  ) => void;
  recordJudgeResult?: (
    scenarioRunId: number,
    options: {
      rubric: Rubric;
      score: RubricScore;
      overallScore: number;
    },
  ) => void;
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

function isMaxTurnsExceededError(
  error: unknown,
): error is AgentProbeRuntimeError {
  return (
    error instanceof AgentProbeRuntimeError &&
    /exceeded max_turns=/.test(error.message)
  );
}

function parseBaseDate(baseDate?: string): Date {
  if (!baseDate) {
    return new Date();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseDate.trim());
  if (!match) {
    logWarn(
      `Invalid base_date '${baseDate}' — expected YYYY-MM-DD format. Falling back to current time.`,
    );
    return new Date();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime())) {
    logWarn(
      `Invalid base_date '${baseDate}' — expected YYYY-MM-DD format. Falling back to current time.`,
    );
    return new Date();
  }
  return parsed;
}

function formatCurrentDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hour = String(value.getUTCHours()).padStart(2, "0");
  const minute = String(value.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
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
          if (
            JSON.stringify(matchingTool.args[key]) !== JSON.stringify(value)
          ) {
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

    for (const forbidden of assertion.responseMustNotContain ?? []) {
      if (
        lastReply.assistantText.toLowerCase().includes(forbidden.toLowerCase())
      ) {
        failures.push(
          `Response contains forbidden string: ${JSON.stringify(forbidden)}`,
        );
      }
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
    const toolCalls = toolCallsByTurn[index] ?? [];
    const role = turn.role.trim().toLowerCase();

    if (role === "assistant" && toolCalls.length > 0) {
      lines.push(
        "Assistant Tool Calls (executed before the assistant's reply):",
      );
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

    if (!content) {
      return;
    }
    lines.push(`${displayTurnRole(turn.role)}: ${content}`);
  });

  return lines.join("\n").trim();
}

function overallScore(rubric: Rubric, score: RubricScore): number {
  const totalWeight =
    rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) ||
    1;
  let weightedTotal = 0;
  const dimensionScores = new Map<string, number>();
  for (const dimension of rubric.dimensions) {
    const rawScore = score.dimensions[dimension.id]?.score ?? 0;
    const normalized = rawScore / (dimension.scale.points ?? 1);
    weightedTotal += normalized * dimension.weight;
    dimensionScores.set(dimension.id, rawScore);
  }
  const computedScore = weightedTotal / totalWeight;
  if (computedScore < rubric.passThreshold) {
    score.passed = false;
  }
  for (const condition of rubric.scoringOverrides?.autoFailConditions ?? []) {
    const dimensionScore = dimensionScores.get(condition.dimension);
    if (dimensionScore === undefined) {
      continue;
    }
    if (condition.below !== undefined && dimensionScore < condition.below) {
      score.passed = false;
    }
    if (condition.above !== undefined && dimensionScore > condition.above) {
      score.passed = false;
    }
  }
  return computedScore;
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
    userId?: string;
    scenariosPath?: string;
  },
): Promise<ScenarioRunResult> {
  if (options.dryRun) {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      personaId: persona.id,
      rubricId: rubric.id,
      userId: options.userId,
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
  let harnessError: AgentProbeHarnessError | undefined;
  let lastMessage: ConversationTurn | undefined;
  let lastReply: AdapterReply | undefined;
  let sessionState: Record<string, unknown> = {};
  let userTurnCount = 0;
  let currentAdapter = adapter;
  const maxTurns = resolveMaxTurns(scenario, options.defaults);
  const personaModel = resolvePersonaModel(persona);
  const baseDate = parseBaseDate(scenario.baseDate);
  const baseContext: Record<string, unknown> = {
    ...(scenario.context?.injectedData ?? {}),
    scenario,
    persona,
    rubric,
    expectations: scenario.expectations,
    context: scenario.context,
    defaults: options.defaults,
    user_name: scenario.context?.userName,
    userName: scenario.context?.userName,
    user_id: options.userId,
    userId: options.userId,
    copilot_mode: scenario.context?.copilotMode,
    copilotMode: scenario.context?.copilotMode,
  };

  const scenarioRunId = options.recorder?.recordScenarioStarted?.({
    scenario,
    persona,
    rubric,
    ordinal: options.scenarioOrdinal,
    userId: options.userId,
  });

  const submitUserTurn = async (
    userText: string,
    optionsForTurn: {
      source: string;
      generatorModel?: string;
      maxTurns?: number;
      currentUserTurnCount: number;
      setUserTurnCount: (value: number) => void;
      fileIds?: string[];
    },
  ): Promise<void> => {
    const nextUserTurnCount = incrementUserTurnCount(
      optionsForTurn.currentUserTurnCount,
      {
        scenarioId: scenario.id,
        maxTurns: optionsForTurn.maxTurns,
      },
    );
    optionsForTurn.setUserTurnCount(nextUserTurnCount);
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
    if (optionsForTurn.fileIds && optionsForTurn.fileIds.length > 0) {
      replyContext.file_ids = optionsForTurn.fileIds;
      replyContext.fileIds = optionsForTurn.fileIds;
    }
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

  try {
    for (
      let sessionIndex = 0;
      sessionIndex < sessions.length;
      sessionIndex += 1
    ) {
      const session = sessions[sessionIndex];
      const isFirst = sessionIndex === 0;
      let sessionUserTurnCount = 0;
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
          logDebug(
            `Resetting adapter for fresh_agent session ${session.id ?? sessionIndex + 1}`,
          );
          currentAdapter = options.adapterFactory();
        } else if (session.reset === "fresh_agent" && !options.adapterFactory) {
          logWarn(
            "fresh_agent reset requested but no adapter_factory provided — degrading to 'new' behavior. Results may be invalid.",
          );
        }
        lastMessage = undefined;
        lastReply = undefined;
        userTurnCount = 0;
        sessionState = {};
        sessionTranscript = [];
      }

      if (!isFirst) {
        const sessionLabel = session.id ?? `session-${sessionIndex + 1}`;
        const userIdPart = options.userId ? ` user_id: ${options.userId}` : "";
        const boundaryTurn: ConversationTurn = {
          role: "system",
          content: `--- Session boundary: session_id: ${sessionLabel} reset_policy: ${session.reset} time_offset: ${session.timeOffset}${userIdPart} ---`,
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

      const sessionDate = new Date(
        baseDate.getTime() + parseTimeOffset(session.timeOffset),
      );
      baseContext.current_date = formatCurrentDate(sessionDate);
      baseContext.currentDate = formatCurrentDate(sessionDate);

      if (isFirst || resetsRequiringReinit.has(session.reset)) {
        await currentAdapter.healthCheck(baseContext);
        sessionState = await currentAdapter.openScenario(baseContext);
        const systemPrompt = scenario.context?.systemPrompt
          ? renderTemplate(scenario.context.systemPrompt, baseContext)
          : undefined;
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

      const effectiveMaxTurns = session.maxTurns ?? maxTurns;
      try {
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
            const checkpointResult = evaluateCheckpointTurn(
              turn.assertions,
              lastReply,
            );
            checkpoints.push(checkpointResult);
            if (scenarioRunId !== undefined) {
              options.recorder?.recordCheckpoint?.(scenarioRunId, {
                checkpointIndex: checkpoints.length - 1,
                precedingTurnIndex:
                  fullTranscript.length > 0
                    ? fullTranscript.length - 1
                    : undefined,
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

          let uploadedFileIds: string[] | undefined;
          if (
            turn.role === "user" &&
            turn.attachments.length > 0 &&
            currentAdapter.uploadFile
          ) {
            const scenarioSourcePath = resolve(
              options.scenariosPath ?? "data",
            );
            const baseDir = existsSync(scenarioSourcePath) &&
              statSync(scenarioSourcePath).isDirectory()
              ? scenarioSourcePath
              : dirname(scenarioSourcePath);
            const uploaded: UploadedFile[] = [];
            for (const attachment of turn.attachments) {
              const resolvedPath = resolve(baseDir, attachment.path);
              const name = attachment.name ?? basename(resolvedPath);
              logInfo(`Uploading file: ${name} (${resolvedPath})`);
              const result = await currentAdapter.uploadFile(
                resolvedPath,
                name,
              );
              uploaded.push(result);
            }
            uploadedFileIds = uploaded.map((f) => f.fileId);
          }

          renderedTurns.push({
            role: "user",
            content: messageText,
          });
          await submitUserTurn(messageText, {
            source,
            generatorModel,
            fileIds: uploadedFileIds,
            maxTurns: effectiveMaxTurns,
            currentUserTurnCount:
              session.maxTurns !== undefined
                ? sessionUserTurnCount
                : userTurnCount,
            setUserTurnCount: (value) => {
              if (session.maxTurns !== undefined) {
                sessionUserTurnCount = value;
              } else {
                userTurnCount = value;
              }
            },
          });
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
              maxTurns: effectiveMaxTurns,
              currentUserTurnCount:
                session.maxTurns !== undefined
                  ? sessionUserTurnCount
                  : userTurnCount,
              setUserTurnCount: (value) => {
                if (session.maxTurns !== undefined) {
                  sessionUserTurnCount = value;
                } else {
                  userTurnCount = value;
                }
              },
            });
          }
        }
      } catch (error) {
        if (isMaxTurnsExceededError(error) && session.maxTurns !== undefined) {
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (isMaxTurnsExceededError(error)) {
      termination = {
        reason: "max_turns_exceeded",
        message: error.message,
        maxTurns,
      };
    } else if (error instanceof AgentProbeHarnessError) {
      harnessError = error;
      logWarn(`Harness failure in ${scenario.id}: ${error.message}`);
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

  if (harnessError) {
    const harnessResult: ScenarioRunResult = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      personaId: persona.id,
      rubricId: rubric.id,
      userId: options.userId,
      passed: false,
      failureKind: "harness",
      overallScore: 0,
      transcript: fullTranscript,
      checkpoints,
      toolCallsByTurn,
      judgeScore: {
        dimensions: {},
        overallNotes: `Harness failure: ${harnessError.message}`,
        passed: false,
        failureKind: "harness",
      },
      renderedTurns,
    };
    if (scenarioRunId !== undefined) {
      options.recorder?.recordScenarioFinished?.(scenarioRunId, {
        result: harnessResult,
      });
    }
    return harnessResult;
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
  const score = await judgeResponse(
    renderedRubric,
    transcriptText,
    options.client,
  );
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
    userId: options.userId,
    passed: score.passed,
    failureKind: score.failureKind,
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
  userId: string;
  iteration: number;
  displayId: string;
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
  parallelLimit?: number;
  dryRun?: boolean;
  repeat?: number;
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

    const requestedIds = new Set(
      (options.scenarioId ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

    let selectedScenarios = [...scenarioCollection.scenarios];
    if (requestedIds.size > 0) {
      selectedScenarios = selectedScenarios.filter(
        (item) => requestedIds.has(item.id) || requestedIds.has(item.name),
      );
    }
    if (requestedTags.size > 0) {
      selectedScenarios = selectedScenarios.filter((item) =>
        item.tags.some((tag) => requestedTags.has(tag)),
      );
    }
    if (selectedScenarios.length === 0) {
      if (options.scenarioId) {
        const available = scenarioCollection.scenarios.map(
          (s) => `${s.id} (${s.name})`,
        );
        throw new AgentProbeConfigError(
          `No scenario matching "${options.scenarioId}" found. Available: ${available.join(", ")}`,
        );
      }
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
      runId,
      scenarioTotal:
        selectedScenarios.length * Math.max(1, options.repeat ?? 1),
    });

    const preparedRuns: PreparedRun[] = [];
    const effectiveRepeat = Math.max(1, options.repeat ?? 1);
    logInfo(
      `Preparing ${selectedScenarios.length} scenario(s) across ${effectiveRepeat} iteration(s).`,
    );
    let ordinal = 0;
    for (const scenario of selectedScenarios) {
      for (let iteration = 1; iteration <= effectiveRepeat; iteration += 1) {
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

        const pinnedUserId = crypto.randomUUID();
        const pinnedUserName = scenario.context?.userName;
        preparedRuns.push({
          scenario,
          persona,
          rubric,
          ordinal,
          total: selectedScenarios.length * effectiveRepeat,
          userId: pinnedUserId,
          iteration,
          displayId:
            iteration > 1 ? `${scenario.id}#${iteration}` : scenario.id,
          adapterFactory: () =>
            options.adapterFactory
              ? options.adapterFactory(endpointConfig)
              : buildEndpointAdapter(endpointConfig, {
                  autogptAuthResolver: () =>
                    resolveAuth({
                      userId: pinnedUserId,
                      name: pinnedUserName,
                    }),
                }),
        });
        ordinal += 1;
      }
    }

    const executePrepared = async (
      prepared: PreparedRun,
    ): Promise<ScenarioRunResult> => {
      return await runScenario(
        prepared.adapterFactory(),
        prepared.scenario,
        prepared.persona,
        prepared.rubric,
        {
          defaults: scenarioCollection.metadata.defaults,
          client: options.client,
          recorder: options.recorder,
          scenarioOrdinal: prepared.ordinal,
          dryRun: options.dryRun,
          adapterFactory: prepared.adapterFactory,
          userId: prepared.userId,
          scenariosPath: options.scenarios,
        },
      );
    };

    const erroredScenarioResult = (
      prepared: PreparedRun,
      error: Error,
    ): ScenarioRunResult => {
      const isHarness = error instanceof AgentProbeHarnessError;
      return {
        scenarioId: prepared.displayId,
        scenarioName: prepared.scenario.name,
        personaId: prepared.persona.id,
        rubricId: prepared.rubric.id,
        userId: prepared.userId,
        passed: false,
        failureKind: isHarness ? "harness" : undefined,
        overallScore: 0,
        transcript: [],
        checkpoints: [],
        judgeScore: {
          dimensions: {},
          overallNotes: isHarness
            ? `Harness failure: ${error.message}`
            : `Scenario failed to execute: ${error.message}`,
          passed: false,
          failureKind: isHarness ? "harness" : undefined,
        },
      };
    };

    let results: ScenarioRunResult[] = [];
    const parallelEnabled =
      options.parallel || options.parallelLimit !== undefined;
    if (options.parallelLimit !== undefined && options.parallelLimit < 1) {
      throw new AgentProbeConfigError(
        "--parallel must be at least 1 when a limit is provided.",
      );
    }

    if (parallelEnabled) {
      const concurrencyLimit = Math.min(
        preparedRuns.length,
        Math.max(1, options.parallelLimit ?? preparedRuns.length),
      );
      const orderedResults = new Array<ScenarioRunResult | undefined>(
        preparedRuns.length,
      );
      const failures: Error[] = [];
      let nextPreparedIndex = 0;

      const runNextPrepared = async (): Promise<void> => {
        const prepared = preparedRuns[nextPreparedIndex];
        nextPreparedIndex += 1;
        if (!prepared) {
          return;
        }

        options.progressCallback?.({
          kind: "scenario_started",
          runId,
          scenarioId: prepared.displayId,
          scenarioName: prepared.scenario.name,
          scenarioIndex: prepared.ordinal + 1,
          scenarioTotal: prepared.total,
        });

        try {
          const result = await executePrepared(prepared);
          orderedResults[prepared.ordinal] = result;
          options.progressCallback?.({
            kind: "scenario_finished",
            runId,
            scenarioId: prepared.displayId,
            scenarioName: result.scenarioName,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            passed: result.passed,
            overallScore: result.overallScore,
          });
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          failures.push(failure);
          orderedResults[prepared.ordinal] = erroredScenarioResult(
            prepared,
            failure,
          );
          options.progressCallback?.({
            kind: "scenario_error",
            runId,
            scenarioId: prepared.displayId,
            scenarioName: prepared.scenario.name,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            error: failure,
          });
        }

        await runNextPrepared();
      };

      await Promise.all(
        Array.from({ length: concurrencyLimit }, () => runNextPrepared()),
      );
      results = orderedResults.filter(
        (item): item is ScenarioRunResult => item !== undefined,
      );
    } else {
      for (const prepared of preparedRuns) {
        options.progressCallback?.({
          kind: "scenario_started",
          runId,
          scenarioId: prepared.displayId,
          scenarioName: prepared.scenario.name,
          scenarioIndex: prepared.ordinal + 1,
          scenarioTotal: prepared.total,
        });
        try {
          const result = await executePrepared(prepared);
          results.push(result);
          options.progressCallback?.({
            kind: "scenario_finished",
            runId,
            scenarioId: prepared.displayId,
            scenarioName: result.scenarioName,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            passed: result.passed,
            overallScore: result.overallScore,
          });
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          results.push(erroredScenarioResult(prepared, failure));
          options.progressCallback?.({
            kind: "scenario_error",
            runId,
            scenarioId: prepared.displayId,
            scenarioName: prepared.scenario.name,
            scenarioIndex: prepared.ordinal + 1,
            scenarioTotal: prepared.total,
            error: failure,
          });
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
    const exitCode = failure instanceof AgentProbeConfigError ? 2 : 3;
    options.recorder?.recordRunError?.(failure, { exitCode });
    throw failure;
  }
}
