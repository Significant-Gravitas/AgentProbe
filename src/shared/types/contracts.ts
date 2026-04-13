export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type TransportType = "http" | "cli" | "websocket";
export type HarnessType = "codex" | "claude-code" | "opencode" | "custom";
export type SessionMode = "per_invocation" | "per_scenario" | "persistent";
export type AuthType =
  | "bearer_token"
  | "header"
  | "jwt"
  | "oauth2_client_credentials"
  | "token_exchange"
  | "script"
  | "none";
export type EndpointSessionType = "stateless" | "managed" | "agent_initiated";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseFormat = "json" | "sse" | "text" | "ndjson";
export type ToolExtractionFormat = "openai" | "anthropic" | "custom";
export type ToolHandling = "mock" | "passthrough" | "skip";
export type ScenarioPriority = "critical" | "high" | "medium" | "low";
export type ExpectedOutcome =
  | "resolved"
  | "escalated"
  | "deflected"
  | "failed"
  | "clarified";
export type ResetPolicy = "none" | "new" | "fresh_agent";
export type TechLiteracy = "low" | "medium" | "high" | "expert";
export type DomainExpertise = "none" | "basic" | "intermediate" | "expert";
export type LanguageStyle =
  | "formal"
  | "casual"
  | "terse"
  | "verbose"
  | "varies";
export type TopicDrift = "none" | "low" | "medium" | "high";
export type ClarificationCompliance = "low" | "medium" | "high";
export type JudgeProvider = "anthropic" | "openai" | "custom";
export type ScaleType = "likert" | "binary" | "numeric" | "rubric_levels";
export type AggregationMode = "mean" | "median" | "majority_vote";
export type CopilotMode = "fast" | "extended_thinking";

export type ProcessedYamlFile = {
  path: string;
  schema: "personas" | "scenarios" | "rubrics" | "endpoints";
  objectCount: number;
};

export type CliHarness = {
  type: HarnessType;
  command: string[];
  sessionMode?: SessionMode;
};

export type RateLimitConfig = {
  requestsPerSecond?: number;
  burst?: number;
};

export type TlsConfig = {
  verify?: boolean;
  certFile?: string;
  keyFile?: string;
  caFile?: string;
};

export type HttpConnection = {
  baseUrl: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  rateLimit?: RateLimitConfig;
  tls?: TlsConfig;
};

export type WebSocketConnection = {
  url: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  rateLimit?: RateLimitConfig;
  tls?: TlsConfig;
};

export type NamedEndpoint = {
  method?: HttpMethod;
  url?: string;
  bodyTemplate?: string;
  headers: Record<string, string>;
};

export type EndpointAuth = {
  type: AuthType;
  token?: string;
  headerName?: string;
  headerValue?: string;
  command: string[];
  cwd?: string;
  timeoutSeconds?: number;
  tokenPath?: string;
  headersPath?: string;
};

export type SessionLifecycleRequest = {
  endpoint?: string;
  url?: string;
  method?: HttpMethod;
  bodyTemplate?: string;
  sessionIdPath?: string;
  sessionTokenPath?: string;
  ignoreErrors?: boolean;
};

export type EndpointSession = {
  type: EndpointSessionType;
  create?: SessionLifecycleRequest;
  close?: SessionLifecycleRequest;
};

export type EndpointRequest = {
  endpoint?: string;
  url?: string;
  method?: HttpMethod;
  bodyTemplate?: string;
};

export type AsyncPollingConfig = {
  endpoint?: string;
  url?: string;
  method?: HttpMethod;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  statusPath?: string;
  doneValue?: JsonScalar;
  resultPath?: string;
};

export type EndpointResponse = {
  format: ResponseFormat;
  contentPath: string;
  asyncPolling?: AsyncPollingConfig;
};

export type WebSocketConnect = {
  challengeEvent?: string;
  method?: string;
  params: Record<string, JsonValue>;
};

export type WebSocketTransport = {
  connect?: WebSocketConnect;
};

export type ToolExtraction = {
  format?: ToolExtractionFormat;
  toolHandling?: ToolHandling;
  mockTools: Record<string, JsonValue>;
};

export type HealthCheck = {
  enabled?: boolean;
  endpoint?: string;
};

export type EndpointLogging = {
  logRawExchanges?: boolean;
};

export type EndpointsMetadata = {
  sourcePath?: string;
};

export type Endpoints = {
  metadata: EndpointsMetadata;
  transport?: TransportType;
  preset?: string;
  harness?: CliHarness;
  connection?: HttpConnection | WebSocketConnection;
  websocket?: WebSocketTransport;
  endpoints: Record<string, NamedEndpoint>;
  auth?: EndpointAuth;
  session?: EndpointSession;
  request?: EndpointRequest;
  response?: EndpointResponse;
  toolExtraction?: ToolExtraction;
  healthCheck?: HealthCheck;
  logging?: EndpointLogging;
};

