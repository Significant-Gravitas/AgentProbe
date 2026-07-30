import type { AutogptAuthResult } from "../../shared/types/contracts.ts";
import {
  enableSubscription,
  type ResolveAuthOptions,
  registerUser,
} from "./autogpt-auth.ts";

/**
 * `better-auth` auth strategy: obtain a real ES256 token from Better Auth,
 * which the AutoGPT backend verifies via JWKS. Unlike the `supabase` mode,
 * nothing is forged — the token is minted by the platform for a real account.
 *
 * Better Auth is mounted on the **frontend** (Next.js), not the backend
 * AgentProbe benchmarks against, so this talks to `AUTOGPT_FRONTEND_URL` for
 * sign-in / token, then uses the resulting token against
 * `AUTOGPT_BACKEND_URL`.
 *
 * The flow is **sign-in first**. The benchmark account is expected to already
 * exist: GoTrue accounts were copied into Better Auth at the platform cutover
 * with their passwords intact. Sign-up runs only when `AUTOGPT_ALLOW_SIGNUP`
 * is set, because where signup is open an unconditional sign-up mints a brand
 * new account on every run — the `supabase` mode invented a throwaway identity
 * per run, and that habit must not carry over to real accounts.
 *
 * The ENTERPRISE tier grant hits an admin-only endpoint, so it is skipped
 * unless an admin bearer token is supplied via `AUTOGPT_ADMIN_TOKEN`. Without
 * it, runs use the account's own tier.
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
 * name, which gains a `__Secure-` prefix over HTTPS.
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
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Better Auth reports failures as `{ message, code }`. */
async function readError(
  response: Response,
): Promise<{ code?: string; detail: string }> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown };
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      detail: typeof parsed.message === "string" ? parsed.message : raw,
    };
  } catch {
    return { detail: raw };
  }
}

type SignInOutcome =
  | { ok: true; cookie: string }
  | { ok: false; status: number; code?: string; detail: string };

async function signIn(options: {
  frontendUrl: string;
  email: string;
  password: string;
}): Promise<SignInOutcome> {
  const response = await postJson(
    `${options.frontendUrl}/api/auth/sign-in/email`,
    { email: options.email, password: options.password },
  );
  if (!response.ok) {
    const { code, detail } = await readError(response);
    return { ok: false, status: response.status, code, detail };
  }
  const cookie = cookieHeaderFrom(response);
  if (!cookie) {
    throw new Error(
      "Better Auth sign-in succeeded but returned no session cookie.",
    );
  }
  return { ok: true, cookie };
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
  if (response.ok) {
    return;
  }
  const { code, detail } = await readError(response);
  // A pre-existing account is fine — the sign-in retry below decides. Any
  // other failure (weak password, closed signup) is fatal and actionable.
  if (code === "USER_ALREADY_EXISTS") {
    return;
  }
  throw new Error(
    `Better Auth sign-up failed (${response.status}) for ${options.email}: ` +
      `${detail}. Provision the benchmark account out-of-band and leave ` +
      "AUTOGPT_ALLOW_SIGNUP unset if this environment gates signup.",
  );
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
    const { detail } = await readError(response);
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

function allowSignupFromEnv(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = Bun.env.AUTOGPT_ALLOW_SIGNUP?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
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
  const email = options.email ?? Bun.env.AUTOGPT_EMAIL?.trim();
  const password = options.password ?? Bun.env.AUTOGPT_PASSWORD;
  const name = options.name ?? Bun.env.AUTOGPT_USER_NAME ?? "AgentProbe User";

  // Deliberately no random-email fallback: `supabase` mode could invent an
  // identity because the token was forged, but a real login needs a stable,
  // pre-provisioned account.
  if (!email) {
    throw new Error(
      'AUTOGPT_AUTH_MODE="better-auth" requires a stable benchmark account: ' +
        "set AUTOGPT_EMAIL (or pass options.email).",
    );
  }
  if (!password) {
    throw new Error(
      'AUTOGPT_AUTH_MODE="better-auth" requires a password: set ' +
        "AUTOGPT_PASSWORD (or pass options.password).",
    );
  }

  let attempt = await signIn({ frontendUrl, email, password });
  if (!attempt.ok) {
    const unknownAccount = attempt.code === "INVALID_EMAIL_OR_PASSWORD";
    if (!(unknownAccount && allowSignupFromEnv(options.allowSignup))) {
      throw new Error(
        `Better Auth sign-in failed (${attempt.status}) for ${email}: ` +
          `${attempt.detail}. The benchmark account must exist in Better Auth ` +
          "— GoTrue accounts migrated at the platform cutover keep their " +
          "passwords, but an account seeded directly into GoTrue afterwards " +
          "will not exist there. Set AUTOGPT_ALLOW_SIGNUP=true to provision " +
          "it where signup is open.",
      );
    }
    await signUp({ frontendUrl, email, password, name });
    attempt = await signIn({ frontendUrl, email, password });
    if (!attempt.ok) {
      throw new Error(
        `Better Auth sign-in failed after sign-up (${attempt.status}) for ` +
          `${email}: ${attempt.detail}.`,
      );
    }
  }

  const token = await mintToken({ frontendUrl, cookie: attempt.cookie });

  const result: AutogptAuthResult = {
    token,
    headers: { Authorization: `Bearer ${token}` },
  };

  await registerUser({ backendUrl, token });

  // The tier grant is admin-only; the benchmark account is not an admin.
  // Apply it only with an explicit admin token, otherwise leave the account
  // at its own tier.
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
