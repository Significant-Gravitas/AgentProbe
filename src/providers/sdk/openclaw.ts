import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEndpointsYaml } from "../../domains/validation/load-suite.ts";
import type {
  AdapterReply,
  Endpoints,
  JsonValue,
  OpenClawChatResult,
  OpenClawChatStatus,
  OpenClawHistory,
  OpenClawSession,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import { configureEndpoint } from "./preset-config.ts";

const DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30;
const DEFAULT_CONNECT_CHALLENGE_TIMEOUT_SECONDS = 2_000;
const DEFAULT_REPLY_TIMEOUT_MS = 30_000;
const DEFAULT_HISTORY_LIMIT = 200;
const STATE_DIR_ENV = "AGENTPROBE_STATE_DIR";
const DEVICE_IDENTITY_FILE = "device.json";
const DEVICE_AUTH_FILE = "device-auth.json";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type DeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: Timer;
};

export class OpenClawGatewayError extends AgentProbeRuntimeError {
  override name = "OpenClawGatewayError";
}

export class OpenClawGatewayTimeout extends OpenClawGatewayError {
  override name = "OpenClawGatewayTimeout";
}

export class OpenClawGatewayRequestError extends OpenClawGatewayError {
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { code?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "OpenClawGatewayRequestError";
    this.code = options.code;
    this.details = options.details;
  }
}

function nowMs(): number {
  return Date.now();
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : [],
  );
}

function normalizeDeviceMetadata(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "";
}

function resolveStateDir(): string {
  const configuredStateDir = Bun.env[STATE_DIR_ENV]?.trim();
  if (configuredStateDir) {
    return resolve(configuredStateDir);
  }
  const xdgStateHome = Bun.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    return resolve(xdgStateHome, "agentprobe");
  }
  return resolve(process.env.HOME ?? ".", ".local", "state", "agentprobe");
}

function extractRawPublicKey(spkiDer: Buffer): Buffer {
  if (
    spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spkiDer.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spkiDer.subarray(-32);
}

function publicKeyRawFromPem(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return extractRawPublicKey(der);
}

function deriveDeviceId(publicKeyPem: string): string {
  return createHash("sha256")
    .update(publicKeyRawFromPem(publicKeyPem))
    .digest("hex");
}

function writeJson(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function loadOrCreateDeviceIdentity(path: string): DeviceIdentity {
  const existing = readJson(path);
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as Record<string, unknown>).version === 1 &&
    typeof (existing as Record<string, unknown>).publicKeyPem === "string" &&
    typeof (existing as Record<string, unknown>).privateKeyPem === "string"
  ) {
    const publicKeyPem = (existing as Record<string, unknown>)
      .publicKeyPem as string;
    const privateKeyPem = (existing as Record<string, unknown>)
      .privateKeyPem as string;
    const deviceId = deriveDeviceId(publicKeyPem);
    if ((existing as Record<string, unknown>).deviceId !== deviceId) {
      writeJson(path, {
        ...(existing as Record<string, unknown>),
        deviceId,
      });
    }
    return { deviceId, publicKeyPem, privateKeyPem };
  }

  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const deviceIdentity: DeviceIdentity = {
    deviceId: deriveDeviceId(keys.publicKey),
    publicKeyPem: keys.publicKey,
    privateKeyPem: keys.privateKey,
  };
  writeJson(path, {
    version: 1,
    deviceId: deviceIdentity.deviceId,
    publicKeyPem: deviceIdentity.publicKeyPem,
    privateKeyPem: deviceIdentity.privateKeyPem,
    createdAtMs: nowMs(),
  });
  return deviceIdentity;
}

