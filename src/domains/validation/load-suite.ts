import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import type {
  CheckpointAssertion,
  CheckpointTurn,
  CliHarness,
  EndpointAuth,
  EndpointLogging,
  EndpointRequest,
  EndpointResponse,
  EndpointSession,
  Endpoints,
  FailureMode,
  HealthCheck,
  HttpConnection,
  InjectTurn,
  JudgeConfig,
  NamedEndpoint,
  Persona,
  PersonaBehavior,
  PersonaDemographics,
  PersonaPersonality,
  Personas,
  ProcessedYamlFile,
  Rubric,
  RubricDimension,
  RubricScale,
  Rubrics,
  Scenario,
  ScenarioContext,
  ScenarioDefaults,
  ScenarioExpectations,
  Scenarios,
  ScoreThreshold,
  ScoringOverrides,
  Session,
  SessionLifecycleRequest,
  ToolExtraction,
  TurnAttachment,
  TurnType,
  UserTurn,
  WebSocketConnect,
  WebSocketConnection,
  WebSocketTransport,
} from "../../shared/types/contracts.ts";
import { AgentProbeConfigError } from "../../shared/utils/errors.ts";

type YamlObject = Record<string, unknown>;

const endpointKeys = new Set([
  "transport",
  "preset",
  "harness",
  "connection",
  "websocket",
  "auth",
  "session",
  "request",
  "response",
  "health_check",
  "tool_extraction",
]);

function ensureObject(value: unknown, message: string): YamlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentProbeConfigError(message);
  }
  return value as YamlObject;
}

function ensureString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentProbeConfigError(message);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseTimeOffset(offset: string): number {
  const match = /^(\d+)([hdm])$/.exec(offset.trim());
  if (!match) {
    return 0;
  }
  const amount = Number(match[1] ?? "0");
  const unit = match[2];
  if (!Number.isFinite(amount)) {
    return 0;
  }
  if (unit === "d") {
    return amount * 24 * 60 * 60 * 1000;
  }
  if (unit === "h") {
    return amount * 60 * 60 * 1000;
  }
  if (unit === "m") {
    return amount * 60 * 1000;
  }
  return 0;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item] : [],
  );
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

function resolvePath(path: string): string {
  return resolve(path);
}

function mergeYamlMappings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mergeYamlMappings(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const raw = value as YamlObject;
  const mergeValue = raw["<<"];
  const explicitEntries = Object.entries(raw).filter(([key]) => key !== "<<");

  const mergedEntries: Array<[string, unknown]> = [];
  if (mergeValue !== undefined) {
    const mergeSources = Array.isArray(mergeValue) ? mergeValue : [mergeValue];
    for (const source of [...mergeSources].reverse()) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new AgentProbeConfigError(
          "YAML merge key `<<` must reference a mapping or list of mappings.",
        );
      }
      mergedEntries.push(
        ...Object.entries(mergeYamlMappings(source) as YamlObject),
      );
    }
  }

  return Object.fromEntries([
    ...mergedEntries,
    ...explicitEntries.map(([key, item]) => [key, mergeYamlMappings(item)]),
  ]);
}

function readYaml(path: string): YamlObject {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) {
    throw new AgentProbeConfigError(`YAML file not found: ${resolved}`);
  }
  if (!statSync(resolved).isFile()) {
    throw new AgentProbeConfigError(`Expected a YAML file, got: ${resolved}`);
  }

  const parsed = parseYaml(readFileSync(resolved, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentProbeConfigError(
      `Top-level YAML value must be a mapping: ${resolved}`,
    );
  }

  return mergeYamlMappings(parsed) as YamlObject;
}

export function iterYamlFiles(dataPath: string): string[] {
  const resolved = resolvePath(dataPath);
  if (!existsSync(resolved)) {
    throw new AgentProbeConfigError(`Data path not found: ${resolved}`);
  }

  if (statSync(resolved).isFile()) {
    return [resolved];
  }
  if (!statSync(resolved).isDirectory()) {
    throw new AgentProbeConfigError(
      `Expected a directory or YAML file: ${resolved}`,
    );
  }

  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (extension === ".yaml" || extension === ".yml") {
        files.push(entryPath);
      }
    }
  };
  walk(resolved);
  return files.sort((left, right) => left.localeCompare(right));
}

