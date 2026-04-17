import type {
  AdapterReply,
  CheckpointAssertion,
  CheckpointResult,
  Endpoints,
  JsonValue,
  Persona,
  PresetRecord,
  PresetSnapshot,
  Rubric,
  RubricScore,
  RunRecord,
  RunResult,
  RunSummary,
  Scenario,
  ScenarioRunResult,
  ScenarioSelectionRef,
} from "../../shared/types/contracts.ts";

export type PersistenceBackendKind = "sqlite" | "postgres";

export type ParsedDbUrl = {
  kind: PersistenceBackendKind;
  /** Normalized URL used for display. Credentials are redacted. */
  displayUrl: string;
  /** Original URL passed by the caller (for driver use). Never log directly. */
  rawUrl: string;
};

export type PresetWriteInput = {
  name: string;
  description?: string | null;
  endpoint: string;
  personas: string;
  rubric: string;
  selection: ScenarioSelectionRef[];
  parallel?: {
    enabled?: boolean;
    limit?: number | null;
  };
  repeat?: number;
  dryRun?: boolean;
};

export type RunRecorderStartOptions = {
  endpoint: string;
  scenarios: string;
  personas: string;
  rubric: string;
  scenarioFilter?: string;
  tags?: string;
  label?: string;
  trigger?: string;
  presetId?: string | null;
  presetSnapshot?: PresetSnapshot | Record<string, JsonValue> | null;
};

export type RunRecorderConfigurationOptions = {
  endpointConfig: Endpoints;
  scenarioCollection: { scenarios: Scenario[] };
  personaCollection: { personas: Persona[] };
  rubricCollection: { rubrics: Rubric[] };
  selectedScenarios: Scenario[];
  scenarioFilter?: string;
  tags?: string;
};

export interface RunRecorder {
  readonly runId?: string;
  recordRunStarted(options: RunRecorderStartOptions): string;
  recordRunConfiguration(options: RunRecorderConfigurationOptions): void;
  recordRunFinished(result: RunResult): void;
  recordRunCancelled(result?: RunResult): void;
  recordRunError(error: Error, options: { exitCode: number }): void;
  recordScenarioStarted(options: {
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    ordinal?: number;
    userId?: string;
  }): number;
  recordTurn(
    scenarioRunId: number,
    options: {
      turnIndex: number;
      turn: { role: string; content?: string | null };
      source: string;
      generatorModel?: string;
    },
  ): void;
  recordAssistantReply(
    scenarioRunId: number,
    options: { turnIndex: number; reply: AdapterReply },
  ): void;
  recordCheckpoint(
    scenarioRunId: number,
    options: {
      checkpointIndex: number;
      precedingTurnIndex?: number;
      assertions: CheckpointAssertion[];
      result: CheckpointResult;
    },
  ): void;
  recordJudgeResult(
    scenarioRunId: number,
    options: {
      rubric: Rubric;
      score: RubricScore;
      overallScore: number;
    },
  ): void;
  recordScenarioFinished(
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ): void;
  recordScenarioError(scenarioRunId: number, error: Error): void;

  /**
   * Optional async drain hook. Buffered backends (Postgres) use this to flush
   * queued writes and surface any persistent flush error back to the run
   * invoker. Synchronous backends (SQLite) can omit it.
   */
  drain?(): Promise<void>;

  /** Optional async close hook to release resources (connections, handles). */
  close?(): Promise<void>;
}

/**
 * Async-first repository interface. Both SQLite and Postgres backends implement
 * this; existing sync free-function callers keep working through compat wrappers
 * in `sqlite-run-history.ts`.
 */
export interface PersistenceRepository {
  readonly kind: PersistenceBackendKind;
  readonly dbUrl: string;

  /**
   * Instantiate a recorder. SQLite returns a synchronous recorder; Postgres may
   * throw an AgentProbeConfigError when the runtime cannot support synchronous
   * recording (Phase 3.1 will introduce a buffered async recorder).
   */
  createRecorder(): RunRecorder;

  // Preset operations
  createPreset(input: PresetWriteInput): Promise<PresetRecord>;
  getPreset(
    presetId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<PresetRecord | undefined>;
  listPresets(options?: { includeDeleted?: boolean }): Promise<PresetRecord[]>;
  updatePreset(
    presetId: string,
    input: Partial<PresetWriteInput>,
  ): Promise<PresetRecord | undefined>;
  softDeletePreset(presetId: string): Promise<PresetRecord | undefined>;

  // Run / scenario reads
  listRuns(): Promise<RunSummary[]>;
  listRunsForPreset(presetId: string): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  latestRunForSuite(
    suiteFingerprint: string,
    options?: { beforeStartedAt?: string },
  ): Promise<RunRecord | undefined>;

  // Cancellation
  markRunCancelled(
    runId: string,
    options?: { exitCode?: number },
  ): Promise<RunRecord | undefined>;
}