export type PersonaDemographics = {
  role: string;
  techLiteracy: TechLiteracy;
  domainExpertise: DomainExpertise;
  languageStyle: LanguageStyle;
};

export type PersonaPersonality = {
  patience: number;
  assertiveness: number;
  detailOrientation: number;
  cooperativeness: number;
  emotionalIntensity: number;
};

export type PersonaBehavior = {
  openingStyle: string;
  followUpStyle: string;
  escalationTriggers: string[];
  topicDrift: TopicDrift;
  clarificationCompliance: ClarificationCompliance;
};

export type Persona = {
  id: string;
  name: string;
  description?: string;
  demographics: PersonaDemographics;
  personality: PersonaPersonality;
  behavior: PersonaBehavior;
  systemPrompt: string;
  model?: string;
};

export type PersonasMetadata = {
  version?: string;
  id?: string;
  name?: string;
  sourcePath?: string;
};

export type Personas = {
  metadata: PersonasMetadata;
  personas: Persona[];
};

export type RubricScale = {
  type: ScaleType;
  points?: number;
  labels: Record<string, string>;
};

export type RubricDimension = {
  id: string;
  name: string;
  weight: number;
  scale: RubricScale;
  judgePrompt: string;
};

export type BiasMitigation = {
  randomizeOrder?: boolean;
  chainOfThought?: boolean;
  structuredOutput?: boolean;
  multipleJudges?: boolean;
  judgeCount?: number;
  aggregation?: AggregationMode;
};

export type CostControls = {
  maxJudgeCallsPerScenario?: number;
  cacheIdenticalJudgments?: boolean;
};

export type JudgeConfig = {
  provider: JudgeProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  biasMitigation?: BiasMitigation;
  costControls?: CostControls;
};

export type ScoreThreshold = {
  dimension: string;
  below?: number;
  above?: number;
};

export type ScoringOverrides = {
  autoFailConditions: ScoreThreshold[];
  autoPassConditions: ScoreThreshold[];
};

export type Rubric = {
  id: string;
  name: string;
  description?: string;
  passThreshold: number;
  dimensions: RubricDimension[];
  scoringOverrides?: ScoringOverrides;
  metaPrompt: string;
  judge?: JudgeConfig;
};

export type RubricsMetadata = {
  version?: string;
  id?: string;
  name?: string;
  sourcePath?: string;
  judge?: JudgeConfig;
};

export type Rubrics = {
  metadata: RubricsMetadata;
  rubrics: Rubric[];
};

export type ScenarioDefaults = {
  maxTurns?: number;
  timeoutSeconds?: number;
  persona?: string;
  rubric?: string;
  userName?: string;
  copilotMode?: CopilotMode;
};

export type ScenarioContext = {
  systemPrompt?: string;
  userName?: string;
  copilotMode?: CopilotMode;
  injectedData: Record<string, JsonValue>;
};

export type CheckpointAssertion = {
  toolCalled?: string;
  withArgs?: Record<string, JsonValue>;
  responseContainsAny: string[];
  responseMustNotContain?: string[];
  responseMentions?: string;
};

export type UserTurn = {
  role: "user";
  content?: string;
  useExactMessage: boolean;
};

export type CheckpointTurn = {
  role: "checkpoint";
  assertions: CheckpointAssertion[];
};

export type InjectTurn = {
  role: "inject";
  content?: string;
};

export type TurnType = UserTurn | CheckpointTurn | InjectTurn;

export type ExpectedTool = {
  name: string;
  required?: boolean;
  callOrder?: number;
};

export type FailureMode = {
  name: string;
  description: string;
};

export type ScenarioExpectations = {
  mustInclude: string[];
  mustNotInclude: string[];
  expectedTools: ExpectedTool[];
  expectedBehavior?: string;
  expectedOutcome?: ExpectedOutcome;
  groundTruth?: string;
  escalationRequired?: boolean;
  maxToolCalls?: number;
  maxTurnsBeforeEscalation?: number;
  failureModes: FailureMode[];
  testerNote?: string;
  [key: string]: unknown;
};

export type Session = {
  id?: string;
  timeOffset: string;
  reset: ResetPolicy;
  maxTurns?: number;
  turns: TurnType[];
};

export type Scenario = {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  persona?: string;
  rubric?: string;
  maxTurns?: number;
  baseDate?: string;
  priority?: ScenarioPriority;
  context?: ScenarioContext;
  turns: TurnType[];
  sessions: Session[];
  expectations: ScenarioExpectations;
  [key: string]: unknown;
};

export type ScenariosMetadata = {
  version?: string;
  id?: string;
  name?: string;
  sourcePath?: string;
  sourcePaths: string[];
  defaults?: ScenarioDefaults;
  tagsDefinition: string[];
};

export type Scenarios = {
  metadata: ScenariosMetadata;
  scenarios: Scenario[];
};

export type ConversationTurn = {
  role: string;
  content?: string | null;
};

export type PersonaStepStatus = "continue" | "completed" | "stalled";

