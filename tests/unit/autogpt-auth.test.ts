import { describe, expect, test } from "bun:test";

import {
  defaultUserId,
  forgeJwt,
  resolveAuth,
} from "../../src/providers/sdk/autogpt-auth.ts";

describe("autogpt auth", () => {
  test("defaultUserId returns a UUID", () => {
    expect(defaultUserId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("forgeJwt preserves the subject", () => {
    const userId = crypto.randomUUID();
    const token = forgeJwt({
      userId,
      email: "agentprobe@example.com",
      jwtSecret: "test-secret",
      jwtAlgorithm: "HS256",
      issuer: "supabase-demo",
      audience: "authenticated",
      role: "user",
      name: "AgentProbe User",
    });

    expect(typeof token).toBe("string");
    const [, payload] = token.split(".");
    expect(payload).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString("utf8"),
    ) as { sub?: string };
    expect(decoded.sub).toBe(userId);
  });

  test("resolveAuth always forges the token and registers the user", async () => {
    const originalFetch = globalThis.fetch;
    const originalAuthMode = process.env.AUTOGPT_AUTH_MODE;
    const requests: Array<{
      authorization: string | null;
      method: string;
      path: string;
    }> = [];

    process.env.AUTOGPT_AUTH_MODE = "supabase";
    globalThis.fetch = (async (
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
      const url = new URL(request.url);
      requests.push({
        authorization: request.headers.get("Authorization"),
        method: request.method,
        path: url.pathname,
      });

      if (request.method === "POST" && url.pathname === "/api/auth/user") {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }) as typeof fetch;

    try {
      const userId = crypto.randomUUID();
      const result = await resolveAuth({
        audience: "authenticated",
        backendUrl: "http://backend.test:8006",
        email: "agentprobe@example.com",
        issuer: "supabase-demo",
        jwtAlgorithm: "HS256",
        jwtSecret: "test-secret",
        name: "AgentProbe User",
        role: "user",
        userId,
      });

      expect(requests).toEqual([
        {
          authorization: `Bearer ${result.token}`,
          method: "POST",
          path: "/api/auth/user",
        },
      ]);
      expect(result.headers.Authorization).toBe(`Bearer ${result.token}`);

      const [, payload] = result.token.split(".");
      const decoded = JSON.parse(
        Buffer.from(payload ?? "", "base64url").toString("utf8"),
      ) as { sub?: string; user_metadata?: { name?: string } };
      expect(decoded.sub).toBe(userId);
      expect(decoded.user_metadata?.name).toBe("AgentProbe User");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAuthMode === undefined) {
        delete process.env.AUTOGPT_AUTH_MODE;
      } else {
        process.env.AUTOGPT_AUTH_MODE = originalAuthMode;
      }
    }
  });
});