function loadDeviceAuthToken(
  path: string,
  options: { deviceId: string; role: string },
): DeviceAuthEntry | undefined {
  const store = readJson(path);
  if (
    !store ||
    typeof store !== "object" ||
    Array.isArray(store) ||
    (store as Record<string, unknown>).version !== 1 ||
    (store as Record<string, unknown>).deviceId !== options.deviceId
  ) {
    return undefined;
  }

  const tokens = (store as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const entry = (tokens as Record<string, unknown>)[options.role];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.token !== "string" || !record.token.trim()) {
    return undefined;
  }
  return {
    token: record.token.trim(),
    role: options.role,
    scopes: coerceStringList(record.scopes),
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : 0,
  };
}

function storeDeviceAuthToken(
  path: string,
  options: { deviceId: string; role: string; token: string; scopes: string[] },
): void {
  const existing = readJson(path);
  const tokens =
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as Record<string, unknown>).version === 1 &&
    (existing as Record<string, unknown>).deviceId === options.deviceId &&
    (existing as Record<string, unknown>).tokens &&
    typeof (existing as Record<string, unknown>).tokens === "object" &&
    !Array.isArray((existing as Record<string, unknown>).tokens)
      ? {
          ...((existing as Record<string, unknown>).tokens as Record<
            string,
            unknown
          >),
        }
      : {};

  tokens[options.role] = {
    token: options.token,
    role: options.role,
    scopes: [...new Set(options.scopes)].sort(),
    updatedAtMs: nowMs(),
  };

  writeJson(path, {
    version: 1,
    deviceId: options.deviceId,
    tokens,
  });
}

function buildDeviceAuthPayloadV3(options: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
  platform?: string;
  deviceFamily?: string;
}): string {
  return [
    "v3",
    options.deviceId,
    options.clientId,
    options.clientMode,
    options.role,
    options.scopes.join(","),
    String(options.signedAtMs),
    options.token ?? "",
    options.nonce,
    normalizeDeviceMetadata(options.platform),
    normalizeDeviceMetadata(options.deviceFamily),
  ].join("|");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return base64UrlEncode(
    signPayload(null, Buffer.from(payload, "utf8"), privateKey),
  );
}

function parseFrame(rawFrame: unknown): Record<string, unknown> {
  const text =
    typeof rawFrame === "string"
      ? rawFrame
      : rawFrame instanceof ArrayBuffer
        ? Buffer.from(rawFrame).toString("utf8")
        : ArrayBuffer.isView(rawFrame)
          ? Buffer.from(
              rawFrame.buffer,
              rawFrame.byteOffset,
              rawFrame.byteLength,
            ).toString("utf8")
          : "";
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenClawGatewayError("Gateway frame must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function messageText(
  message: Record<string, unknown> | undefined,
): string | undefined {
  if (!message) {
    return undefined;
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }
  const content = message.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const chunks = content.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    });
    return chunks.length > 0 ? chunks.join("\n") : undefined;
  }
  return undefined;
}

function latestAssistantReply(
  messages: Array<Record<string, unknown>>,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const reply = messageText(message);
    if (reply) {
      return reply;
    }
  }
  return undefined;
}

function coerceChatStatus(value: unknown): OpenClawChatStatus {
  if (
    value === "ok" ||
    value === "error" ||
    value === "timeout" ||
    value === "aborted" ||
    value === "in_flight"
  ) {
    return value;
  }
  return "started";
}

type SelectedConnectAuth = {
  auth: Record<string, string>;
  signatureToken?: string;
};

export class OpenClawGatewayClient {
  private websocket?: WebSocket;
  private connected = false;
  private hello?: Record<string, unknown>;
  private challengeResolver?: (nonce: string) => void;
  private challengeRejecter?: (error: Error) => void;
  private challengePromise?: Promise<string>;
  private pending = new Map<string, PendingRequest>();
  private chatWaiters = new Map<
    string,
    Array<(event: Record<string, unknown>) => void>
  >();
  private readonly stateDir = resolve(resolveStateDir(), "openclaw");
  private readonly identityPath = resolve(this.stateDir, DEVICE_IDENTITY_FILE);
  private readonly authStorePath = resolve(this.stateDir, DEVICE_AUTH_FILE);
  private deviceIdentity?: DeviceIdentity;

