import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  deriveIsolatedAccount,
  resolveBetterAuthAuth,
} from "../../src/providers/sdk/better-auth-strategy.ts";

type RecordedRequest = {
  method: string;
  url: string;
  cookie: string | null;
  authorization: string | null;
  body: unknown;
};

const FRONTEND = "http://frontend.test:3000";
const BACKEND = "http://backend.test:8006";
const ACCOUNT = {
  email: "bench@agpt.co",
  password: "correct horse battery staple",
};

/** Unsigned but JWT-shaped, so the strategy can read `sub`/`role` claims. */
function fakeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

const SUBJECT = "3f6c2a1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const ES256_TOKEN = fakeJwt({ sub: SUBJECT, role: "user" });
const ADMIN_TOKEN = fakeJwt({ sub: SUBJECT, role: "admin" });

let originalFetch: typeof fetch;
let originalEnv: Record<string, string | undefined>;
let requests: RecordedRequest[];

/**
 * Fake Better Auth + backend. `knownAccounts` decides whether sign-in
 * succeeds, so the sign-in-first flow can be exercised both ways.
 */
function installFetch(
  options: { knownAccounts?: Set<string>; mintedToken?: string } = {},
): void {
  const known = options.knownAccounts ?? new Set([ACCOUNT.email]);
  const minted = options.mintedToken ?? ES256_TOKEN;
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

    return route(url.pathname, body, known, minted);
  }) as typeof fetch;
}

function route(
  pathname: string,
  body: unknown,
  known: Set<string>,
  minted: string,
): Response {
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
      return new Response(JSON.stringify({ token: minted }), {
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
    AUTOGPT_USER_ID: process.env.AUTOGPT_USER_ID,
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

  test("does not create an account when signup is explicitly disabled", async () => {
    installFetch({ knownAccounts: new Set() });

    await expect(
      resolveBetterAuthAuth({
        frontendUrl: FRONTEND,
        backendUrl: BACKEND,
        ...ACCOUNT,
        allowSignup: false,
      }),
    ).rejects.toThrow(/disabled auto-provisioning/i);

    expect(requests.map((r) => r.url)).toEqual(["/api/auth/sign-in/email"]);
  });

  test("auto-provisions the account by default when sign-in reports it unknown", async () => {
    installFetch({ knownAccounts: new Set() });

    const result = await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
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

  test("applies the ENTERPRISE tier with an admin token, targeting the token's subject", async () => {
    process.env.AUTOGPT_ADMIN_TOKEN = "admin-bearer";
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
    });

    const tierCall = requests.find(
      (r) => r.url === "/api/copilot/admin/rate_limit/tier",
    );
    expect(tierCall?.authorization).toBe("Bearer admin-bearer");
    expect(tierCall?.body).toEqual({ tier: "ENTERPRISE", user_id: SUBJECT });
  });

  test("derives an isolated sub-account from the pinned identity by default", async () => {
    const pinned = "3F6C2A1E-5B7D-4E8F-9A0B-1C2D3E4F5A6B";
    const derived = deriveIsolatedAccount({
      ...ACCOUNT,
      identitySeed: pinned,
    });
    expect(derived.email).toBe("bench+3f6c2a1e5b7d4e8f@agpt.co");
    expect(derived.password).toBe(
      createHmac("sha256", ACCOUNT.password)
        .update(derived.email)
        .digest("hex"),
    );

    // Only the base account exists, so the derived one is provisioned on
    // first use: sign-in 401 → sign-up → sign-in.
    installFetch({ knownAccounts: new Set([ACCOUNT.email]) });
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
      userId: pinned,
    });

    const authCalls = requests
      .filter((r) => r.url.startsWith("/api/auth/sign-"))
      .map((r) => ({
        url: r.url,
        email: (r.body as { email?: string } | null)?.email,
      }));
    expect(authCalls).toEqual([
      { url: "/api/auth/sign-in/email", email: derived.email },
      { url: "/api/auth/sign-up/email", email: derived.email },
      { url: "/api/auth/sign-in/email", email: derived.email },
    ]);
    const signUpCall = requests.find(
      (r) => r.url === "/api/auth/sign-up/email",
    );
    expect((signUpCall?.body as { password?: string } | null)?.password).toBe(
      derived.password,
    );
  });

  test("shares the base account when isolation is requested but signup is disabled via env", async () => {
    process.env.AUTOGPT_ALLOW_SIGNUP = "false";
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
      userId: "3f6c2a1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
    });

    const signIns = requests.filter((r) => r.url === "/api/auth/sign-in/email");
    expect(
      signIns.map((r) => (r.body as { email?: string } | null)?.email),
    ).toEqual([ACCOUNT.email]);
  });

  test("targets the tier grant at the token's own subject when no user id is given", async () => {
    process.env.AUTOGPT_ADMIN_TOKEN = "admin-bearer";
    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
    });

    const tierCall = requests.find(
      (r) => r.url === "/api/copilot/admin/rate_limit/tier",
    );
    expect(tierCall?.body).toEqual({ tier: "ENTERPRISE", user_id: SUBJECT });
  });

  test("self-grants the tier when the account's own token carries the admin role", async () => {
    installFetch({ mintedToken: ADMIN_TOKEN });

    await resolveBetterAuthAuth({
      frontendUrl: FRONTEND,
      backendUrl: BACKEND,
      ...ACCOUNT,
    });

    const tierCall = requests.find(
      (r) => r.url === "/api/copilot/admin/rate_limit/tier",
    );
    expect(tierCall?.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(tierCall?.body).toEqual({ tier: "ENTERPRISE", user_id: SUBJECT });
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