export function detectSchema(data: YamlObject): ProcessedYamlFile["schema"] {
  if ("personas" in data) {
    return "personas";
  }
  if ("scenarios" in data) {
    return "scenarios";
  }
  if ("rubrics" in data) {
    return "rubrics";
  }
  if (Object.keys(data).some((key) => endpointKeys.has(key))) {
    return "endpoints";
  }

  throw new AgentProbeConfigError(
    "Unsupported YAML schema; expected personas, scenarios, rubrics, or endpoint config.",
  );
}

function parseCliHarness(value: unknown): CliHarness | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "harness must be an object.");
  return {
    type: ensureString(
      raw.type,
      "harness.type is required.",
    ) as CliHarness["type"],
    command: stringArray(raw.command),
    sessionMode: optionalString(raw.session_mode) as CliHarness["sessionMode"],
  };
}

function parseRateLimitConfig(value: unknown): HttpConnection["rateLimit"] {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "rate_limit must be an object.");
  return {
    requestsPerSecond: optionalNumber(raw.requests_per_second),
    burst: optionalNumber(raw.burst),
  };
}

function parseTlsConfig(value: unknown): HttpConnection["tls"] {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "tls must be an object.");
  return {
    verify: optionalBoolean(raw.verify),
    certFile: optionalString(raw.cert_file),
    keyFile: optionalString(raw.key_file),
    caFile: optionalString(raw.ca_file),
  };
}

function parseConnection(value: unknown): Endpoints["connection"] {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "connection must be an object.");
  if (typeof raw.base_url === "string") {
    const connection: HttpConnection = {
      baseUrl: raw.base_url,
      timeoutSeconds: optionalNumber(raw.timeout_seconds),
      maxRetries: optionalNumber(raw.max_retries),
      rateLimit: parseRateLimitConfig(raw.rate_limit),
      tls: parseTlsConfig(raw.tls),
    };
    return connection;
  }
  if (typeof raw.url === "string") {
    const connection: WebSocketConnection = {
      url: raw.url,
      timeoutSeconds: optionalNumber(raw.timeout_seconds),
      maxRetries: optionalNumber(raw.max_retries),
      rateLimit: parseRateLimitConfig(raw.rate_limit),
      tls: parseTlsConfig(raw.tls),
    };
    return connection;
  }
  throw new AgentProbeConfigError(
    "connection must include base_url (http) or url (websocket).",
  );
}

function parseNamedEndpoint(value: unknown): NamedEndpoint {
  const raw = ensureObject(value, "named endpoint must be an object.");
  return {
    method: optionalString(raw.method) as NamedEndpoint["method"],
    url: optionalString(raw.url),
    bodyTemplate: optionalString(raw.body_template),
    headers: recordOfStrings(raw.headers),
  };
}

function parseEndpointAuth(value: unknown): EndpointAuth | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "auth must be an object.");
  return {
    type: ensureString(
      raw.type,
      "auth.type is required.",
    ) as EndpointAuth["type"],
    token: optionalString(raw.token),
    headerName: optionalString(raw.header_name),
    headerValue: optionalString(raw.header_value),
    command: stringArray(raw.command),
    cwd: optionalString(raw.cwd),
    timeoutSeconds: optionalNumber(raw.timeout_seconds),
    tokenPath: optionalString(raw.token_path),
    headersPath: optionalString(raw.headers_path),
  };
}

function parseSessionLifecycleRequest(
  value: unknown,
): SessionLifecycleRequest | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "session request must be an object.");
  return {
    endpoint: optionalString(raw.endpoint),
    url: optionalString(raw.url),
    method: optionalString(raw.method) as SessionLifecycleRequest["method"],
    bodyTemplate: optionalString(raw.body_template),
    sessionIdPath: optionalString(raw.session_id_path),
    sessionTokenPath: optionalString(raw.session_token_path),
    ignoreErrors: optionalBoolean(raw.ignore_errors),
  };
}

