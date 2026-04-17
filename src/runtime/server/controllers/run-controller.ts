import { createHash } from "node:crypto";

import { runSuite } from "../../../domains/evaluation/run-suite.ts";
import {
  createPreset,
  getPreset,
} from "../../../providers/persistence/sqlite-run-history.ts";
import type {
  RecordingRepository,
  RunRecorder,
} from "../../../providers/persistence/types.ts";
import { OpenAiResponsesClient } from "../../../providers/sdk/openai-responses.ts";
import type {
  JsonValue,
  PresetRecord,
  PresetSnapshot,
  RunProgressEvent,
} from "../../../shared/types/contracts.ts";
import { AgentProbeConfigError } from "../../../shared/utils/errors.ts";
import type { ServerConfig } from "../config.ts";
import type { StreamHub } from "../streams/hub.ts";
import {
  HttpInputError,
  optionalBoolean,
  optionalParallel,
  optionalPositiveInteger,
  optionalString,
  readJsonObject,
  readOptionalJsonObject,
  requiredSelection,
  requiredString,
} from "../validation.ts";
import type {
  ResolvedScenarioSelection,
  SuiteController,
} from "./suite-controller.ts";

type RunSpec = {
  endpoint: string;
  personas: string;
  rubric: string;
  scenariosPath: string;
  selection: ResolvedScenarioSelection;
  parallel: {
    enabled: boolean;
    limit?: number;
  };
  repeat: number;
  dryRun: boolean;
  label?: string;
  presetId?: string | null;
  presetSnapshot?: PresetSnapshot | null;
};

type ActiveRun = {
  runId: string;
  suiteKey: string;
  abortController: AbortController;
  promise: Promise<void>;
  cancellationRequested: boolean;
};

export type StartRunResult = {
  runId: string;
  status: "accepted";
};

function hashSuiteKey(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function jsonProgressPayload(event: RunProgressEvent): JsonValue {
  return {
    kind: event.kind,
    scenario_id: event.scenarioId ?? null,
    scenario_name: event.scenarioName ?? null,
    scenario_index: event.scenarioIndex ?? null,
    scenario_total: event.scenarioTotal ?? null,
    passed: event.passed ?? null,
    overall_score: event.overallScore ?? null,
    error: event.error
      ? {
          type: event.error.name,
          message: event.error.message,
        }
      : null,
  };
}

function snapshotFromPreset(preset: PresetRecord): PresetSnapshot {
  const { lastRun: _lastRun, ...snapshot } = preset;
  return snapshot;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function runErrorExitCode(error: Error): number {
  return error instanceof AgentProbeConfigError ? 2 : 3;
}

function writeRunExecutorErrorLog(
  runId: string | undefined,
  error: Error,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      component: "run_executor",
      run_id: runId ?? null,
      error_type: error.name || "Error",
      error_message: error.message,
      stack: error.stack,
    })}\n`,
  );
}

function writeRunExecutorPersistenceErrorLog(
  runId: string | undefined,
  error: Error,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      component: "run_executor",
      event: "run_error_persist_failed",
      run_id: runId ?? null,
      error_type: error.name || "Error",
      error_message: error.message,
      stack: error.stack,
    })}\n`,
  );
}

function ensureOpenRouterConfigured(): OpenAiResponsesClient {
  const client = new OpenAiResponsesClient();
  try {
    client.assertConfigured();
  } catch (error) {
    throw new HttpInputError(
      400,
      "open_router_not_configured",
      error instanceof Error ? error.message : String(error),
    );
  }
  return client;
}

function parseOverrides(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = body.overrides;
  if (overrides === undefined || overrides === null) {
    return {};
  }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new HttpInputError(
      400,
      "bad_request",
      "overrides must be a JSON object.",
    );
  }
  return overrides as Record<string, unknown>;
}

export class RunController {
  private readonly activeByRunId = new Map<string, ActiveRun>();
  private readonly activeBySuiteKey = new Map<string, ActiveRun>();

  constructor(
    private readonly options: {
      config: ServerConfig;
      repository: RecordingRepository;
      suiteController: SuiteController;
      streamHub: StreamHub;
    },
  ) {}

  assertRunnable(): void {
    ensureOpenRouterConfigured();
  }

  private resolvePath(path: string): string {
    return this.options.suiteController.resolveDataFile(path).absolutePath;
  }

