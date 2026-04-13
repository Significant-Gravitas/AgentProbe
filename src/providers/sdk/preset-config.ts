import type {
  Endpoints,
  WebSocketConnection,
} from "../../shared/types/contracts.ts";
import { AgentProbeConfigError } from "../../shared/utils/errors.ts";
import { resolveEnvInValue } from "../../shared/utils/template.ts";

const DEFAULT_PROTOCOL_VERSION = 3;
const DEFAULT_CLIENT_ID = "openclaw-probe";
const DEFAULT_CLIENT_MODE = "probe";

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function cloneWithResolvedEnv(endpoint: Endpoints): Endpoints {
  return resolveEnvInValue(deepClone(endpoint));
}

export function dispatchKey(endpoint: Endpoints): string | undefined {
  if (endpoint.preset?.trim()) {
    return endpoint.preset.trim().toLowerCase();
  }
  const sourcePath = endpoint.metadata.sourcePath;
  if (!sourcePath) {
    return undefined;
  }
  return sourcePath.split("/").at(-1)?.toLowerCase();
}

function requireCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new AgentProbeConfigError(message);
  }
}

function requireNamedEndpoints(endpoint: Endpoints, ...names: string[]): void {
  const missing = names.filter((name) => !(name in endpoint.endpoints));
  requireCondition(
    missing.length === 0,
    `Missing named endpoints: ${missing.join(", ")}`,
  );
}

function configureAutogpt(endpoint: Endpoints): Endpoints {
  const normalized = cloneWithResolvedEnv(endpoint);
  requireCondition(
    normalized.transport === "http",
    "AutoGPT endpoints require transport: http.",
  );
  requireCondition(
    Boolean(normalized.connection && "baseUrl" in normalized.connection),
    "AutoGPT endpoints require connection.base_url.",
  );
  requireNamedEndpoints(
    normalized,
    "register_user",
    "create_session",
    "send_message",
  );

  if (!normalized.auth) {
    normalized.auth = {
      type: "none",
      command: [],
    };
  }
  requireCondition(
    normalized.auth.type === "none",
    "AutoGPT endpoints are authenticated internally by the main CLI and should use auth.type: none.",
  );
  requireCondition(
    normalized.session?.type === "managed",
    "AutoGPT endpoints require session.type: managed.",
  );
  requireCondition(
    normalized.session?.create?.endpoint === "create_session",
    "AutoGPT endpoints require session.create.endpoint = create_session.",
  );
  requireCondition(
    normalized.session?.create?.sessionIdPath === "$.id",
    "AutoGPT endpoints require session.create.session_id_path = $.id.",
  );
  requireCondition(
    normalized.request?.endpoint === "send_message",
    "AutoGPT endpoints require request.endpoint = send_message.",
  );
  requireCondition(
    normalized.response?.format === "sse",
    "AutoGPT endpoints require response.format = sse.",
  );
  requireCondition(
    normalized.response?.contentPath === "$.delta",
    "AutoGPT endpoints require response.content_path = $.delta.",
  );
  normalized.toolExtraction ??= {
    format: "custom",
    mockTools: {},
  };
  return normalized;
}