function parseEndpointSession(value: unknown): EndpointSession | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "session must be an object.");
  return {
    type: ensureString(
      raw.type,
      "session.type is required.",
    ) as EndpointSession["type"],
    create: parseSessionLifecycleRequest(raw.create),
    close: parseSessionLifecycleRequest(raw.close),
  };
}

function parseEndpointRequest(value: unknown): EndpointRequest | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "request must be an object.");
  return {
    endpoint: optionalString(raw.endpoint),
    url: optionalString(raw.url),
    method: optionalString(raw.method) as EndpointRequest["method"],
    bodyTemplate: optionalString(raw.body_template),
  };
}

function parseEndpointResponse(value: unknown): EndpointResponse | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "response must be an object.");
  return {
    format: ensureString(
      raw.format,
      "response.format is required.",
    ) as EndpointResponse["format"],
    contentPath: ensureString(
      raw.content_path,
      "response.content_path is required.",
    ),
    asyncPolling:
      raw.async_polling && typeof raw.async_polling === "object"
        ? {
            endpoint: optionalString(
              (raw.async_polling as YamlObject).endpoint,
            ),
            url: optionalString((raw.async_polling as YamlObject).url),
            method: optionalString(
              (raw.async_polling as YamlObject).method,
            ) as never,
            intervalSeconds: optionalNumber(
              (raw.async_polling as YamlObject).interval_seconds,
            ),
            timeoutSeconds: optionalNumber(
              (raw.async_polling as YamlObject).timeout_seconds,
            ),
            statusPath: optionalString(
              (raw.async_polling as YamlObject).status_path,
            ),
            doneValue: (raw.async_polling as YamlObject).done_value as never,
            resultPath: optionalString(
              (raw.async_polling as YamlObject).result_path,
            ),
          }
        : undefined,
  };
}

function parseWebSocketConnect(value: unknown): WebSocketConnect | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "websocket.connect must be an object.");
  return {
    challengeEvent: optionalString(raw.challenge_event),
    method: optionalString(raw.method),
    params:
      raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
        ? (raw.params as Record<string, never>)
        : {},
  };
}

function parseWebSocketTransport(
  value: unknown,
): WebSocketTransport | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "websocket must be an object.");
  return {
    connect: parseWebSocketConnect(raw.connect),
  };
}

function parseToolExtraction(value: unknown): ToolExtraction | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "tool_extraction must be an object.");
  return {
    format: optionalString(raw.format) as ToolExtraction["format"],
    toolHandling: optionalString(
      raw.tool_handling,
    ) as ToolExtraction["toolHandling"],
    mockTools:
      raw.mock_tools &&
      typeof raw.mock_tools === "object" &&
      !Array.isArray(raw.mock_tools)
        ? (raw.mock_tools as Record<string, never>)
        : {},
  };
}

function parseHealthCheck(value: unknown): HealthCheck | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "health_check must be an object.");
  return {
    enabled: optionalBoolean(raw.enabled),
    endpoint: optionalString(raw.endpoint),
  };
}

function parseEndpointLogging(value: unknown): EndpointLogging | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "logging must be an object.");
  return {
    logRawExchanges: optionalBoolean(raw.log_raw_exchanges),
  };
}

export function parseEndpointsYaml(path: string): Endpoints {
  const raw = readYaml(path);
  const resolvedPath = resolvePath(path);

  const endpointsPayload =
    raw.endpoints &&
    typeof raw.endpoints === "object" &&
    !Array.isArray(raw.endpoints)
      ? Object.fromEntries(
          Object.entries(raw.endpoints).map(([key, value]) => [
            key,
            parseNamedEndpoint(value),
          ]),
        )
      : {};

  return {
    metadata: { sourcePath: resolvedPath },
    transport: optionalString(raw.transport) as Endpoints["transport"],
    preset: optionalString(raw.preset),
    harness: parseCliHarness(raw.harness),
    connection: parseConnection(raw.connection),
    websocket: parseWebSocketTransport(raw.websocket),
    endpoints: endpointsPayload,
    auth: parseEndpointAuth(raw.auth),
    session: parseEndpointSession(raw.session),
    request: parseEndpointRequest(raw.request),
    response: parseEndpointResponse(raw.response),
    toolExtraction: parseToolExtraction(raw.tool_extraction),
    healthCheck: parseHealthCheck(raw.health_check),
    logging: parseEndpointLogging(raw.logging),
  };
}