  private suiteKey(spec: RunSpec): string {
    return hashSuiteKey({
      endpoint: spec.endpoint,
      personas: spec.personas,
      rubric: spec.rubric,
      selection: spec.selection.refs,
      repeat: spec.repeat,
    });
  }

  private async explicitSpec(body: Record<string, unknown>): Promise<RunSpec> {
    const selectionRefs = requiredSelection(body);
    const selection =
      this.options.suiteController.resolveSelection(selectionRefs);
    const parallel = optionalParallel(body) ?? { enabled: false };
    const repeat = optionalPositiveInteger(body, "repeat") ?? 1;
    const dryRun = optionalBoolean(body, "dry_run") ?? false;

    let presetId: string | null = null;
    let presetSnapshot: PresetSnapshot | null = null;
    const saveAsPreset = body.save_as_preset;
    if (saveAsPreset !== undefined && saveAsPreset !== null) {
      if (
        !saveAsPreset ||
        typeof saveAsPreset !== "object" ||
        Array.isArray(saveAsPreset)
      ) {
        throw new HttpInputError(
          400,
          "bad_request",
          "save_as_preset must be an object.",
        );
      }
      const raw = saveAsPreset as Record<string, unknown>;
      const preset = createPreset(
        {
          name: requiredString(raw, "name"),
          description: optionalString(raw, "description") ?? null,
          endpoint: this.options.suiteController.resolveDataFile(
            requiredString(body, "endpoint"),
          ).relativePath,
          personas: this.options.suiteController.resolveDataFile(
            requiredString(body, "personas"),
          ).relativePath,
          rubric: this.options.suiteController.resolveDataFile(
            requiredString(body, "rubric"),
          ).relativePath,
          selection: selection.refs,
          parallel,
          repeat,
          dryRun,
        },
        { dbUrl: this.options.config.dbUrl },
      );
      presetId = preset.id;
      presetSnapshot = snapshotFromPreset(preset);
    }

    return {
      endpoint: this.resolvePath(requiredString(body, "endpoint")),
      personas: this.resolvePath(requiredString(body, "personas")),
      rubric: this.resolvePath(requiredString(body, "rubric")),
      scenariosPath: this.options.suiteController.resolvedDataPath,
      selection,
      parallel,
      repeat,
      dryRun,
      label: optionalString(body, "label"),
      presetId,
      presetSnapshot,
    };
  }

  private presetSpec(presetId: string, body: Record<string, unknown>): RunSpec {
    const preset = getPreset(presetId, { dbUrl: this.options.config.dbUrl });
    if (!preset) {
      throw new HttpInputError(
        404,
        "not_found",
        `Preset \`${presetId}\` was not found.`,
      );
    }

    const overrides = parseOverrides(body);
    const requestedParallel = optionalParallel(overrides);
    const parallel = requestedParallel ?? {
      enabled: preset.parallel.enabled,
      limit: preset.parallel.limit ?? undefined,
    };
    const repeat =
      optionalPositiveInteger(overrides, "repeat") ?? preset.repeat;
    const dryRun = optionalBoolean(overrides, "dry_run") ?? preset.dryRun;

    return {
      endpoint: this.resolvePath(preset.endpoint),
      personas: this.resolvePath(preset.personas),
      rubric: this.resolvePath(preset.rubric),
      scenariosPath: this.options.suiteController.resolvedDataPath,
      selection: this.options.suiteController.resolveSelection(
        preset.selection,
      ),
      parallel,
      repeat,
      dryRun,
      label: optionalString(body, "label"),
      presetId: preset.id,
      presetSnapshot: snapshotFromPreset(preset),
    };
  }

  async specFromRunRequest(request: Request): Promise<RunSpec> {
    const body = await readJsonObject(request);
    const presetId = optionalString(body, "preset_id");
    if (presetId) {
      return this.presetSpec(presetId, body);
    }
    return await this.explicitSpec(body);
  }

  async specFromPresetRunRequest(
    presetId: string,
    request: Request,
  ): Promise<RunSpec> {
    const body = await readOptionalJsonObject(request);
    return this.presetSpec(presetId, body);
  }

