import type { AutogptAuthResult } from "../../shared/types/contracts.ts";

/**
 * How AgentProbe obtains a bearer token the AutoGPT backend will accept:
 * sign a real account in to Better Auth (mounted on the platform frontend)
 * and mint an ES256 token the backend verifies via JWKS.
 *
 * The legacy `supabase` forge — an HS256 JWT signed locally with the shared
 * GoTrue secret — was removed when the platform dropped GoTrue. A leftover
 * `AUTOGPT_AUTH_MODE=supabase` in the environment fails loudly rather than
 * silently authenticating some other way.
 */

const DEFAULT_BACKEND_URL =
  Bun.env.AUTOGPT_BACKEND_URL?.trim() ||
  Bun.env.BACKEND_URL?.trim() ||
  "http://localhost:8006";

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
 * This function just calls an endpoint to enable subscription for the user
 * It needs to call a specific url, not the autogpt main one, and we only care
 * if it comes back successful or not
 */
export async function enableSubscription(options: {
  autogptAuthResult: AutogptAuthResult;
  backendUrl?: string;
  userId: string;
}): Promise<void> {
  const backendUrl = options.backendUrl ?? DEFAULT_BACKEND_URL;
  const response = await fetch(
    `${backendUrl.replace(/\/$/, "")}/api/copilot/admin/rate_limit/tier`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.autogptAuthResult.token}`,
      },
      body: JSON.stringify({
        user_id: options.userId,
        tier: "ENTERPRISE",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `AutoGPT rate-limit tier grant failed (${response.status}).`,
    );
  }
}

export type ResolveAuthOptions = {
  backendUrl?: string;
  /** Base URL of the Better Auth (frontend) service. */
  frontendUrl?: string;
  email?: string;
  /** Password for the benchmark account. */
  password?: string;
  userId?: string;
  name?: string;
  /**
   * Provision the account via sign-up when it does not exist. On by default
   * (sign-in always runs first, so existing accounts are never
   * re-registered); `AUTOGPT_ALLOW_SIGNUP=false` makes a missing account a
   * hard error instead.
   */
  allowSignup?: boolean;
};

/**
 * Resolve a bearer token for the AutoGPT backend via Better Auth. Fails
 * loudly when the environment still asks for the removed `supabase` forge.
 */
export async function resolveAuth(
  options: ResolveAuthOptions = {},
): Promise<AutogptAuthResult> {
  const mode = Bun.env.AUTOGPT_AUTH_MODE?.trim().toLowerCase();
  if (mode && mode !== "better-auth") {
    throw new Error(
      `AUTOGPT_AUTH_MODE="${mode}" is no longer supported: the forged ` +
        "Supabase/GoTrue path was removed with the platform's Better Auth " +
        "cutover. Unset AUTOGPT_AUTH_MODE and configure AUTOGPT_FRONTEND_URL, " +
        "AUTOGPT_EMAIL, and AUTOGPT_PASSWORD instead.",
    );
  }
  // Dynamic import keeps the strategy module (which imports helpers from
  // here) out of an eager import cycle.
  const { resolveBetterAuthAuth } = await import("./better-auth-strategy.ts");
  return resolveBetterAuthAuth(options);
}