function parsePersonaDemographics(value: unknown): PersonaDemographics {
  const raw = ensureObject(value, "persona.demographics is required.");
  return {
    role: ensureString(raw.role, "persona.demographics.role is required."),
    techLiteracy: ensureString(
      raw.tech_literacy,
      "persona.demographics.tech_literacy is required.",
    ) as PersonaDemographics["techLiteracy"],
    domainExpertise: ensureString(
      raw.domain_expertise,
      "persona.demographics.domain_expertise is required.",
    ) as PersonaDemographics["domainExpertise"],
    languageStyle: ensureString(
      raw.language_style,
      "persona.demographics.language_style is required.",
    ) as PersonaDemographics["languageStyle"],
  };
}

function parsePersonaPersonality(value: unknown): PersonaPersonality {
  const raw = ensureObject(value, "persona.personality is required.");
  return {
    patience: optionalNumber(raw.patience) ?? 0,
    assertiveness: optionalNumber(raw.assertiveness) ?? 0,
    detailOrientation: optionalNumber(raw.detail_orientation) ?? 0,
    cooperativeness: optionalNumber(raw.cooperativeness) ?? 0,
    emotionalIntensity: optionalNumber(raw.emotional_intensity) ?? 0,
  };
}

function parsePersonaBehavior(value: unknown): PersonaBehavior {
  const raw = ensureObject(value, "persona.behavior is required.");
  return {
    openingStyle: ensureString(
      raw.opening_style,
      "persona.behavior.opening_style is required.",
    ),
    followUpStyle: ensureString(
      raw.follow_up_style,
      "persona.behavior.follow_up_style is required.",
    ),
    escalationTriggers: stringArray(raw.escalation_triggers),
    topicDrift: ensureString(
      raw.topic_drift,
      "persona.behavior.topic_drift is required.",
    ) as PersonaBehavior["topicDrift"],
    clarificationCompliance: ensureString(
      raw.clarification_compliance,
      "persona.behavior.clarification_compliance is required.",
    ) as PersonaBehavior["clarificationCompliance"],
  };
}

function parsePersona(value: unknown): Persona {
  const raw = ensureObject(value, "persona must be an object.");
  return {
    id: ensureString(raw.id, "persona.id is required."),
    name: ensureString(raw.name, "persona.name is required."),
    description: optionalString(raw.description),
    demographics: parsePersonaDemographics(raw.demographics),
    personality: parsePersonaPersonality(raw.personality),
    behavior: parsePersonaBehavior(raw.behavior),
    systemPrompt: ensureString(
      raw.system_prompt,
      "persona.system_prompt is required.",
    ),
    model: optionalString(raw.model),
  };
}

export function parsePersonaYaml(path: string): Personas {
  const raw = readYaml(path);
  return {
    metadata: {
      version: optionalString(raw.version),
      id: optionalString(raw.id),
      name: optionalString(raw.name),
      sourcePath: resolvePath(path),
    },
    personas: Array.isArray(raw.personas)
      ? raw.personas.map((item) => parsePersona(item))
      : [],
  };
}

function normalizeLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" ? [[String(key), item]] : [],
    ),
  );
}

function parseRubricScale(value: unknown): RubricScale {
  const raw = ensureObject(value, "rubric.scale is required.");
  return {
    type: ensureString(
      raw.type,
      "rubric.scale.type is required.",
    ) as RubricScale["type"],
    points: optionalNumber(raw.points),
    labels: normalizeLabels(raw.labels),
  };
}

function parseRubricDimension(value: unknown): RubricDimension {
  const raw = ensureObject(value, "rubric dimension must be an object.");
  return {
    id: ensureString(raw.id, "rubric dimension id is required."),
    name: ensureString(raw.name, "rubric dimension name is required."),
    weight: optionalNumber(raw.weight) ?? 0,
    scale: parseRubricScale(raw.scale),
    judgePrompt: ensureString(
      raw.judge_prompt,
      "rubric dimension judge_prompt is required.",
    ),
  };
}

