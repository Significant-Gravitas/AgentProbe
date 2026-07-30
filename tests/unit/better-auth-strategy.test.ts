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
const ACCOUNT = {
  email: "bench@agpt.co",
  password: "correct horse battery staple",
};

let originalFetch: typeof fetch;
let originalEnv: Record<string, string | undefined>;
let requests: RecordedRequest[];

/**
 * Fake Better Auth + backend. `knownAccounts` decides whether sign-in
 * succeeds, so the sign-in-first flow can be exercised both ways.
 */
function installFetch(options: { knownAccounts?: Set<string> } = {}): void {
  const known = options.knownAccounts ?? new Set([ACCOUNT.email]);
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

    return route(url.pathname, body, known);
  }) as typeof fetch;
}

function route(pathname: string, body: unknown, known: Set<string>): Response {
  const email = (body as { email?: string } | null)?.email ?? "";
  switch (pathname) {
    case "/api/auth/sign-up/email":
      known.add(email);
      return new Response(null, { status: 200 });
    case "/api/auth/sign-in/email":
      return known.has(email)
        ? new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "Set-Cookie":
                "better-auth.session_token=sess-123; Path=/; HttpOnly",
            },
          })
        : new Response(
            JSON.stringify({
              message: "Invalid email or password",
              code: "INVALID_EMAIL_OR_PASSWORD",
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
    case "/api/auth/token":
      return new Response(JSON.stringify({ token: ES256_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    case "/api/auth/user":
    case "/api/copilot/admin/rate_limit/tier":
      return new Response(null, { status: 204 });
    default:
      throw new Error(`Unexpected request: ${pathname}`);
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = {
    AUTOGPT_ADMIN_TOKEN: process.env.AUTOGPT_ADMIN_TOKEN,
    AUTOGPT_ALLOW_SIGNUP: process.env.AUTOGPT_ALLOW_SIGNUP,
    AUTOGPT_EMAIL: process.env.AUTOGPT_EMAIL,
    AUTOGPT_PASSWORD: process.env.AUTOGPT_PASSWORD,
  };
  for (const key of Object.keys(originalEnv)) {
    delete process.env[key];
  }
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("better-auth strategy", () => {
  test("signs in to the existing account, mints a token, and provisions the user", async () => {
    const result = await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
      name: "Bench",
    });

    expect(result.token).toBe(ES256_TOKEN);
    expect(result.headers.Authorization).toBe(`Bearer ${ES256_TOKEN}`);

    // Sign-up is never attempted for an account that already exists.
    const paths = requests.map((r) => `${r.method} ${r.url}`);
    expect(paths).toEqual([
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

  test("does not create an account when sign-in fails and signup is not allowed", async () => {
    installFetch({ knownAccounts: new Set() });

    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        ...ACCOUNT,
      }),
    ).rejects.toThrow(/must exist in Better Auth/i);

    expect(requests.map((r) => r.url)).toEqual(["/api/auth/sign-in/email"]);
  });

  test("provisions the account only when signup is explicitly allowed", async () => {
    installFetch({ knownAccounts: new Set() });

    const result = await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
      allowSignup: true,
    });

    expect(result.token).toBe(ES256_TOKEN);
    expect(requests.map((r) => r.url)).toEqual([
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/token",
      "/api/auth/user",
    ]);
  });

  test("surfaces a gated signup with an actionable message", async () => {
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
      if (url.pathname === "/api/auth/sign-in/email") {
        return new Response(
          JSON.stringify({
            message: "Invalid email or password",
            code: "INVALID_EMAIL_OR_PASSWORD",
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/api/auth/sign-up/email") {
        return new Response(
          JSON.stringify({
            message: "Signups are not allowed",
            code: "SIGNUP_DISABLED",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected: ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        ...ACCOUNT,
        allowSignup: true,
      }),
    ).rejects.toThrow(/Signups are not allowed/);
  });

  test("applies the ENTERPRISE tier with an admin token", async () => {
    process.env.AUTOGPT_ADMIN_TOKEN = "admin-bearer";
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
      userId: "user-1",
    });

    const tierCall = requests.find(
      (r) => r.url === "/api/copilot/admin/rate_limit/tier",
    );
    expect(tierCall?.authorization).toBe("Bearer admin-bearer");
    expect(tierCall?.body).toEqual({ tier: "ENTERPRISE", user_id: "user-1" });
  });

  test("requires an email — it must not invent one like the forge did", async () => {
    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        password: ACCOUNT.password,
      }),
    ).rejects.toThrow(/requires a stable benchmark account/i);
  });

  test("requires a password", async () => {
    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        email: ACCOUNT.email,
      }),
    ).rejects.toThrow(/requires a password/i);
  });
});