  constructor(readonly endpoint: Endpoints) {
    if (endpoint.transport !== "websocket") {
      throw new OpenClawGatewayError(
        "OpenClaw runtime requires a websocket endpoint.",
      );
    }
    if (!endpoint.connection || !("url" in endpoint.connection)) {
      throw new OpenClawGatewayError(
        "OpenClaw runtime requires connection.url.",
      );
    }
    if (!endpoint.websocket?.connect) {
      throw new OpenClawGatewayError(
        "OpenClaw runtime requires websocket.connect.",
      );
    }
  }

  async connect(): Promise<void> {
    if (this.connected && this.websocket) {
      return;
    }

    const connection = this.endpoint.connection;
    if (!connection || !("maxRetries" in connection)) {
      throw new OpenClawGatewayError(
        "OpenClaw endpoint is missing connection.",
      );
    }
    const attempts = 1 + Math.max(connection.maxRetries ?? 0, 0);
    let lastError: Error | undefined;
    let useStoredRetry = false;
    let consumedStoredRetry = false;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      while (true) {
        try {
          await this.openSocket();
          const challengePromise = this.challengePromise;
          if (!challengePromise) {
            throw new OpenClawGatewayError(
              "Gateway challenge promise was not initialized.",
            );
          }
          const nonce = await this.withTimeout(
            challengePromise,
            Math.min(
              this.timeoutMs(),
              DEFAULT_CONNECT_CHALLENGE_TIMEOUT_SECONDS,
            ),
            "Timed out waiting for gateway challenge.",
          );
          this.hello = await this.callRaw(
            this.endpoint.websocket?.connect?.method ?? "connect",
            this.buildConnectParams(nonce, useStoredRetry),
          );
          this.connected = true;
          this.persistIssuedDeviceToken();
          if (this.endpoint.healthCheck?.enabled) {
            await this.health();
          }
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await this.shutdownConnection();
          if (
            error instanceof OpenClawGatewayRequestError &&
            !consumedStoredRetry &&
            this.shouldRetryWithStoredDeviceToken(error)
          ) {
            consumedStoredRetry = true;
            useStoredRetry = true;
            continue;
          }
          break;
        }
      }

      useStoredRetry = false;
      if (attempt < attempts) {
        await Bun.sleep(Math.min(500 * attempt, 2_000));
      }
    }