function parseJudgeConfig(value: unknown): JudgeConfig | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "judge must be an object.");
  return {
    provider: ensureString(
      raw.provider,
      "judge.provider is required.",
    ) as JudgeConfig["provider"],
    model: ensureString(raw.model, "judge.model is required."),
    temperature: optionalNumber(raw.temperature) ?? 0,
    maxTokens: optionalNumber(raw.max_tokens) ?? 0,
    biasMitigation:
      raw.bias_mitigation &&
      typeof raw.bias_mitigation === "object" &&
      !Array.isArray(raw.bias_mitigation)
        ? {
            randomizeOrder: optionalBoolean(
              (raw.bias_mitigation as YamlObject).randomize_order,
            ),
            chainOfThought: optionalBoolean(
              (raw.bias_mitigation as YamlObject).chain_of_thought,
            ),
            structuredOutput: optionalBoolean(
              (raw.bias_mitigation as YamlObject).structured_output,
            ),
            multipleJudges: optionalBoolean(
              (raw.bias_mitigation as YamlObject).multiple_judges,
            ),
            judgeCount: optionalNumber(
              (raw.bias_mitigation as YamlObject).judge_count,
            ),
            aggregation: optionalString(
              (raw.bias_mitigation as YamlObject).aggregation,
            ) as never,
          }
        : undefined,
    costControls:
      raw.cost_controls &&
      typeof raw.cost_controls === "object" &&
      !Array.isArray(raw.cost_controls)
        ? {
            maxJudgeCallsPerScenario: optionalNumber(
              (raw.cost_controls as YamlObject).max_judge_calls_per_scenario,
            ),
            cacheIdenticalJudgments: optionalBoolean(
              (raw.cost_controls as YamlObject).cache_identical_judgments,
            ),
          }
        : undefined,
  };
}

function parseScoreThreshold(value: unknown): ScoreThreshold {
  const raw = ensureObject(value, "score threshold must be an object.");
  return {
    dimension: ensureString(
      raw.dimension,
      "score threshold dimension is required.",
    ),
    below: optionalNumber(raw.below),
    above: optionalNumber(raw.above),
  };
}

function parseScoringOverrides(value: unknown): ScoringOverrides | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "scoring_overrides must be an object.");
  return {
    autoFailConditions: Array.isArray(raw.auto_fail_conditions)
      ? raw.auto_fail_conditions.map((item) => parseScoreThreshold(item))
      : [],
    autoPassConditions: Array.isArray(raw.auto_pass_conditions)
      ? raw.auto_pass_conditions.map((item) => parseScoreThreshold(item))
      : [],
  };
}

function parseRubric(value: unknown, inheritedJudge?: JudgeConfig): Rubric {
  const raw = ensureObject(value, "rubric must be an object.");
  return {
    id: ensureString(raw.id, "rubric.id is required."),
    name: ensureString(raw.name, "rubric.name is required."),
    description: optionalString(raw.description),
    passThreshold: optionalNumber(raw.pass_threshold) ?? 0,
    dimensions: Array.isArray(raw.dimensions)
      ? raw.dimensions.map((item) => parseRubricDimension(item))
      : [],
    scoringOverrides: parseScoringOverrides(raw.scoring_overrides),
    metaPrompt: ensureString(
      raw.meta_prompt,
      "rubric.meta_prompt is required.",
    ),
    judge: parseJudgeConfig(raw.judge) ?? inheritedJudge,
  };
}

export function parseRubricsYaml(path: string): Rubrics {
  const raw = readYaml(path);
  const inheritedJudge = parseJudgeConfig(raw.judge);
  return {
    metadata: {
      version: optionalString(raw.version),
      id: optionalString(raw.id),
      name: optionalString(raw.name),
      sourcePath: resolvePath(path),
      judge: inheritedJudge,
    },
    rubrics: Array.isArray(raw.rubrics)
      ? raw.rubrics.map((item) => parseRubric(item, inheritedJudge))
      : [],
  };
}