export type PersonaStep = {
  status: PersonaStepStatus;
  message?: string | null;
};

export type ToolCallRecord = {
  name: string;
  args: Record<string, JsonValue>;
  order?: number;
  raw?: Record<string, JsonValue>;
};

export type AdapterReply = {
  assistantText: string;
  toolCalls: ToolCallRecord[];
  rawExchange: Record<string, JsonValue>;
  latencyMs: number;
  usage: Record<string, JsonValue>;
};

export type CheckpointResult = {
  passed: boolean;
  failures: string[];
};

export type JudgeDimensionScore = {
  reasoning: string;
  evidence: string[];
  score: number;
};

export type RubricScore = {
  dimensions: Record<string, JudgeDimensionScore>;
  overallNotes: string;
  passed: boolean;
  failureModeDetected?: string | null;
};

export type ScenarioRunResult = {
  scenarioId: string;
  scenarioName: string;
  personaId: string;
  rubricId: string;
  userId?: string | null;
  passed: boolean;
  overallScore: number;
  transcript: ConversationTurn[];
  checkpoints: CheckpointResult[];
  toolCallsByTurn?: Record<number, ToolCallRecord[]>;
  judgeScore?: RubricScore;
  renderedTurns?: Array<Record<string, unknown>>;
};

export type RunResult = {
  runId?: string | null;
  passed: boolean;
  exitCode: number;
  results: ScenarioRunResult[];
};

export type RunProgressKind =
  | "suite_started"
  | "scenario_started"
  | "scenario_finished"
  | "scenario_error";

export type RunProgressEvent = {
  kind: RunProgressKind;
  runId?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  scenarioIndex?: number | null;
  scenarioTotal?: number | null;
  passed?: boolean | null;
  overallScore?: number | null;
  error?: Error | null;
};

export type ScenarioTermination = {
  reason: "max_turns_exceeded";
  message: string;
  maxTurns?: number;
};

export type RunSummary = {
  runId: string;
  status: string;
  passed?: boolean | null;
  exitCode?: number | null;
  preset?: string | null;
  startedAt: string;
  completedAt?: string | null;
  suiteFingerprint?: string | null;
  finalError?: Record<string, JsonValue> | null;
  aggregateCounts: {
    scenarioTotal: number;
    scenarioPassedCount: number;
    scenarioFailedCount: number;
    scenarioErroredCount: number;
  };
};

export type RunRecord = RunSummary & {
  sourcePaths?: Record<string, string> | null;
  endpointSnapshot?: Record<string, JsonValue> | null;
  selectedScenarioIds?: string[] | null;
  scenarios: ScenarioRecord[];
};

export type ScenarioRecord = {
  scenarioRunId: number;
  ordinal: number;
  scenarioId: string;
  scenarioName: string;
  personaId: string;
  rubricId: string;
  userId?: string | null;
  tags?: JsonValue;
  priority?: string | null;
  expectations?: JsonValue;
  scenarioSnapshot?: JsonValue;
  personaSnapshot?: JsonValue;
  rubricSnapshot?: JsonValue;
  status: string;
  passed?: boolean | null;
  overallScore?: number | null;
  passThreshold?: number | null;
  judge: {
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    overallNotes?: string | null;
    output?: JsonValue;
  };
  counts: {
    turnCount: number;
    assistantTurnCount: number;
    toolCallCount: number;
    checkpointCount: number;
  };
  turns: Array<Record<string, JsonValue>>;
  targetEvents: Array<Record<string, JsonValue>>;
  toolCalls: Array<Record<string, JsonValue>>;
  checkpoints: Array<Record<string, JsonValue>>;
  judgeDimensionScores: Array<Record<string, JsonValue>>;
  error?: Record<string, JsonValue> | null;
  startedAt: string;
  completedAt?: string | null;
};

export type OpenAiResponsesRequest = {
  model: string;
  instructions: string;
  input: string;
  text: {
    format: {
      type: "json_schema";
      name: string;
      description?: string;
      schema: Record<string, JsonValue>;
      strict: boolean;
    };
  };
  temperature?: number;
  maxOutputTokens?: number;
};

export type OpenAiResponsesResponse = {
  outputText: string;
  raw?: JsonValue;
};

export type OpenClawSession = {
  key: string;
  sessionId?: string;
  entry: Record<string, JsonValue>;
};

export type OpenClawHistory = {
  sessionKey: string;
  sessionId?: string;
  messages: Array<Record<string, JsonValue>>;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
};

export type OpenClawChatStatus =
  | "started"
  | "ok"
  | "error"
  | "timeout"
  | "aborted"
  | "in_flight";

export type OpenClawChatResult = {
  sessionKey: string;
  sessionId?: string;
  runId: string;
  status: OpenClawChatStatus;
  reply?: string;
  error?: string;
  message?: Record<string, JsonValue>;
};

export type AutogptAuthResult = {
  token: string;
  headers: Record<string, string>;
};