    throw new OpenClawGatewayError(
      `Failed to connect to OpenClaw gateway: ${lastError?.message ?? "unknown error"}`,
    );
  }

  async close(): Promise<void> {
    await this.shutdownConnection();
  }

  async health(): Promise<Record<string, unknown>> {
    const method = this.endpoint.healthCheck?.endpoint?.trim() || "health";
    const payload = await this.call(method);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { payload };
  }

  async createSession(
    options: {
      key?: string;
      label?: string;
      agentId?: string;
      model?: string;
    } = {},
  ): Promise<OpenClawSession> {
    const params: Record<string, unknown> = {};
    if (options.key) params.key = options.key;
    if (options.label) params.label = options.label;
    if (options.agentId) params.agentId = options.agentId;
    if (options.model) params.model = options.model;

    const payload = await this.call("sessions.create", params);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OpenClawGatewayError(
        "sessions.create returned an invalid payload.",
      );
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.key !== "string" || !record.key.trim()) {
      throw new OpenClawGatewayError(
        "sessions.create did not return a session key.",
      );
    }
    return {
      key: record.key,
      sessionId: trimToUndefined(record.sessionId),
      entry:
        record.entry &&
        typeof record.entry === "object" &&
        !Array.isArray(record.entry)
          ? (record.entry as Record<string, JsonValue>)
          : {},
    };
  }

  async history(
    sessionKey: string,
    options: { limit?: number } = {},
  ): Promise<OpenClawHistory> {
    const payload = await this.call("chat.history", {
      sessionKey,
      limit: Math.max(
        1,
        Math.min(options.limit ?? DEFAULT_HISTORY_LIMIT, 1000),
      ),
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OpenClawGatewayError(
        "chat.history returned an invalid payload.",
      );
    }
    const record = payload as Record<string, unknown>;
    return {
      sessionKey,
      sessionId: trimToUndefined(record.sessionId),
      messages: Array.isArray(record.messages)
        ? record.messages.filter((item): item is Record<string, JsonValue> =>
            Boolean(item && typeof item === "object" && !Array.isArray(item)),
          )
        : [],
      thinkingLevel: trimToUndefined(record.thinkingLevel),
      fastMode:
        typeof record.fastMode === "boolean" ? record.fastMode : undefined,
      verboseLevel: trimToUndefined(record.verboseLevel),
    };
  }

  async sendMessage(
    sessionKey: string,
    message: string,
    options: {
      thinking?: string;
      waitForReply?: boolean;
      timeoutMs?: number;
      idempotencyKey?: string;
    } = {},
  ): Promise<OpenClawChatResult> {
    const requestedRunId =
      trimToUndefined(options.idempotencyKey) ??
      randomUUID().replaceAll("-", "");
    let waiterRunId = requestedRunId;
    let resolveEvent: ((event: Record<string, unknown>) => void) | undefined;
    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveEvent = resolve;
    });
    if (!resolveEvent) {
      throw new OpenClawGatewayError("Chat waiter could not be initialized.");
    }
    const chatWaiter = resolveEvent;
    this.registerChatWaiter(waiterRunId, sessionKey, chatWaiter);

    try {
      const payload = await this.call("chat.send", {
        sessionKey,
        message,
        timeoutMs: Math.max(0, options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS),
        idempotencyKey: requestedRunId,
        ...(options.thinking ? { thinking: options.thinking } : {}),
      });

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new OpenClawGatewayError(
          "chat.send returned an invalid payload.",
        );
      }
      const record = payload as Record<string, unknown>;
      const runId = trimToUndefined(record.runId) ?? requestedRunId;
      if (runId !== waiterRunId) {
        this.unregisterChatWaiter(waiterRunId, sessionKey, chatWaiter);
        waiterRunId = runId;
        this.registerChatWaiter(waiterRunId, sessionKey, chatWaiter);
      }

      const status = coerceChatStatus(record.status);
      const baseResult: OpenClawChatResult = {
        sessionKey,
        runId,
        status,
      };

      if (status === "ok") {
        const history = await this.history(sessionKey);
        return {
          ...baseResult,
          sessionId: history.sessionId,
          reply: latestAssistantReply(history.messages),
        };
      }
      if (status === "error") {
        return {
          ...baseResult,
          error: trimToUndefined(record.summary) ?? "Gateway run failed.",
        };
      }
      if (status === "aborted") {
        return {
          ...baseResult,
          error: "Run was aborted by the gateway.",
        };
      }
      if (
        options.waitForReply === false ||
        (options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS) === 0
      ) {
        return baseResult;
      }

      const timeout = options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
      const event = await this.waitForChatTerminalEvent(eventPromise, timeout);
      if (!event) {
        const history = await this.history(sessionKey);
        return {
          sessionKey,
          sessionId: history.sessionId,
          runId,
          status: "timeout",
          reply: latestAssistantReply(history.messages),
          error: `Timed out waiting for reply after ${timeout}ms.`,
        };
      }

      if (event.state === "final") {
        const messagePayload =
          event.message &&
          typeof event.message === "object" &&
          !Array.isArray(event.message)
            ? (event.message as Record<string, JsonValue>)
            : undefined;
        let reply = messageText(
          messagePayload as Record<string, unknown> | undefined,
        );
        let sessionId: string | undefined;
        if (!reply) {
          const history = await this.history(sessionKey);
          sessionId = history.sessionId;
          reply = latestAssistantReply(history.messages);
        }
        return {
          sessionKey,
          sessionId,
          runId,
          status: "ok",
          reply,
          message: messagePayload,
        };
      }

      if (event.state === "aborted") {
        return {
          sessionKey,
          runId,
          status: "aborted",
          error: "Run was aborted by the gateway.",
        };
      }

      return {
        sessionKey,
        runId,
        status: "error",
        error: trimToUndefined(event.errorMessage) ?? "Gateway run failed.",
      };
    } finally {
      this.unregisterChatWaiter(waiterRunId, sessionKey, chatWaiter);
    }
  }

  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.connect();
    return await this.callRaw(method, params);
  }

  private async callRaw(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.websocket) {
      throw new OpenClawGatewayError("WebSocket connection is not open.");
    }

    const requestId = randomUUID().replaceAll("-", "");
    const responsePromise = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new OpenClawGatewayTimeout(`${method} timed out.`));
        }, this.timeoutMs());
        this.pending.set(requestId, { resolve, reject, timeout });
      },
    );

    this.websocket.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method,
        ...(params ? { params } : {}),
      }),
    );

    const response = await responsePromise;
    if (response.ok !== true) {
      const error = response.error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        throw new OpenClawGatewayRequestError(
          trimToUndefined((error as Record<string, unknown>).message) ??
            `${method} failed.`,
          {
            code: trimToUndefined((error as Record<string, unknown>).code),
            details: (error as Record<string, unknown>).details,
          },
        );
      }
      throw new OpenClawGatewayRequestError(`${method} failed.`);
    }
    const payload = response.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {} as Record<string, unknown>;
    }
    return payload as Record<string, unknown>;
  }

  private async openSocket(): Promise<void> {
    const connection = this.endpoint.connection;
    if (!connection || !("url" in connection)) {
      throw new OpenClawGatewayError(
        "OpenClaw endpoint is missing connection.url.",
      );
    }

    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.challengeResolver = resolve;
      this.challengeRejecter = reject;
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(connection.url);
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          rejectPromise(
            new OpenClawGatewayTimeout("Timed out opening gateway websocket."),
          );
        }
      }, this.timeoutMs());

      socket.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.websocket = socket;
          this.attachSocketHandlers(socket);
          resolvePromise();
        }
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectPromise(
            new OpenClawGatewayError("Failed to open gateway websocket."),
          );
        }
      };
    });
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.onmessage = (event) => {
      try {
        const frame = parseFrame(event.data);
        if (frame.type === "res" && typeof frame.id === "string") {
          const pending = this.pending.get(frame.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(frame.id);
            pending.resolve(frame);
          }
          return;
        }

        if (frame.type !== "event") {
          return;
        }
        if (
          frame.event ===
          (this.endpoint.websocket?.connect?.challengeEvent ??
            "connect.challenge")
        ) {
          const nonce =
            frame.payload &&
            typeof frame.payload === "object" &&
            !Array.isArray(frame.payload)
              ? trimToUndefined(
                  (frame.payload as Record<string, unknown>).nonce,
                )
              : undefined;
          if (nonce) {
            this.challengeResolver?.(nonce);
          } else {
            this.challengeRejecter?.(
              new OpenClawGatewayError(
                "Gateway connect challenge missing nonce.",
              ),
            );
          }
          return;
        }

        if (frame.event !== "chat") {
          return;
        }
        const payload =
          frame.payload &&
          typeof frame.payload === "object" &&
          !Array.isArray(frame.payload)
            ? (frame.payload as Record<string, unknown>)
            : undefined;
        const runId = trimToUndefined(payload?.runId);
        const sessionKey = trimToUndefined(payload?.sessionKey);
        if (!runId || !sessionKey || !payload) {
          return;
        }
        const key = `${runId}:${sessionKey}`;
        for (const waiter of this.chatWaiters.get(key) ?? []) {
          waiter(payload);
        }
      } catch (error) {
        this.failPending(
          error instanceof Error
            ? error
            : new OpenClawGatewayError(String(error)),
        );
      }
    };

    socket.onclose = () => {
      this.connected = false;
      this.websocket = undefined;
      this.failPending(new OpenClawGatewayError("Gateway connection closed."));
    };
  }

  private async shutdownConnection(): Promise<void> {
    const socket = this.websocket;
    this.connected = false;
    this.websocket = undefined;
    this.challengePromise = undefined;
    this.challengeResolver = undefined;
    this.challengeRejecter = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    this.failPending(new OpenClawGatewayError("Gateway connection closed."));
  }

  private failPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private buildConnectParams(
    nonce: string,
    useStoredDeviceTokenRetry: boolean,
  ): Record<string, unknown> {
    const params = structuredClone(
      this.endpoint.websocket?.connect?.params ?? {},
    );
    const client =
      params.client &&
      typeof params.client === "object" &&
      !Array.isArray(params.client)
        ? (params.client as Record<string, unknown>)
        : {};
    const clientId = trimToUndefined(client.id) ?? "openclaw-probe";
    const clientMode = trimToUndefined(client.mode) ?? "probe";
    const clientVersion = trimToUndefined(client.version) ?? "0.1.0";
    const platform = trimToUndefined(client.platform) ?? "typescript";
    const deviceFamily = trimToUndefined(client.deviceFamily);
    const role = trimToUndefined(params.role) ?? "operator";
    const scopes = coerceStringList(params.scopes);
    const authConfig =
      params.auth &&
      typeof params.auth === "object" &&
      !Array.isArray(params.auth)
        ? (params.auth as Record<string, unknown>)
        : {};
    const auth = this.selectConnectAuth(
      role,
      authConfig,
      useStoredDeviceTokenRetry,
    );
    const identity = this.loadDeviceIdentity();
    const signedAtMs = nowMs();
    const signaturePayload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: auth.signatureToken,
      nonce,
      platform,
      deviceFamily,
    });

    return {
      ...params,
      minProtocol: coerceInt(params.minProtocol, 3),
      maxProtocol: coerceInt(params.maxProtocol, 3),
      client: {
        ...client,
        id: clientId,
        version: clientVersion,
        platform,
        mode: clientMode,
      },
      role,
      scopes,
      device: {
        id: identity.deviceId,
        publicKey: base64UrlEncode(publicKeyRawFromPem(identity.publicKeyPem)),
        signature: signDevicePayload(identity.privateKeyPem, signaturePayload),
        signedAt: signedAtMs,
        nonce,
      },
      ...(Object.keys(auth.auth).length > 0 ? { auth: auth.auth } : {}),
    };
  }

  private selectConnectAuth(
    role: string,
    authConfig: Record<string, unknown>,
    useStoredDeviceTokenRetry: boolean,
  ): SelectedConnectAuth {
    const explicitToken = trimToUndefined(authConfig.token);
    const explicitBootstrapToken = trimToUndefined(authConfig.bootstrapToken);
    const explicitPassword = trimToUndefined(authConfig.password);
    const explicitDeviceToken = trimToUndefined(authConfig.deviceToken);
    const storedEntry = loadDeviceAuthToken(this.authStorePath, {
      deviceId: this.loadDeviceIdentity().deviceId,
      role,
    });
    const storedToken = storedEntry?.token;

    let resolvedDeviceToken = explicitDeviceToken;
    if (!resolvedDeviceToken) {
      if (useStoredDeviceTokenRetry && storedToken) {
        resolvedDeviceToken = storedToken;
      } else if (!explicitToken && !explicitPassword) {
        if (!explicitBootstrapToken || storedToken) {
          resolvedDeviceToken = storedToken;
        }
      }
    }

    const auth: Record<string, string> = {};
    if (explicitToken) {
      auth.token = explicitToken;
    } else if (resolvedDeviceToken) {
      auth.token = resolvedDeviceToken;
    }
    if (!explicitToken && !resolvedDeviceToken && explicitBootstrapToken) {
      auth.bootstrapToken = explicitBootstrapToken;
    }
    if (explicitPassword) {
      auth.password = explicitPassword;
    }
    if (useStoredDeviceTokenRetry && storedToken) {
      auth.deviceToken = storedToken;
    }

    return {
      auth,
      signatureToken: auth.token || auth.bootstrapToken || auth.deviceToken,
    };
  }

  private persistIssuedDeviceToken(): void {
    const auth =
      this.hello?.auth &&
      typeof this.hello.auth === "object" &&
      !Array.isArray(this.hello.auth)
        ? (this.hello.auth as Record<string, unknown>)
        : undefined;
    if (!auth) {
      return;
    }
    const token = trimToUndefined(auth.deviceToken);
    if (!token) {
      return;
    }
    storeDeviceAuthToken(this.authStorePath, {
      deviceId: this.loadDeviceIdentity().deviceId,
      role: trimToUndefined(auth.role) ?? this.configuredRole(),
      token,
      scopes: coerceStringList(auth.scopes),
    });
  }

  private shouldRetryWithStoredDeviceToken(
    error: OpenClawGatewayRequestError,
  ): boolean {
    const parsedUrl = new URL(
      (this.endpoint.connection as { url: string }).url,
    );
    const trusted =
      parsedUrl.protocol === "wss:" ||
      ["127.0.0.1", "::1", "localhost"].includes(parsedUrl.hostname);
    if (!trusted) {
      return false;
    }
    const storedEntry = loadDeviceAuthToken(this.authStorePath, {
      deviceId: this.loadDeviceIdentity().deviceId,
      role: this.configuredRole(),
    });
    if (!storedEntry) {
      return false;
    }
    const details =
      error.details &&
      typeof error.details === "object" &&
      !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    return (
      details.canRetryWithDeviceToken === true ||
      details.recommendedNextStep === "retry_with_device_token" ||
      error.code === "AUTH_TOKEN_MISMATCH"
    );
  }

  private configuredRole(): string {
    return (
      trimToUndefined(this.endpoint.websocket?.connect?.params.role) ??
      "operator"
    );
  }

  private loadDeviceIdentity(): DeviceIdentity {
    this.deviceIdentity ??= loadOrCreateDeviceIdentity(this.identityPath);
    return this.deviceIdentity;
  }

  private registerChatWaiter(
    runId: string,
    sessionKey: string,
    waiter: (event: Record<string, unknown>) => void,
  ): void {
    const key = `${runId}:${sessionKey}`;
    const waiters = this.chatWaiters.get(key) ?? [];
    waiters.push(waiter);
    this.chatWaiters.set(key, waiters);
  }

  private unregisterChatWaiter(
    runId: string,
    sessionKey: string,
    waiter: (event: Record<string, unknown>) => void,
  ): void {
    const key = `${runId}:${sessionKey}`;
    const waiters = (this.chatWaiters.get(key) ?? []).filter(
      (item) => item !== waiter,
    );
    if (waiters.length > 0) {
      this.chatWaiters.set(key, waiters);
    } else {
      this.chatWaiters.delete(key);
    }
  }

  private async waitForChatTerminalEvent(
    eventPromise: Promise<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    const timeoutPromise = new Promise<undefined>((resolvePromise) => {
      setTimeout(() => resolvePromise(undefined), timeoutMs);
    });
    const firstEvent = await Promise.race([eventPromise, timeoutPromise]);
    if (!firstEvent) {
      return undefined;
    }
    if (
      firstEvent.state === "final" ||
      firstEvent.state === "error" ||
      firstEvent.state === "aborted"
    ) {
      return firstEvent;
    }
    return firstEvent;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    const timeoutPromise = new Promise<T>((_resolvePromise, rejectPromise) => {
      setTimeout(
        () => rejectPromise(new OpenClawGatewayTimeout(message)),
        timeoutMs,
      );
    });
    return (await Promise.race([promise, timeoutPromise])) as T;
  }

  private timeoutMs(): number {
    const connection = this.endpoint.connection as { timeoutSeconds?: number };
    return (
      (connection.timeoutSeconds ?? DEFAULT_CONNECTION_TIMEOUT_SECONDS) * 1000
    );
  }
}