function parseScenarioDefaults(value: unknown): ScenarioDefaults | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "defaults must be an object.");
  return {
    maxTurns: optionalNumber(raw.max_turns),
    timeoutSeconds: optionalNumber(raw.timeout_seconds),
    persona: optionalString(raw.persona),
    rubric: optionalString(raw.rubric),
    userName: optionalString(raw.user_name),
    copilotMode: optionalString(
      raw.copilot_mode,
    ) as ScenarioDefaults["copilotMode"],
  };
}

function parseScenarioContext(value: unknown): ScenarioContext | undefined {
  if (!value) {
    return undefined;
  }
  const raw = ensureObject(value, "scenario.context must be an object.");
  return {
    systemPrompt: optionalString(raw.system_prompt),
    userName: optionalString(raw.user_name),
    copilotMode: optionalString(
      raw.copilot_mode,
    ) as ScenarioContext["copilotMode"],
    injectedData:
      raw.injected_data &&
      typeof raw.injected_data === "object" &&
      !Array.isArray(raw.injected_data)
        ? (raw.injected_data as ScenarioContext["injectedData"])
        : {},
  };
}

function parseCheckpointAssertion(value: unknown): CheckpointAssertion {
  const raw = ensureObject(value, "checkpoint assertion must be an object.");
  return {
    toolCalled: optionalString(raw.tool_called),
    withArgs:
      raw.with_args &&
      typeof raw.with_args === "object" &&
      !Array.isArray(raw.with_args)
        ? (raw.with_args as CheckpointAssertion["withArgs"])
        : undefined,
    responseContainsAny: stringArray(raw.response_contains_any),
    responseMustNotContain: stringArray(raw.response_must_not_contain),
    responseMentions: optionalString(raw.response_mentions),
  };
}

function parseTurn(value: unknown): TurnType {
  const raw = ensureObject(value, "scenario turn must be an object.");
  const role = ensureString(raw.role, "scenario turn role is required.");
  if (role === "user") {
    const attachments: TurnAttachment[] = [];
    if (Array.isArray(raw.attachments)) {
      for (const item of raw.attachments) {
        if (typeof item === "string") {
          attachments.push({ path: item });
        } else if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const path = typeof obj.path === "string" ? obj.path : undefined;
          if (path) {
            attachments.push({
              path,
              name: typeof obj.name === "string" ? obj.name : undefined,
            });
          }
        }
      }
    }
    const turn: UserTurn = {
      role: "user",
      content: optionalString(raw.content),
      useExactMessage: raw.use_exact_message === true,
      attachments,
    };
    if (turn.useExactMessage && !turn.content) {
      throw new AgentProbeConfigError(
        "`use_exact_message` requires `content` so the exact user message can be rendered.",
      );
    }
    return turn;
  }
  if (role === "checkpoint") {
    const turn: CheckpointTurn = {
      role: "checkpoint",
      assertions: Array.isArray(raw.assert)
        ? raw.assert.map((item) => parseCheckpointAssertion(item))
        : [],
    };
    return turn;
  }
  if (role === "inject") {
    const turn: InjectTurn = {
      role: "inject",
      content: optionalString(raw.content),
    };
    return turn;
  }
  throw new AgentProbeConfigError(`Unsupported scenario turn role: ${role}`);
}

function parseExpectedTools(
  value: unknown,
): ScenarioExpectations["expectedTools"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const raw = ensureObject(item, "expected tool must be an object.");
    return {
      name: ensureString(raw.name, "expected tool name is required."),
      required: optionalBoolean(raw.required),
      callOrder: optionalNumber(raw.call_order),
    };
  });
}

function parseFailureModes(value: unknown): FailureMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const modes: FailureMode[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      modes.push({ name: item, description: item });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const [key, entry] of Object.entries(item)) {
        modes.push({ name: key, description: String(entry) });
      }
    }
  }
  return modes;
}

