import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

import { executeCli } from "../../src/cli/main.ts";
import { parseEndpointsYaml } from "../../src/domains/validation/load-suite.ts";
import { buildEndpointAdapter } from "../../src/providers/sdk/adapters.ts";
import {
  OpenClawGatewayClient,
  openclawChat,
  openclawHistory,
} from "../../src/providers/sdk/openclaw.ts";
import { configureEndpoint } from "../../src/providers/sdk/preset-config.ts";
import type { Endpoints, JsonValue } from "../../src/shared/types/contracts.ts";
import { DATA_DIR, makeTempDir } from "./support.ts";

type SessionState = {
  sessionId: string;
  label?: string;
  messages: Array<Record<string, JsonValue>>;
};

type GatewaySocket = ServerWebSocket<{ nonce: string }>;

class FakeOpenClawGateway {
  readonly authAttempts: Array<Record<string, unknown>> = [];
  readonly sessions = new Map<string, SessionState>();
  private readonly deviceTokens = new Map<string, string>();
  private server?: ReturnType<typeof Bun.serve>;
  private sessionCounter = 0;
  private sessionIdCounter = 0;

  async start(): Promise<void> {
    const gateway = this;
    this.server = Bun.serve<{ nonce: string }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        const upgraded = server.upgrade(req, {
          data: { nonce: `nonce-${crypto.randomUUID()}` },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 500 });
      },
      websocket: {
        open(ws) {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: {
                nonce: ws.data.nonce,
                ts: 1_737_264_000_000,
              },
            }),
          );
        },
        message(ws, raw) {
          gateway.handleFrame(ws, raw);
        },
      },
    });
    await Bun.sleep(0);
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = undefined;
    await Bun.sleep(0);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server?.port ?? 0}`;
  }

  private handleFrame(ws: GatewaySocket, raw: string | Buffer): void {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const method = frame.method;
    const requestId =
      typeof frame.id === "string" ? frame.id : crypto.randomUUID();
    const params =
      frame.params &&
      typeof frame.params === "object" &&
      !Array.isArray(frame.params)
        ? (frame.params as Record<string, unknown>)
        : {};

    if (method === "connect") {
      this.handleConnect(ws, requestId, params);
      return;
    }

    if (method === "health") {
      this.sendOk(ws, requestId, { status: "ok" });
      return;
    }

    if (method === "sessions.create") {
      const sessionKey =
        typeof params.key === "string" && params.key.trim()
          ? params.key.trim()
          : `session-${++this.sessionCounter}`;
      if (!this.sessions.has(sessionKey)) {
        this.sessions.set(sessionKey, {
          sessionId: `sess-${++this.sessionIdCounter}`,
          label: typeof params.label === "string" ? params.label : undefined,
          messages: [],
        });
      }
      const session = this.sessions.get(sessionKey);
      if (!session) {
        this.sendError(ws, requestId, "INVALID_REQUEST", "unknown session");
        return;
      }
      this.sendOk(ws, requestId, {
        ok: true,
        key: sessionKey,
        sessionId: session.sessionId,
        entry: {
          sessionId: session.sessionId,
          label: session.label ?? null,
        },
      });
      return;
    }

    if (method === "chat.send") {
      const sessionKey =
        typeof params.sessionKey === "string" ? params.sessionKey : undefined;
      const message =
        typeof params.message === "string" ? params.message : undefined;
      const runId =
        typeof params.idempotencyKey === "string"
          ? params.idempotencyKey
          : crypto.randomUUID();
      const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
      if (!session || !message) {
        this.sendError(
          ws,
          requestId,
          "INVALID_REQUEST",
          "invalid chat.send params",
        );
        return;
      }

      session.messages.push({
        role: "user",
        content: [{ type: "text", text: message }],
      });
      const reply = `Echo: ${message}`;
      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: reply }],
      } satisfies Record<string, JsonValue>;
      session.messages.push(assistantMessage);

      this.sendOk(ws, requestId, {
        runId,
        status: "started",
      });
      ws.send(
        JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId,
            sessionKey,
            seq: 0,
            state: "final",
            message: assistantMessage,
          },
        }),
      );
      return;
    }

    if (method === "chat.history") {
      const sessionKey =
        typeof params.sessionKey === "string" ? params.sessionKey : undefined;
      const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
      if (!session || !sessionKey) {
        this.sendError(ws, requestId, "INVALID_REQUEST", "unknown session");
        return;
      }
      this.sendOk(ws, requestId, {
        sessionId: session.sessionId,
        messages: session.messages,
      });
      return;
    }

    this.sendError(
      ws,
      requestId,
      "INVALID_REQUEST",
      `unexpected method: ${String(method)}`,
    );
  }

  private handleConnect(
    ws: GatewaySocket,
    requestId: string,
    params: Record<string, unknown>,
  ): void {
    this.authAttempts.push(params);
    const device =
      params.device &&
      typeof params.device === "object" &&
      !Array.isArray(params.device)
        ? (params.device as Record<string, unknown>)
        : {};
    const auth =
      params.auth &&
      typeof params.auth === "object" &&
      !Array.isArray(params.auth)
        ? (params.auth as Record<string, unknown>)
        : {};
    const nonce = typeof device.nonce === "string" ? device.nonce : undefined;
    if (nonce !== ws.data.nonce) {
      this.sendError(ws, requestId, "INVALID_REQUEST", "nonce mismatch");
      return;
    }

    const deviceId =
      typeof device.id === "string"
        ? device.id
        : `device-${crypto.randomUUID()}`;
    const token =
      typeof auth.token === "string"
        ? auth.token
        : typeof auth.bootstrapToken === "string"
          ? auth.bootstrapToken
          : "";

    if (token !== "shared-token" && !token.startsWith("device-token-")) {
      this.sendError(ws, requestId, "AUTH_FAILED", "invalid token");
      return;
    }

    const deviceToken =
      this.deviceTokens.get(deviceId) ?? `device-token-${deviceId.slice(0, 8)}`;
    this.deviceTokens.set(deviceId, deviceToken);
    this.sendOk(ws, requestId, {
      protocol: 3,
      auth: {
        deviceToken,
        role: typeof params.role === "string" ? params.role : "operator",
        scopes: Array.isArray(params.scopes) ? params.scopes : [],
      },
    });
  }

  private sendOk(
    ws: GatewaySocket,
    id: string,
    payload: Record<string, unknown>,
  ): void {
    ws.send(
      JSON.stringify({
        type: "res",
        id,
        ok: true,
        payload,
      }),
    );
  }

  private sendError(
    ws: GatewaySocket,
    id: string,
    code: string,
    message: string,
  ): void {
    ws.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: { code, message },
      }),
    );
  }
}

describe("openclaw", () => {
  const envSnapshot = {
    AGENTPROBE_STATE_DIR: process.env.AGENTPROBE_STATE_DIR,
    OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
  };

  let gateway: FakeOpenClawGateway;

  beforeEach(async () => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    gateway = new FakeOpenClawGateway();
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  function configuredEndpoint(stateRoot: string): Endpoints {
    process.env.AGENTPROBE_STATE_DIR = stateRoot;
    process.env.OPENCLAW_GATEWAY_URL = gateway.url;
    process.env.OPENCLAW_GATEWAY_TOKEN = "shared-token";
    return configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "openclaw-endpoints.yaml")),
    );
  }

  test("round trips chat and history", async () => {
    const endpoint = configuredEndpoint(makeTempDir("openclaw-state-1"));

    const result = await openclawChat(endpoint, { message: "hello openclaw" });

    expect(result.status).toBe("ok");
    expect(result.reply).toBe("Echo: hello openclaw");
    expect(result.sessionKey in Object.fromEntries(gateway.sessions)).toBe(
      true,
    );

    const history = await openclawHistory(endpoint, {
      sessionKey: result.sessionKey,
    });

    expect(history.sessionId).toBe(result.sessionId);
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      (history.messages.at(-1)?.content as Array<{ text: string }>)[0]?.text,
    ).toBe("Echo: hello openclaw");
  });

  test("creates isolated sessions", async () => {
    const endpoint = configuredEndpoint(makeTempDir("openclaw-state-2"));

    const client = new OpenClawGatewayClient(endpoint);
    await client.connect();
    try {
      const sessionA = await client.createSession({ label: "alpha" });
      const sessionB = await client.createSession({ label: "beta" });
      const replyA = await client.sendMessage(sessionA.key, "alpha only");
      const replyB = await client.sendMessage(sessionB.key, "beta only");
      const historyA = await client.history(sessionA.key);
      const historyB = await client.history(sessionB.key);

      expect(sessionA.key).not.toBe(sessionB.key);
      expect(replyA.reply).toBe("Echo: alpha only");
      expect(replyB.reply).toBe("Echo: beta only");
      expect(
        (historyA.messages.at(-1)?.content as Array<{ text: string }>)[0]?.text,
      ).toBe("Echo: alpha only");
      expect(
        (historyB.messages.at(-1)?.content as Array<{ text: string }>)[0]?.text,
      ).toBe("Echo: beta only");
    } finally {
      await client.close();
    }
  });

  test("reuses cached device tokens", async () => {
    const stateRoot = makeTempDir("openclaw-state-3");
    const firstEndpoint = configuredEndpoint(stateRoot);

    const firstClient = new OpenClawGatewayClient(firstEndpoint);
    await firstClient.connect();
    try {
      expect(await firstClient.health()).toEqual({ status: "ok" });
    } finally {
      await firstClient.close();
    }

    process.env.AGENTPROBE_STATE_DIR = stateRoot;
    process.env.OPENCLAW_GATEWAY_URL = gateway.url;
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    const secondEndpoint = configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "openclaw-endpoints.yaml")),
    );
    const secondClient = new OpenClawGatewayClient(secondEndpoint);
    await secondClient.connect();
    try {
      expect(await secondClient.health()).toEqual({ status: "ok" });
    } finally {
      await secondClient.close();
    }

    const secondAuth = gateway.authAttempts[1]?.auth as Record<string, string>;
    expect(secondAuth.token.startsWith("device-token-")).toBe(true);
  });

  test("works through the generic endpoint adapter", async () => {
    const endpoint = configuredEndpoint(makeTempDir("openclaw-state-4"));
    const adapter = buildEndpointAdapter(endpoint);

    await adapter.healthCheck({});
    const sessionState = await adapter.openScenario({ label: "adapter-test" });
    const reply = await adapter.sendUserTurn({
      ...sessionState,
      last_message: { content: "through adapter" },
    });
    await adapter.closeScenario({});

    expect(typeof sessionState.session_key).toBe("string");
    expect(reply.assistantText).toBe("Echo: through adapter");
  });

  test("supports the cli chat subcommand", async () => {
    const stateRoot = makeTempDir("openclaw-state-5");
    process.env.AGENTPROBE_STATE_DIR = stateRoot;
    process.env.OPENCLAW_GATEWAY_URL = gateway.url;
    process.env.OPENCLAW_GATEWAY_TOKEN = "shared-token";

    const outputPath = join(makeTempDir("openclaw-endpoint"), "endpoint.yaml");
    writeFileSync(
      outputPath,
      [
        "preset: openclaw",
        "transport: websocket",
        "connection:",
        `  url: "${gateway.url}"`,
        "  timeout_seconds: 30",
        "  max_retries: 1",
        "websocket:",
        "  connect:",
        "    challenge_event: connect.challenge",
        "    method: connect",
        "    params:",
        "      client:",
        "        id: openclaw-probe",
        '        version: "0.1.0"',
        "        platform: typescript",
        "        mode: probe",
        "      role: operator",
        "      scopes:",
        "        - operator.read",
        "        - operator.write",
        "      auth:",
        '        token: "shared-token"',
        "health_check:",
        "  enabled: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const exitCode = await executeCli([
      "openclaw",
      "chat",
      "--endpoint",
      outputPath,
      "--message",
      "from cli",
    ]);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      status: string;
      reply: string;
    };
    expect(payload.status).toBe("ok");
    expect(payload.reply).toBe("Echo: from cli");

    logSpy.mockRestore();
    unlinkSync(outputPath);
  });
});
