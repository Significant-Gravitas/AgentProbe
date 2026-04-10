import { createHmac, randomUUID } from "node:crypto";

import type { AutogptAuthResult } from "../../shared/types/contracts.ts";

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

export async function resolveAuth(options: {
  backendUrl?: string;
  jwtSecret?: string;
  jwtAlgorithm?: string;
  issuer?: string;
  audience?: string;
  role?: string;
  email?: string;
  userId?: string;
  name?: string;
} = {}): Promise<AutogptAuthResult> {
  const backendUrl = options.backendUrl ?? DEFAULT_BACKEND_URL;
  const jwtSecret = options.jwtSecret ?? DEFAULT_JWT_SECRET;
  const jwtAlgorithm = options.jwtAlgorithm ?? DEFAULT_JWT_ALGORITHM;
  const issuer = options.issuer ?? Bun.env.AUTOGPT_JWT_ISSUER ?? "supabase-demo";
  const audience =
    options.audience ?? Bun.env.AUTOGPT_JWT_AUDIENCE ?? "authenticated";
  const role = options.role ?? Bun.env.AUTOGPT_JWT_ROLE ?? "user";
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
  return {
    token,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}