function parseScenarioExpectations(value: unknown): ScenarioExpectations {
  const raw = ensureObject(value, "scenario.expectations is required.");
  const result: ScenarioExpectations = {
    mustInclude: stringArray(raw.must_include),
    mustNotInclude: stringArray(raw.must_not_include),
    expectedTools: parseExpectedTools(raw.expected_tools),
    expectedBehavior: optionalString(raw.expected_behavior),
    expectedOutcome: optionalString(
      raw.expected_outcome,
    ) as ScenarioExpectations["expectedOutcome"],
    groundTruth: optionalString(raw.ground_truth),
    escalationRequired: optionalBoolean(raw.escalation_required),
    maxToolCalls: optionalNumber(raw.max_tool_calls),
    maxTurnsBeforeEscalation: optionalNumber(raw.max_turns_before_escalation),
    failureModes: parseFailureModes(raw.failure_modes),
    testerNote: optionalString(raw.tester_note),
  };

  for (const [key, entry] of Object.entries(raw)) {
    const normalizedKey = key.replaceAll(
      /_([a-z])/g,
      (_match, letter: string) => letter.toUpperCase(),
    );
    if (!(normalizedKey in result)) {
      result[normalizedKey] = entry;
    }
  }
  return result;
}

function parseSession(value: unknown): Session {
  const raw = ensureObject(value, "scenario session must be an object.");
  return {
    id: optionalString(raw.id),
    timeOffset: optionalString(raw.time_offset) ?? "0h",
    reset: (optionalString(raw.reset) ?? "none") as Session["reset"],
    maxTurns: optionalNumber(raw.max_turns),
    turns: Array.isArray(raw.turns)
      ? raw.turns.map((item) => parseTurn(item))
      : [],
  };
}

function parseScenario(value: unknown, defaults?: ScenarioDefaults): Scenario {
  const raw = ensureObject(value, "scenario must be an object.");
  const contextPayload =
    raw.context &&
    typeof raw.context === "object" &&
    !Array.isArray(raw.context)
      ? ({ ...(raw.context as Record<string, unknown>) } satisfies Record<
          string,
          unknown
        >)
      : undefined;

  if (defaults?.userName !== undefined || defaults?.copilotMode !== undefined) {
    const ensuredContext = contextPayload ?? {};
    if (
      defaults?.userName !== undefined &&
      ensuredContext.user_name === undefined
    ) {
      ensuredContext.user_name = defaults.userName;
    }
    if (
      defaults?.copilotMode !== undefined &&
      ensuredContext.copilot_mode === undefined
    ) {
      ensuredContext.copilot_mode = defaults.copilotMode;
    }
    if (Object.keys(ensuredContext).length > 0) {
      raw.context = ensuredContext;
    }
  }

  return {
    id: ensureString(raw.id, "scenario.id is required."),
    name: ensureString(raw.name, "scenario.name is required."),
    description: optionalString(raw.description),
    tags: stringArray(raw.tags),
    persona: optionalString(raw.persona) ?? defaults?.persona,
    rubric: optionalString(raw.rubric) ?? defaults?.rubric,
    maxTurns: optionalNumber(raw.max_turns),
    baseDate: optionalString(raw.base_date),
    priority: optionalString(raw.priority) as Scenario["priority"],
    context: parseScenarioContext(raw.context),
    turns: Array.isArray(raw.turns)
      ? raw.turns.map((item) => parseTurn(item))
      : [],
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.map((item) => parseSession(item))
      : [],
    expectations: parseScenarioExpectations(raw.expectations),
  };
}

function parseScenarioDocument(raw: YamlObject, path: string): Scenarios {
  const defaults = parseScenarioDefaults(raw.defaults);
  const scenarios = Array.isArray(raw.scenarios)
    ? raw.scenarios.map((item) => parseScenario(item, defaults))
    : [];

  return {
    metadata: {
      version: optionalString(raw.version),
      id: optionalString(raw.id),
      name: optionalString(raw.name),
      sourcePath: resolvePath(path),
      sourcePaths: [resolvePath(path)],
      defaults,
      tagsDefinition: stringArray(raw.tags_definition),
    },
    scenarios,
  };
}

export function parseScenarioYaml(path: string): Scenarios {
  return parseScenarioDocument(readYaml(path), path);
}

function coalesceSingleValue(
  values: Array<string | undefined>,
): string | undefined {
  const unique = [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ];
  return unique.length === 1 ? unique[0] : undefined;
}

