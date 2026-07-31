import { createHash, createHmac } from "node:crypto";

import type { AutogptAuthResult } from "../../shared/types/contracts.ts";
import { logWarn } from "../../shared/utils/logging.ts";
import {
  enableSubscription,
  type ResolveAuthOptions,
  registerUser,
} from "./autogpt-auth.ts";

/**
 * AgentProbe's auth strategy: obtain a real ES256 token from Better Auth,
 * which the AutoGPT backend verifies via JWKS. Nothing is forged — the token
 * is minted by the platform for a real account. (The legacy path forged an
 * HS256 GoTrue token locally; it was removed with the platform cutover.)
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
 * new account on every run — the removed forge path invented a throwaway
 * identity per run, and that habit must not carry over to real accounts.
 *
 * The ENTERPRISE tier grant hits an admin-only endpoint. It runs with the
 * account's own token when that token carries `role: "admin"` (the platform
 * decides admin from the claim alone, and Better Auth stamps it from the
 * account's `role` column — so an admin benchmark account needs no second
 * credential), or with an explicit `AUTOGPT_ADMIN_TOKEN`. Otherwise it is
 * skipped and runs use the account's own tier.
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

/**
 * The minted JWT carries the account's identity (`sub`) and `role`. Decoded
 * without verification — the backend verifies; this only needs the claims to
 * target the tier grant at the right user and to detect an admin account.
 */
function tokenClaims(token: string): { sub?: string; role?: string } {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: unknown; role?: unknown };
    return {
      sub: typeof parsed.sub === "string" ? parsed.sub : undefined,
      role: typeof parsed.role === "string" ? parsed.role : undefined,
    };
  } catch {
    return {};
  }
}

function allowSignupFromEnv(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = Bun.env.AUTOGPT_ALLOW_SIGNUP?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Derive an isolated sub-account from the base benchmark credentials and a
 * pinned identity seed. Real logins cannot invent a user per run the way the
 * removed forge did, but memory evaluations still need one identity per
 * scenario iteration — so the runner's pinned id becomes a plus-addressed
 * variant of the base account (`bench+a1b2…@agpt.co`) with a password derived
 * via HMAC from the base password. One credential pair in the environment,
 * any number of isolated accounts; each is provisioned through the normal
 * sign-up flow on first use.
 */
export function deriveIsolatedAccount(options: {
  email: string;
  password: string;
  identitySeed: string;
}): { email: string; password: string } {
  const sanitized = options.identitySeed
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "")
    .slice(0, 16);
  const seed =
    sanitized ||
    createHash("sha256")
      .update(options.identitySeed)
      .digest("hex")
      .slice(0, 16);
  const at = options.email.lastIndexOf("@");
  const email = `${options.email.slice(0, at)}+${seed}@${options.email.slice(at + 1)}`;
  const password = createHmac("sha256", options.password)
    .update(email)
    .digest("hex");
  return { email, password };
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

  // Deliberately no random-email fallback: the removed forge path could
  // invent an identity because the token was forged, but a real login needs
  // a stable, pre-provisioned account.
  if (!email) {
    throw new Error(
      "AutoGPT auth requires a stable benchmark account: " +
        "set AUTOGPT_EMAIL (or pass options.email).",
    );
  }
  if (!password) {
    throw new Error(
      "AutoGPT auth requires a password: set " +
        "AUTOGPT_PASSWORD (or pass options.password).",
    );
  }

  // The runner pins an identity per scenario iteration for memory isolation.
  // With signup available, that identity becomes a derived sub-account;
  // without it, every iteration shares the base account and isolation is
  // gone — worth a loud warning, not an error, since not every run cares.
  const allowSignup = allowSignupFromEnv(options.allowSignup);
  let account = { email, password };
  if (options.userId) {
    if (allowSignup) {
      account = deriveIsolatedAccount({
        email,
        password,
        identitySeed: options.userId,
      });
    } else {
      logWarn(
        "AutoGPT auth: an isolated identity was requested but " +
          "AUTOGPT_ALLOW_SIGNUP is off; all iterations share the base " +
          "benchmark account, so memory is NOT isolated between them.",
      );
    }
  }

  let attempt = await signIn({ frontendUrl, ...account });
  if (!attempt.ok) {
    const unknownAccount = attempt.code === "INVALID_EMAIL_OR_PASSWORD";
    if (!(unknownAccount && allowSignup)) {
      throw new Error(
        `Better Auth sign-in failed (${attempt.status}) for ${account.email}: ` +
          `${attempt.detail}. The benchmark account must exist in Better Auth ` +
          "— GoTrue accounts migrated at the platform cutover keep their " +
          "passwords, but an account seeded directly into GoTrue afterwards " +
          "will not exist there. Set AUTOGPT_ALLOW_SIGNUP=true to provision " +
          "it where signup is open.",
      );
    }
    await signUp({ frontendUrl, ...account, name });
    attempt = await signIn({ frontendUrl, ...account });
    if (!attempt.ok) {
      throw new Error(
        `Better Auth sign-in failed after sign-up (${attempt.status}) for ` +
          `${account.email}: ${attempt.detail}.`,
      );
    }
  }

  const token = await mintToken({ frontendUrl, cookie: attempt.cookie });

  const result: AutogptAuthResult = {
    token,
    headers: { Authorization: `Bearer ${token}` },
  };

  await registerUser({ backendUrl, token });

  // The tier grant is admin-only. An admin benchmark account authorizes it
  // with its own token; otherwise an explicit AUTOGPT_ADMIN_TOKEN can. With
  // neither, the account keeps its own tier. It targets the minted token's
  // own subject — the runner's pinned id is a probe-side seed, not a real
  // platform user id — unless AUTOGPT_USER_ID explicitly overrides.
  const claims = tokenClaims(token);
  const adminToken = Bun.env.AUTOGPT_ADMIN_TOKEN?.trim();
  const grantToken =
    adminToken || (claims.role === "admin" ? token : undefined);
  if (grantToken) {
    const userId = Bun.env.AUTOGPT_USER_ID?.trim() || claims.sub;
    if (!userId) {
      throw new Error(
        "Cannot apply the rate-limit tier: the minted token has no `sub` " +
          "claim and no AUTOGPT_USER_ID is set.",
      );
    }
    await enableSubscription({
      autogptAuthResult: { token: grantToken, headers: {} },
      backendUrl,
      userId,
    });
  }

  return result;
}
