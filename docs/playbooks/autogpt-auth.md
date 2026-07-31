# AutoGPT Auth Playbook

## Trigger

Use this playbook when pointing AgentProbe at an AutoGPT platform environment
and deciding which `AUTOGPT_AUTH_MODE` that environment needs.

## Which mode does an environment need?

The AutoGPT platform is mid-migration from Supabase GoTrue to Better Auth, so
the mode is a property of the target environment, not of AgentProbe.

| Target | Mode | Why |
| --- | --- | --- |
| Production (`platform.agpt.co`) | `supabase` (default) | Still on GoTrue; the backend still accepts the shared-secret HS256 token |
| Dev (`dev-builder.agpt.co`) | `better-auth` | Cut over to Better Auth; GoTrue endpoints (`/auth/v1/*`) return 404 |
| Local stack | either | Matches whichever the local platform checkout runs |

Set the mode per environment. Leaving it unset keeps the production path
working unchanged.

## `supabase` mode (default)

Forges an HS256 token with the shared secret and registers the invented user.
No account has to exist beforehand.

```bash
export AUTOGPT_BACKEND_URL="https://api.platform.agpt.co"
export AUTOGPT_JWT_SECRET="<shared JWT_VERIFY_KEY>"
```

## `better-auth` mode

Signs a **real, pre-provisioned account** in against Better Auth, which is
mounted on the platform **frontend** (not the backend AgentProbe benchmarks
against), then mints an ES256 token the backend verifies via JWKS.

```bash
export AUTOGPT_AUTH_MODE="better-auth"
export AUTOGPT_FRONTEND_URL="https://dev-builder.agpt.co"
export AUTOGPT_BACKEND_URL="https://dev-server.agpt.co"
export AUTOGPT_EMAIL="<benchmark account email>"
export AUTOGPT_PASSWORD="<benchmark account password>"
```

The flow is sign-in → `GET /api/auth/token` → `POST /api/auth/user`. Verify the
environment is on Better Auth before switching:

```bash
curl -fsS "$AUTOGPT_FRONTEND_URL/api/auth/jwks"   # 200 + an ES256 key
curl -s -o /dev/null -w '%{http_code}\n' "$AUTOGPT_FRONTEND_URL/auth/v1/token"  # 404 once GoTrue is gone
```

### The benchmark account must already exist

`better-auth` mode has no random-email fallback. `supabase` mode could invent an
identity per run because the token was forged; a real login cannot.

GoTrue accounts were copied into Better Auth at the platform cutover and keep
their passwords, so a pre-cutover account signs in as-is. An account created
**after** the cutover by writing to GoTrue / `auth.users` directly will not
exist in Better Auth and will fail with `INVALID_EMAIL_OR_PASSWORD`.

Where signup is open, `AUTOGPT_ALLOW_SIGNUP=true` lets AgentProbe provision the
account on first use. It is off by default on purpose: an unconditional sign-up
would mint a new real account on every run.

### Rate-limit tier

The ENTERPRISE tier grant hits an admin-only endpoint. It targets the user id
in the minted token's `sub` claim (`AUTOGPT_USER_ID` overrides) and runs when
either:

- the minted token itself carries `role: "admin"` — the platform decides admin
  from that claim alone, and Better Auth stamps it at mint time from the
  account's own `role` column, so marking the benchmark account admin once
  makes the grant work with no second credential to distribute or rotate
  (preferred); or
- `AUTOGPT_ADMIN_TOKEN` supplies a separate admin bearer token.

With neither, the grant is skipped and runs use the account's own tier.

## Token expiry

A Better Auth token lasts about an hour — shorter than a long benchmark. The
HTTP adapter re-resolves auth once on a 401 and retries with a fresh token, so
mid-run expiry is not a run failure. A 401 that survives re-authentication
surfaces unchanged.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `sign-in failed (401) … INVALID_EMAIL_OR_PASSWORD` | Account absent from Better Auth, or wrong password. Check it existed before the cutover |
| `sign-up failed (403)` | Signup is gated on that environment; provision the account out-of-band and unset `AUTOGPT_ALLOW_SIGNUP` |
| `requires a stable benchmark account` | `AUTOGPT_EMAIL` is unset — `better-auth` mode will not invent one |
| 401s on every backend call in `supabase` mode | The environment dropped the legacy HS256 secret; switch to `better-auth` |