export class OpenClawEndpointAdapter {
  private client?: OpenClawGatewayClient;
  private session?: OpenClawSession;

  constructor(readonly endpoint: Endpoints) {}

  private async ensureClient(): Promise<OpenClawGatewayClient> {
    if (!this.client) {
      this.client = new OpenClawGatewayClient(this.endpoint);
      await this.client.connect();
    }
    return this.client;
  }

  async healthCheck(): Promise<void> {
    if (this.endpoint.healthCheck?.enabled === false) {
      return;
    }
    await (await this.ensureClient()).health();
  }

  async openScenario(
    renderContext: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.ensureClient();
    const sessionKey =
      trimToUndefined(renderContext.session_key) ??
      trimToUndefined(renderContext.sessionKey);
    const label =
      trimToUndefined(renderContext.label) ??
      (renderContext.scenario &&
      typeof renderContext.scenario === "object" &&
      !Array.isArray(renderContext.scenario)
        ? trimToUndefined(
            (renderContext.scenario as Record<string, unknown>).name,
          )
        : undefined);
    this.session = await client.createSession({ key: sessionKey, label });
    return {
      session_key: this.session.key,
      session_id: this.session.sessionId ?? "",
    };
  }

  async sendUserTurn(
    renderContext: Record<string, unknown>,
  ): Promise<AdapterReply> {
    const client = await this.ensureClient();
    const sessionKey =
      this.session?.key ??
      trimToUndefined(renderContext.session_key) ??
      trimToUndefined(renderContext.sessionKey);
    if (!sessionKey) {
      throw new OpenClawGatewayError(
        "OpenClaw adapter has no active session key.",
      );
    }
    const lastMessage =
      renderContext.last_message &&
      typeof renderContext.last_message === "object"
        ? (renderContext.last_message as Record<string, unknown>)
        : undefined;
    const message =
      trimToUndefined(lastMessage?.content) ??
      trimToUndefined(renderContext.message);
    if (!message) {
      throw new OpenClawGatewayError(
        "OpenClaw adapter requires a user message.",
      );
    }

    const startedAt = performance.now();
    const result = await client.sendMessage(sessionKey, message);
    return {
      assistantText: result.reply ?? "",
      toolCalls: [],
      rawExchange: {
        request: {
          session_key: sessionKey,
          message,
        },
        response: result as unknown as Record<string, JsonValue>,
      },
      latencyMs: performance.now() - startedAt,
      usage: {},
    };
  }