  start(spec: RunSpec): StartRunResult {
    const client = ensureOpenRouterConfigured();
    const suiteKey = this.suiteKey(spec);
    if (this.activeBySuiteKey.has(suiteKey)) {
      throw new HttpInputError(
        409,
        "conflict",
        "A run with the same resolved suite key is already active.",
      );
    }

    const abortController = new AbortController();
    const recorder = this.options.repository.createRecorder();
    const promise = this.execute(spec, {
      client,
      recorder,
      abortController,
      suiteKey,
    });
    const runId = recorder.runId;
    if (!runId) {
      throw new HttpInputError(
        500,
        "run_start_failed",
        "Run recorder did not produce a run ID.",
      );
    }

    const active: ActiveRun = {
      runId,
      suiteKey,
      abortController,
      promise,
      cancellationRequested: false,
    };
    this.activeByRunId.set(runId, active);
    this.activeBySuiteKey.set(suiteKey, active);
    void promise.finally(() => {
      this.activeByRunId.delete(runId);
      this.activeBySuiteKey.delete(suiteKey);
    });

    this.options.streamHub.publish({
      runId,
      kind: "run_started",
      payload: {
        run_id: runId,
        label: spec.label ?? null,
        preset_id: spec.presetId ?? null,
        trigger: "server",
      },
    });

    return { runId, status: "accepted" };
  }

  private async execute(
    spec: RunSpec,
    options: {
      client: OpenAiResponsesClient;
      recorder: RunRecorder;
      abortController: AbortController;
      suiteKey: string;
    },
  ): Promise<void> {
    try {
      await runSuite({
        endpoint: spec.endpoint,
        scenarios: spec.scenariosPath,
        personas: spec.personas,
        rubric: spec.rubric,
        preparedSelection: {
          scenarioCollection: spec.selection.scenarioCollection,
          selectedScenarios: spec.selection.selectedScenarios,
          selectionRefs: spec.selection.refs,
        },
        client: options.client,
        recorder: options.recorder,
        progressCallback: (event) => {
          const runId = event.runId ?? options.recorder.runId;
          if (!runId) {
            return;
          }
          this.options.streamHub.publish({
            runId,
            kind:
              event.kind === "run_cancelled"
                ? "run_cancelled"
                : event.kind === "run_finished"
                  ? "run_finished"
                  : event.kind,
            payload: jsonProgressPayload(event),
          });
        },
        parallel: spec.parallel.enabled,
        parallelLimit: spec.parallel.limit,
        dryRun: spec.dryRun,
        repeat: spec.repeat,
        signal: options.abortController.signal,
        label: spec.label,
        trigger: "server",
        presetId: spec.presetId,
        presetSnapshot: spec.presetSnapshot,
      });
    } catch (error) {
      const runId = options.recorder.runId;
      const failure = normalizeError(error);
      writeRunExecutorErrorLog(runId, failure);
      if (runId) {
        try {
          options.recorder.recordRunError(failure, {
            exitCode: runErrorExitCode(failure),
          });
        } catch (persistError) {
          writeRunExecutorPersistenceErrorLog(
            runId,
            normalizeError(persistError),
          );
        }
        this.options.streamHub.publish({
          runId,
          kind: "run_error",
          payload: {
            type: failure.name || "Error",
            message: failure.message,
          },
        });
      }
    }
  }

  cancel(runId: string): { runId: string; status: string } {
    const active = this.activeByRunId.get(runId);
    if (!active) {
      throw new HttpInputError(
        404,
        "not_found",
        `Active run \`${runId}\` was not found.`,
      );
    }
    active.cancellationRequested = true;
    active.abortController.abort();
    this.options.streamHub.publish({
      runId,
      kind: "run_progress",
      payload: {
        kind: "cancel_requested",
        run_id: runId,
      },
    });
    return { runId, status: "cancelling" };
  }

  getActiveRun(runId: string): ActiveRun | undefined {
    return this.activeByRunId.get(runId);
  }

  async cancelAllAndWait(timeoutMs: number): Promise<void> {
    const active = [...this.activeByRunId.values()];
    for (const run of active) {
      run.cancellationRequested = true;
      run.abortController.abort();
    }
    await Promise.race([
      Promise.allSettled(active.map((run) => run.promise)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    for (const run of active) {
      if (this.activeByRunId.has(run.runId)) {
        await this.options.repository.markRunCancelled(run.runId);
        this.options.streamHub.publish({
          runId: run.runId,
          kind: "run_cancelled",
          payload: {
            kind: "run_cancelled",
            run_id: run.runId,
            forced: true,
          },
        });
      }
    }
  }
}
