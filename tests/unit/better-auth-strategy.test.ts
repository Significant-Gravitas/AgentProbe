import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveBetterAuthAuth } from "../../src/providers/sdk/better-auth-strategy.ts";

type RecordedRequest = {
  method: string;
  url: string;
  cookie: string | null;
  authorization: string | null;
  body: unknown;
};

const FRONTEND = "http://frontend.test:3000";
const BACKEND = "http://backend.test:8006";
const ES256_TOKEN = "header.payload.signature";

let originalFetch: typeof fetch;
let originalAdminToken: string | undefined;
let requests: RecordedRequest[];

function installFetch(): void {
  requests = [];
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
    // enableSubscription posts JSON without a content-type header, so key off
    // the admin path too (mirrors the autogpt-auth mock).
    const body =
      request.headers.get("content-type")?.includes("json") ||
      url.pathname === "/api/copilot/admin/rate_limit/tier"
        ? await request.clone().json()
        : null;
    requests.push({
      method: request.method,
      url: url.pathname,
      cookie: request.headers.get("Cookie"),
      authorization: request.headers.get("Authorization"),
      body,
    });

    if (url.pathname === "/api/auth/sign-up/email") {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/api/auth/sign-in/email") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Set-Cookie": "better-auth.session_token=sess-123; Path=/; HttpOnly",
        },
      });
    }
    if (url.pathname === "/api/auth/token") {
      return new Response(JSON.stringify({ token: ES256_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/auth/user") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/copilot/admin/rate_limit/tier") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalAdminToken = process.env.AUTOGPT_ADMIN_TOKEN;
  delete process.env.AUTOGPT_ADMIN_TOKEN;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAdminToken === undefined) {
    delete process.env.AUTOGPT_ADMIN_TOKEN;
  } else {
    process.env.AUTOGPT_ADMIN_TOKEN = originalAdminToken;
  }
});

describe("better-auth strategy", () => {
  test("signs up, signs in, mints an ES256 token, and provisions the user", async () => {
    const result = await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      email: "bench@agpt.co",
      password: "correct horse battery staple",
      name: "Bench",
    });

    expect(result.token).toBe(ES256_TOKEN);
    expect(result.headers.Authorization).toBe(`Bearer ${ES256_TOKEN}`);

    const paths = requests.map((r) => `${r.method} ${r.url}`);
    expect(paths).toEqual([
      "POST /api/auth/sign-up/email",
      "POST /api/auth/sign-in/email",
      "GET /api/auth/token",
      "POST /api/auth/user",
    ]);

    // The session cookie from sign-in is forwarded to the token endpoint.
    const tokenCall = requests.find((r) => r.url === "/api/auth/token");
    expect(tokenCall?.cookie).toContain("better-auth.session_token=sess-123");

    // The minted token (not a forged one) authenticates the backend call.
    const provision = requests.find((r) => r.url === "/api/auth/user");
    expect(provision?.authorization).toBe(`Bearer ${ES256_TOKEN}`);

    // No admin token → the ENTERPRISE tier grant is skipped.
    expect(
      requests.some((r) => r.url === "/api/copilot/admin/rate_limit/tier"),
    ).toBe(false);
  });

  test("applies the ENTERPRISE tier with an admin token", async () => {
    process.env.AUTOGPT_ADMIN_TOKEN = "admin-bearer";
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      email: "bench@agpt.co",
      password: "correct horse battery staple",
      userId: "user-1",
    });

    const tierCall = requests.find(
      (r) => r.url === "/api/copilot/admin/rate_limit/tier",
    );
    expect(tierCall?.authorization).toBe("Bearer admin-bearer");
    expect(tierCall?.body).toEqual({ tier: "ENTERPRISE", user_id: "user-1" });
  });

  test("requires a password", async () => {
    const original = process.env.AUTOGPT_PASSWORD;
    delete process.env.AUTOGPT_PASSWORD;
    try {
      await expect(
        resolveBetterAuthAuth({ frontendUrl: FRONTEND, backendUrl: BACKEND }),
      ).rejects.toThrow(/requires a password/i);
    } finally {
      if (original === undefined) delete process.env.AUTOGPT_PASSWORD;
      else process.env.AUTOGPT_PASSWORD = original;
    }
  });

  test("surfaces the signup-gate rejection with an actionable message", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/auth/sign-up/email") {
        return new Response("Signups are not allowed.", { status: 403 });
      }
      throw new Error(`Unexpected: ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        email: "random@example.com",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow(/AUTH_SIGNUP_ALLOWLIST/);
  });
});
