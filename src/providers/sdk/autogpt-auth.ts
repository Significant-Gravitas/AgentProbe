import { createHmac, randomUUID } from "node:crypto";

import type { AutogptAuthResult } from "../../shared/types/contracts.ts";

/**
 * How AgentProbe obtains a bearer token the AutoGPT backend will accept.
 *
 * - `supabase` (default): forge an HS256 JWT signed with the shared
 *   `AUTOGPT_JWT_SECRET`. Matches the Supabase GoTrue token the backend has
 *   always accepted. Works only while the backend still honours the legacy
 *   symmetric secret (`JWT_VERIFY_KEY`).
 * - `better-auth`: obtain a real ES256 token from the Better Auth service
 *   (sign up / sign in / mint), verified by the backend via JWKS. Required
 *   once the platform drops the legacy HS256 path. Implemented separately.
 */
export type AutogptAuthMode = "supabase" | "better-auth";

const DEFAULT_BACKEND_URL =
  Bun.env.AUTOGPT_BACKEND_URL?.trim() ||
  Bun.env.BACKEND_URL?.trim() ||
  "http://localhost:8006";
const DEFAULT_JWT_SECRET =
  Bun.env.AUTOGPT_JWT_SECRET?.trim() ||
  Bun.env.JWT_SECRET?.trim() ||
  "your-super-secret-jwt-token-with-at-least-32-characters-long";
const DEFAULT_JWT_ALGORITHM =
  Bun.env.AUTOGPT_JWT_ALGORITHM?.trim() ||
  Bun.env.JWT_ALGORITHM?.trim() ||
  "HS256";

function resolveAuthMode(explicit?: AutogptAuthMode): AutogptAuthMode {
  const raw = (explicit ?? Bun.env.AUTOGPT_AUTH_MODE ?? "supabase")
    .trim()
    .toLowerCase();
  if (raw === "supabase" || raw === "better-auth") {
    return raw;
  }
  throw new Error(
    `Unknown AUTOGPT_AUTH_MODE "${raw}". Expected "supabase" or "better-auth".`,
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function defaultEmail(): string {
  return `agentprobe-${randomUUID().replaceAll("-", "").slice(0, 12)}@example.com`;
}

export function defaultUserId(): string {
  return randomUUID();
}

export function forgeJwt(options: {
  userId: string;
  email: string;
  jwtSecret: string;
  jwtAlgorithm: string;
  issuer: string;
  audience: string;
  role: string;
  name: string;
}): string {
  if (options.jwtAlgorithm !== "HS256") {
    throw new Error(`Unsupported JWT algorithm: ${options.jwtAlgorithm}`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: options.userId,
    email: options.email,
    role: options.role,
    aud: options.audience,
    iss: options.issuer,
    iat: nowSeconds,
    exp: nowSeconds + 2 * 60 * 60,
    user_metadata: { name: options.name },
  };
  const encodedHeader = base64UrlEncode(
    JSON.stringify({ alg: options.jwtAlgorithm, typ: "JWT" }),
  );
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", options.jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export async function registerUser(options: {
  backendUrl: string;
  token: string;
}): Promise<void> {
  const response = await fetch(
    `${options.backendUrl.replace(/\/$/, "")}/api/auth/user`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`AutoGPT user registration failed (${response.status}).`);
  }
}

/*
 * This function just alls an endpoint to enable subscription for the user
 * It needs to call a specific url, not the autogpt main one, and we only care
 * if it comes back successful or not
 */
export async function enableSubscription(options: {
  autogptAuthResult: AutogptAuthResult;
  backendUrl?: string;
  userId?: string;
}): Promise<void> {
  const backendUrl = options.backendUrl ?? DEFAULT_BACKEND_URL;
  const userId = options.userId ?? Bun.env.AUTOGPT_USER_ID ?? defaultUserId();
  const response = await fetch(
    `${backendUrl.replace(/\/$/, "")}/api/copilot/admin/rate_limit/tier`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.autogptAuthResult.token}`,
      },
      body: JSON.stringify({
        user_id: userId,
        tier: "ENTERPRISE",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`AutoGPT user registration failed (${response.status}).`);
  }
}

export type ResolveAuthOptions = {
  mode?: AutogptAuthMode;
  backendUrl?: string;
  jwtSecret?: string;
  jwtAlgorithm?: string;
  issuer?: string;
  audience?: string;
  role?: string;
  email?: string;
  userId?: string;
  name?: string;
  /** `better-auth` mode: base URL of the Better Auth (frontend) service. */
  frontendUrl?: string;
  /** `better-auth` mode: password for the benchmark account. */
  password?: string;
};

async function resolveSupabaseAuth(
  options: ResolveAuthOptions = {},
): Promise<AutogptAuthResult> {
  const backendUrl = options.backendUrl ?? DEFAULT_BACKEND_URL;
  const jwtSecret = options.jwtSecret ?? DEFAULT_JWT_SECRET;
  const jwtAlgorithm = options.jwtAlgorithm ?? DEFAULT_JWT_ALGORITHM;
  const issuer =
    options.issuer ?? Bun.env.AUTOGPT_JWT_ISSUER ?? "supabase-demo";
  const audience =
    options.audience ?? Bun.env.AUTOGPT_JWT_AUDIENCE ?? "authenticated";
  const role = options.role ?? Bun.env.AUTOGPT_JWT_ROLE ?? "admin";
  const email = options.email ?? Bun.env.AUTOGPT_EMAIL ?? defaultEmail();
  const userId = options.userId ?? Bun.env.AUTOGPT_USER_ID ?? defaultUserId();
  const name = options.name ?? Bun.env.AUTOGPT_USER_NAME ?? "AgentProbe User";

  const token = forgeJwt({
    userId,
    email,
    jwtSecret,
    jwtAlgorithm,
    issuer,
    audience,
    role,
    name,
  });

  await registerUser({ backendUrl, token });
  const autogptAuthResult = {
    token,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };

  await enableSubscription({
    autogptAuthResult,
    backendUrl,
    userId,
  });

  return autogptAuthResult;
}

/**
 * Resolve a bearer token for the AutoGPT backend, dispatching on
 * `AUTOGPT_AUTH_MODE` (default `supabase`). See {@link AutogptAuthMode}.
 */
export async function resolveAuth(
  options: ResolveAuthOptions = {},
): Promise<AutogptAuthResult> {
  const mode = resolveAuthMode(options.mode);
  if (mode === "better-auth") {
    // Dynamic import keeps the strategy module (which imports helpers from
    // here) out of an eager import cycle; it loads only when selected.
    const { resolveBetterAuthAuth } = await import("./better-auth-strategy.ts");
    return resolveBetterAuthAuth(options);
  }
  return resolveSupabaseAuth(options);
}