  async closeScenario(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    this.client = undefined;
    this.session = undefined;
  }
}

export function buildOpenClawAdapter(
  endpoint: Endpoints,
): OpenClawEndpointAdapter {
  return new OpenClawEndpointAdapter(endpoint);
}

export async function openclawChat(
  endpoint: Endpoints,
  options: {
    message: string;
    sessionKey?: string;
    label?: string;
    thinking?: string;
    waitForReply?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenClawChatResult> {
  const client = new OpenClawGatewayClient(configureEndpoint(endpoint));
  await client.connect();
  try {
    const session = await client.createSession({
      key: options.sessionKey,
      label: options.label,
    });
    const result = await client.sendMessage(session.key, options.message, {
      thinking: options.thinking,
      waitForReply: options.waitForReply,
      timeoutMs: options.timeoutMs,
    });
    if (!result.sessionId) {
      result.sessionId = session.sessionId;
    }
    return result;
  } finally {
    await client.close();
  }
}

export async function openclawHistory(
  endpoint: Endpoints,
  options: {
    sessionKey: string;
    limit?: number;
  },
): Promise<OpenClawHistory> {
  const client = new OpenClawGatewayClient(configureEndpoint(endpoint));
  await client.connect();
  try {
    return await client.history(options.sessionKey, { limit: options.limit });
  } finally {
    await client.close();
  }
}

export function loadConfiguredEndpoint(path: string): Endpoints {
  return configureEndpoint(parseEndpointsYaml(path));
}