function configureOpencode(endpoint: Endpoints): Endpoints {
  const normalized = cloneWithResolvedEnv(endpoint);
  requireCondition(
    normalized.transport === "http",
    "OpenCode endpoints require transport: http.",
  );
  requireCondition(
    Boolean(normalized.connection && "baseUrl" in normalized.connection),
    "OpenCode endpoints require connection.base_url.",
  );
  requireNamedEndpoints(
    normalized,
    "health",
    "create_session",
    "send_message",
    "delete_session",
  );
  requireCondition(
    normalized.session?.type === "managed",
    "OpenCode endpoints require session.type: managed.",
  );
  requireCondition(
    normalized.session?.create?.endpoint === "create_session",
    "OpenCode endpoints require session.create.endpoint = create_session.",
  );
  requireCondition(
    normalized.session?.create?.sessionIdPath === "$.id",
    "OpenCode endpoints require session.create.session_id_path = $.id.",
  );
  requireCondition(
    normalized.session?.close?.endpoint === "delete_session",
    "OpenCode endpoints require session.close.endpoint = delete_session.",
  );
  requireCondition(
    normalized.request?.endpoint === "send_message",
    "OpenCode endpoints require request.endpoint = send_message.",
  );
  requireCondition(
    normalized.response?.format === "json",
    "OpenCode endpoints require response.format = json.",
  );
  requireCondition(
    normalized.healthCheck?.endpoint === "health",
    "OpenCode endpoints require health_check.endpoint = health.",
  );

  const password = Bun.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (password) {
    const username = Bun.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
    const basicToken = Buffer.from(`${username}:${password}`, "utf8").toString(
      "base64",
    );
    normalized.auth = {
      type: "header",
      headerName: "Authorization",
      headerValue: `Basic ${basicToken}`,
      command: [],
    };
  }
  return normalized;
}

function configureOpenclaw(endpoint: Endpoints): Endpoints {
  const normalized = cloneWithResolvedEnv(endpoint);
  requireCondition(
    normalized.transport === "websocket",
    "OpenClaw endpoints require transport: websocket.",
  );
  requireCondition(
    Boolean(normalized.connection && "url" in normalized.connection),
    "OpenClaw endpoints require connection.url.",
  );

  const connection = normalized.connection as WebSocketConnection;
  requireCondition(
    connection.url.startsWith("ws://") || connection.url.startsWith("wss://"),
    "OpenClaw connection.url must use ws:// or wss://.",
  );

  normalized.websocket ??= {};
  normalized.websocket.connect ??= { params: {} };
  normalized.websocket.connect.challengeEvent ??= "connect.challenge";
  normalized.websocket.connect.method ??= "connect";
  requireCondition(
    normalized.websocket.connect.challengeEvent === "connect.challenge",
    "OpenClaw websocket.connect.challenge_event must be connect.challenge.",
  );
  requireCondition(
    normalized.websocket.connect.method === "connect",
    "OpenClaw websocket.connect.method must be connect.",
  );

  normalized.websocket.connect.params.client ??= {};
  const client = normalized.websocket.connect.params.client as Record<
    string,
    unknown
  >;
  client.id ??= DEFAULT_CLIENT_ID;
  client.version ??= "0.1.0";
  client.platform ??= "typescript";
  client.mode ??= DEFAULT_CLIENT_MODE;

  normalized.websocket.connect.params.minProtocol ??= DEFAULT_PROTOCOL_VERSION;
  normalized.websocket.connect.params.maxProtocol ??= DEFAULT_PROTOCOL_VERSION;
  normalized.websocket.connect.params.role ??= "operator";
  normalized.websocket.connect.params.scopes ??= [
    "operator.read",
    "operator.write",
  ];
  normalized.websocket.connect.params.caps ??= [];
  normalized.websocket.connect.params.commands ??= [];
  normalized.websocket.connect.params.permissions ??= {};
  normalized.websocket.connect.params.auth ??= { token: "" };

  return normalized;
}

const CONFIGURERS: Record<string, (endpoint: Endpoints) => Endpoints> = {
  autogpt: configureAutogpt,
  "autogpt-endpoint.yaml": configureAutogpt,
  "autogpt-endpoint.yml": configureAutogpt,
  opencode: configureOpencode,
  "opencode-endpoints.yaml": configureOpencode,
  "opencode-endpoints.yml": configureOpencode,
  openclaw: configureOpenclaw,
  "openclaw-endpoints.yaml": configureOpenclaw,
  "openclaw-endpoints.yml": configureOpenclaw,
};

export function configureEndpoint(endpoint: Endpoints): Endpoints {
  const key = dispatchKey(endpoint);
  if (!key) {
    return cloneWithResolvedEnv(endpoint);
  }
  return CONFIGURERS[key]?.(endpoint) ?? cloneWithResolvedEnv(endpoint);
}

export {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_MODE,
  DEFAULT_PROTOCOL_VERSION,
  requireNamedEndpoints,
};