function mergeScenarioDefaults(
  collections: Scenarios[],
): ScenarioDefaults | undefined {
  const merged: ScenarioDefaults = {};
  const sources = new Map<keyof ScenarioDefaults, string>();

  for (const collection of collections) {
    const defaults = collection.metadata.defaults;
    const sourcePath = collection.metadata.sourcePath ?? "unknown";
    if (!defaults) {
      continue;
    }

    for (const key of [
      "maxTurns",
      "timeoutSeconds",
      "persona",
      "rubric",
    ] as const) {
      const value = defaults[key];
      if (value === undefined) {
        continue;
      }
      if (merged[key] !== undefined && merged[key] !== value) {
        const existingSource = sources.get(key) ?? "unknown";
        throw new AgentProbeConfigError(
          `Conflicting scenario defaults for \`${key}\` between ${existingSource} and ${sourcePath}.`,
        );
      }
      (merged as Record<string, string | number>)[key] = value;
      sources.set(key, sourcePath);
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function parseScenariosInput(path: string): Scenarios {
  const resolved = resolvePath(path);
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    return parseScenarioYaml(resolved);
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new AgentProbeConfigError(
      `Expected a scenario YAML file or directory: ${resolved}`,
    );
  }

  const collections = iterYamlFiles(resolved)
    .map((candidate) => {
      const raw = readYaml(candidate);
      return "scenarios" in raw
        ? parseScenarioDocument(raw, candidate)
        : undefined;
    })
    .filter((item): item is Scenarios => Boolean(item));

  if (collections.length === 0) {
    throw new AgentProbeConfigError(
      `No scenario YAML files found under directory: ${resolved}`,
    );
  }

  const scenarios: Scenario[] = [];
  const scenarioSources = new Map<string, string>();
  const tagsDefinition: string[] = [];
  const seenTags = new Set<string>();
  const sourcePaths: string[] = [];

  for (const collection of collections) {
    if (collection.metadata.sourcePath) {
      sourcePaths.push(collection.metadata.sourcePath);
    }

    for (const tag of collection.metadata.tagsDefinition) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        tagsDefinition.push(tag);
      }
    }

    for (const scenario of collection.scenarios) {
      const sourcePath = collection.metadata.sourcePath ?? resolved;
      if (scenarioSources.has(scenario.id)) {
        throw new AgentProbeConfigError(
          `Duplicate scenario id \`${scenario.id}\` found in ${scenarioSources.get(scenario.id)} and ${sourcePath}.`,
        );
      }
      scenarioSources.set(scenario.id, sourcePath);
      scenarios.push(scenario);
    }
  }

  return {
    metadata: {
      version: coalesceSingleValue(
        collections.map((item) => item.metadata.version),
      ),
      id: coalesceSingleValue(collections.map((item) => item.metadata.id)),
      name: coalesceSingleValue(collections.map((item) => item.metadata.name)),
      sourcePath: resolved,
      sourcePaths,
      defaults: mergeScenarioDefaults(collections),
      tagsDefinition,
    },
    scenarios,
  };
}

export function parseYamlFile(
  path: string,
): Personas | Scenarios | Rubrics | Endpoints {
  const raw = readYaml(path);
  switch (detectSchema(raw)) {
    case "personas":
      return parsePersonaYaml(path);
    case "scenarios":
      return parseScenarioYaml(path);
    case "rubrics":
      return parseRubricsYaml(path);
    case "endpoints":
      return parseEndpointsYaml(path);
  }
}

export function processYamlFiles(dataPath: string): ProcessedYamlFile[] {
  return iterYamlFiles(dataPath).map((path) => {
    const parsed = parseYamlFile(path);
    if ("personas" in parsed) {
      return {
        path,
        schema: "personas" as const,
        objectCount: parsed.personas.length,
      };
    }
    if ("rubrics" in parsed) {
      return {
        path,
        schema: "rubrics" as const,
        objectCount: parsed.rubrics.length,
      };
    }
    if ("scenarios" in parsed) {
      return {
        path,
        schema: "scenarios" as const,
        objectCount: parsed.scenarios.length,
      };
    }
    return { path, schema: "endpoints" as const, objectCount: 1 };
  });
}
