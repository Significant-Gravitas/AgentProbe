import type { AutogptAuthResult } from "../../shared/types/contracts.ts";
import {
  defaultEmail,
  enableSubscription,
  type ResolveAuthOptions,
  registerUser,
} from "./autogpt-auth.ts";

/**
 * `better-auth` auth strategy: obtain a real ES256 token from the Better Auth
 * service, which the AutoGPT backend verifies via JWKS. Unlike the `supabase`
 * mode, nothing is forged — the token is minted by the platform for a real
 * account.
 *
 * Better Auth runs in the **frontend** (Next.js), not the backend AgentProbe
 * benchmarks against, so this talks to a separate `AUTOGPT_FRONTEND_URL`
 * (default http://localhost:3000) for sign-up / sign-in / token, then uses the
 * resulting token against `AUTOGPT_BACKEND_URL`.
 *
 * Prerequisites (tracked with the platform auth migration, hence the draft):
 *   - The benchmark account's email must pass the platform signup gate
 *     (`AUTH_SIGNUP_ALLOWLIST`) on non-local backends — random
 *     `agentprobe-*@example.com` emails are rejected on dev/preview.
 *   - The ENTERPRISE tier grant hits an admin-only endpoint. A freshly signed
 *     up user is NOT an admin, so the grant is skipped unless an admin bearer
 *     token is supplied via `AUTOGPT_ADMIN_TOKEN`. Grant the benchmark user
 *     admin out-of-band, or provide that token, to lift rate limits.
 */

const DEFAULT_FRONTEND_URL =
  Bun.env.AUTOGPT_FRONTEND_URL?.trim() ||
  Bun.env.FRONTEND_URL?.trim() ||
  "http://localhost:3000";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Rebuild a `Cookie` request header from the `Set-Cookie` responses Better
 * Auth issues on sign-in. Bun's fetch does not persist cookies across calls,
 * so the session cookie must be forwarded to the token endpoint by hand. All
 * cookies are forwarded (name=value) rather than guessing the session cookie
 * name, which varies by `Secure` prefix.
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  const pairs = setCookies
    .map((raw) => raw.split(";", 1)[0]?.trim())
    .filter((pair): pair is string => Boolean(pair));
  return pairs.join("; ");
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signUp(options: {
  frontendUrl: string;
  email: string;
  password: string;
  name: string;
}): Promise<void> {
  const response = await postJson(
    `${options.frontendUrl}/api/auth/sign-up/email`,
    {
      email: options.email,
      password: options.password,
      name: options.name,
    },
  );
  // An already-registered account is expected on re-runs; only a hard failure
  // (gate rejection, 5xx) should abort. Better Auth returns 422/400 for a
  // duplicate email.
  if (response.ok || response.status === 422 || response.status === 400) {
    return;
  }
  const detail = await response.text().catch(() => "");
  throw new Error(
    `Better Auth sign-up failed (${response.status}) for ${options.email}. ` +
      "On dev/preview the email must be in AUTH_SIGNUP_ALLOWLIST." +
      (detail ? ` Response: ${detail.slice(0, 200)}` : ""),
  );
}

async function signIn(options: {
  frontendUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const response = await postJson(
    `${options.frontendUrl}/api/auth/sign-in/email`,
    {
      email: options.email,
      password: options.password,
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Better Auth sign-in failed (${response.status}) for ${options.email}.` +
        (detail ? ` Response: ${detail.slice(0, 200)}` : ""),
    );
  }
  const cookie = cookieHeaderFrom(response);
  if (!cookie) {
    throw new Error("Better Auth sign-in returned no session cookie.");
  }
  return cookie;
}

async function mintToken(options: {
  frontendUrl: string;
  cookie: string;
}): Promise<string> {
  const response = await fetch(`${options.frontendUrl}/api/auth/token`, {
    method: "GET",
    headers: { Cookie: options.cookie },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Better Auth token mint failed (${response.status}).` +
        (detail ? ` Response: ${detail.slice(0, 200)}` : ""),
    );
  }
  const payload = (await response.json()) as { token?: unknown };
  if (typeof payload.token !== "string" || !payload.token) {
    throw new Error("Better Auth token response did not include a token.");
  }
  return payload.token;
}

export async function resolveBetterAuthAuth(
  options: ResolveAuthOptions = {},
): Promise<AutogptAuthResult> {
  const frontendUrl = stripTrailingSlash(
    options.frontendUrl ?? DEFAULT_FRONTEND_URL,
  );
  const backendUrl =
    options.backendUrl ??
    Bun.env.AUTOGPT_BACKEND_URL?.trim() ??
    "http://localhost:8006";
  const email = options.email ?? Bun.env.AUTOGPT_EMAIL ?? defaultEmail();
  const password = options.password ?? Bun.env.AUTOGPT_PASSWORD;
  const name = options.name ?? Bun.env.AUTOGPT_USER_NAME ?? "AgentProbe User";
  if (!password) {
    throw new Error(
      'AUTOGPT_AUTH_MODE="better-auth" requires a password: set ' +
        "AUTOGPT_PASSWORD (or pass options.password).",
    );
  }

  await signUp({ frontendUrl, email, password, name });
  const cookie = await signIn({ frontendUrl, email, password });
  const token = await mintToken({ frontendUrl, cookie });

  const result: AutogptAuthResult = {
    token,
    headers: { Authorization: `Bearer ${token}` },
  };

  await registerUser({ backendUrl, token });

  // The tier grant is admin-only; a real signed-up user is not an admin.
  // Apply it only with an explicit admin token, otherwise leave the account
  // at its default tier (see the prerequisites note above).
  const adminToken = Bun.env.AUTOGPT_ADMIN_TOKEN?.trim();
  if (adminToken) {
    await enableSubscription({
      autogptAuthResult: { token: adminToken, headers: {} },
      backendUrl,
      userId: options.userId,
    });
  }

  return result;
}
