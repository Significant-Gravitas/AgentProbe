import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseEndpointsYaml } from "../../src/domains/validation/load-suite.ts";
import {
  buildEndpointAdapter,
  HttpEndpointAdapter,
  OpenClawEndpointAdapter,
} from "../../src/providers/sdk/adapters.ts";
import type { AutogptAuthResult } from "../../src/shared/types/contracts.ts";
import { DATA_DIR } from "./support.ts";

describe("endpoint adapters", () => {
  const envSnapshot = {
    OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL,
    AUTOGPT_BACKEND_URL: process.env.AUTOGPT_BACKEND_URL,
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("handles opencode managed session flow", async () => {
    process.env.OPENCODE_BASE_URL = "http://opencode.test:9999";
    const requests: Array<{
      method: string;
      path: string;
      headers: Headers;
      body: unknown;
    }> = [];

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(
              typeof input === "string" ? input : input.toString(),
              init,
            );
      const bodyText = request.method === "GET" ? "" : await request.text();
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      });

      if (request.method === "GET" && url.pathname === "/global/health") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/session") {
        expect(JSON.parse(bodyText)).toEqual({
          title: "AgentProbe: demo / shopper",
        });
        return Response.json({ id: "session-123" });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/session/session-123/message"
      ) {
        expect(JSON.parse(bodyText)).toEqual({
          parts: [{ type: "text", text: "Hello adapter" }],
        });
        return Response.json({
          parts: [{ type: "text", text: "Hello from OpenCode" }],
        });
      }
      if (
        request.method === "DELETE" &&
        url.pathname === "/session/session-123"
      ) {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }) as typeof fetch;

    const adapter = buildEndpointAdapter(
      parseEndpointsYaml(join(DATA_DIR, "opencode-endpoints.yaml")),
      { fetchImpl },
    );

    expect(adapter).toBeInstanceOf(HttpEndpointAdapter);

    const baseContext = {
      scenario: { id: "demo" },
      persona: { id: "shopper" },
      last_message: { content: "Hello adapter" },
    };

    await adapter.healthCheck(baseContext);
    const session = await adapter.openScenario(baseContext);
    const reply = await adapter.sendUserTurn({ ...baseContext, ...session });
    await adapter.closeScenario({ ...baseContext, ...session });

    expect(session).toEqual({ session_id: "session-123" });
    expect(reply.assistantText).toBe("Hello from OpenCode");
    expect(requests.map((request) => request.path)).toEqual([
      "/global/health",
      "/session",
      "/session/session-123/message",
      "/session/session-123",
    ]);
  });

  test("handles autogpt auth, sse responses, and tool extraction", async () => {
    process.env.AUTOGPT_BACKEND_URL = "http://backend.test:8006";
    const requests: Array<{ method: string; path: string }> = [];
    let authCalls = 0;

    const fakeAuth = (): AutogptAuthResult => {
      authCalls += 1;
      return {
        token: "fake-token",
        headers: { Authorization: "Bearer fake-token" },
      };
    };

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(
              typeof input === "string" ? input : input.toString(),
              init,
            );
      const bodyText = request.method === "GET" ? "" : await request.text();
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      expect(request.headers.get("Authorization")).toBe("Bearer fake-token");

      if (request.method === "POST" && url.pathname === "/api/chat/sessions") {
        expect(JSON.parse(bodyText)).toEqual({ dry_run: true });
        return Response.json({ id: "chat-123" });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/chat/sessions/chat-123/stream"
      ) {
        expect(JSON.parse(bodyText)).toEqual({
          message: "Hello AutoGPT",
          is_user_message: true,
          mode: "fast",
        });
        return new Response(
          [
            'data: {"type":"text-delta","delta":"First chunk"}',
            "",
            'data: {"type":"tool-input-start","toolCallId":"toolu_123","toolName":"find_block"}',
            "",
            'data: {"type":"tool-input-available","toolCallId":"toolu_123","toolName":"find_block","input":{"query":"HubSpot CRM contact"}}',
            "",
            'data: {"type":"tool-output-available","toolCallId":"toolu_123","output":"{\\"type\\":\\"block_list\\",\\"count\\":10}"}',
            "",
            'data: {"type":"text-delta","delta":"Second chunk"}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }) as typeof fetch;

    const adapter = buildEndpointAdapter(
      parseEndpointsYaml(join(DATA_DIR, "autogpt-endpoint.yaml")),
      {
        fetchImpl,
        autogptAuthResolver: fakeAuth,
      },
    );

    const baseContext = {
      scenario: { id: "demo" },
      persona: { id: "shopper" },
      last_message: { content: "Hello AutoGPT" },
      copilot_mode: "fast",
    };

    const session = await adapter.openScenario(baseContext);
    const reply = await adapter.sendUserTurn({ ...baseContext, ...session });

    expect(session).toEqual({ session_id: "chat-123" });
    expect(reply.assistantText).toBe("First chunk\nSecond chunk");
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]).toMatchObject({
      name: "find_block",
      args: { query: "HubSpot CRM contact" },
      order: 1,
      raw: {
        tool_call_id: "toolu_123",
        output: { type: "block_list", count: 10 },
      },
    });
    expect(authCalls).toBe(1);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/chat/sessions",
      "/api/chat/sessions/chat-123/stream",
    ]);
  });

  test("dispatches adapters by transport", () => {
    const httpAdapter = buildEndpointAdapter(
      parseEndpointsYaml(join(DATA_DIR, "opencode-endpoints.yaml")),
    );
    const websocketAdapter = buildEndpointAdapter(
      parseEndpointsYaml(join(DATA_DIR, "openclaw-endpoints.yaml")),
    );

    expect(httpAdapter).toBeInstanceOf(HttpEndpointAdapter);
    expect(websocketAdapter).toBeInstanceOf(OpenClawEndpointAdapter);
  });
});
