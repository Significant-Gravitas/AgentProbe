export type AggregateCounts = {
  scenarioTotal: number;
  scenarioPassedCount: number;
  scenarioFailedCount: number;
  scenarioHarnessFailedCount?: number;
  scenarioErroredCount: number;
};

export type RunSummary = {
  runId: string;
  status: string;
  passed?: boolean | null;
  exitCode?: number | null;
  preset?: string | null;
  label?: string | null;
  notes?: string | null;
  trigger?: string | null;
  cancelledAt?: string | null;
  presetId?: string | null;
  startedAt: string;
  completedAt?: string | null;
  suiteFingerprint?: string | null;
  aggregateCounts: AggregateCounts;
};

export type ServerScenario = {
  ordinal: number;
  scenarioId: string;
  scenarioName: string;
  userId?: string | null;
  status: string;
  passed?: boolean | null;
  failureKind?: "agent" | "harness" | null;
  overallScore?: number | null;
  passThreshold?: number | null;
  judge?: {
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    overallNotes?: string | null;
    output?: unknown;
  };
  turns?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  targetEvents?: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
  judgeDimensionScores?: Array<Record<string, unknown>>;
  expectations?: unknown;
  error?: unknown;
  counts?: {
    turnCount: number;
    assistantTurnCount: number;
    toolCallCount: number;
    checkpointCount: number;
  };
  startedAt?: string | null;
  completedAt?: string | null;
};

export type RunRecord = RunSummary & {
  scenarios: ServerScenario[];
};

export type RunsResponse = {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
};

export type RunResponse = { run: RunRecord };

export type ScenarioResponse = {
  run: Pick<
    RunSummary,
    "runId" | "status" | "passed" | "startedAt" | "completedAt"
  >;
  scenario: ServerScenario;
};

export type SuiteSummary = {
  id: string;
  path: string;
  relativePath: string;
  schema: string;
  objectCount: number;
  scenarioIds: string[];
};

export type ScenarioSummary = {
  suiteId: string;
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  priority: string | null;
  persona: string | null;
  rubric: string | null;
  sourcePath: string;
};

export type SuitesResponse = {
  data_path: string;
  scanned_at: string;
  suites: SuiteSummary[];
  errors: Array<{ path: string; message: string }>;
};

export type ScenariosResponse = {
  scanned_at: string;
  scenarios: ScenarioSummary[];
};

export type Preset = {
  id: string;
  name: string;
  description: string | null;
  endpoint: string;
  personas: string;
  rubric: string;
  selection: Array<{ file: string; id: string }>;
  parallel: { enabled: boolean; limit: number | null };
  repeat: number;
  dry_run: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_run: RunSummary | null;
};

export type PresetsResponse = { presets: Preset[] };

export type PresetResponse = {
  preset: Preset;
  warnings: Array<{ file: string; id: string; message: string }>;
};

export type PresetRunsResponse = { runs: RunSummary[] };

export type HealthResponse = {
  status: string;
  version?: string;
  uptime_seconds?: number;
};

export type ReadyResponse = {
  status: string;
  data_path?: string;
  db_url?: string | null;
  reason?: string;
};

export type SecretSource = "db" | "env" | null;

export type SecretStatus = {
  configured: boolean;
  source: SecretSource;
};

export type OpenRouterStatusResponse = {
  open_router_api_key: SecretStatus;
};

export type EndpointOverride = {
  endpoint_path: string;
  base_url: string | null;
  autogpt_jwt_secret: string | null;
  updated_at: string;
};

export type EndpointDefaults = {
  endpoint_path: string;
  preset: string | null;
  transport: string | null;
  base_url: string | null;
  base_url_resolved: string | null;
};

export type EndpointOverrideListResponse = { overrides: EndpointOverride[] };
export type EndpointOverrideDetailResponse = {
  override: EndpointOverride | null;
  defaults: EndpointDefaults;
};
export type EndpointOverrideUpsertResponse = { override: EndpointOverride };

import type { ApiOptions } from "./client.ts";

export type ServerRequest = <T>(path: string, init?: ApiOptions) => Promise<T>;
