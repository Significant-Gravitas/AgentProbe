# AutoGPT Auth Playbook

## Trigger

Use this playbook when pointing AgentProbe at an AutoGPT platform environment
or debugging platform auth failures.

## How auth works

AgentProbe signs a **real account** in to Better Auth, which is mounted on
the platform **frontend** (not the backend AgentProbe benchmarks against),
then mints an ES256 token the backend verifies via JWKS. The account is
auto-provisioned on first use where signup is open (see below).

The legacy path — forging an HS256 token with the shared GoTrue secret — was
removed when the platform dropped Supabase/GoTrue. AgentProbe therefore
requires the target environment to be on Better Auth; there is no fallback. A
leftover `AUTOGPT_AUTH_MODE=supabase` in the environment fails loudly instead
of silently authenticating some other way.

```bash
export AUTOGPT_FRONTEND_URL="https://dev-builder.agpt.co"
export AUTOGPT_BACKEND_URL="https://dev-server.agpt.co"
export AUTOGPT_EMAIL="<benchmark account email>"
export AUTOGPT_PASSWORD="<benchmark account password>"
```

The flow is sign-in → `GET /api/auth/token` → `POST /api/auth/user`. Verify
the environment is on Better Auth before pointing a probe at it:

```bash
curl -fsS "$AUTOGPT_FRONTEND_URL/api/auth/jwks"   # 200 + an ES256 key
```

## Accounts auto-provision by default

Auth has no random-email fallback — `AUTOGPT_EMAIL` names the one benchmark
identity — but the account itself does not need to exist up front: sign-in
runs first, and when it reports an unknown account AgentProbe signs it up
automatically where signup is open. Existing accounts (including GoTrue
accounts copied into Better Auth at the cutover with their passwords intact)
are never re-registered.

`AUTOGPT_ALLOW_SIGNUP=false` disables auto-provisioning and turns a missing
account into a hard error. Set it against gated-signup environments (the
sign-up would fail anyway; the error is cleaner) or anywhere account creation
must not happen. Note the trade-off: with provisioning on, a typo'd email or
password mints a fresh account instead of failing — if a run unexpectedly
"works" with a brand-new empty account, check the credentials.

An account created **after** the cutover by writing to GoTrue / `auth.users`
directly will not exist in Better Auth; with provisioning on you get a new
Better Auth account under the same email rather than the GoTrue one.

## Isolated identities: derived sub-accounts

The runner pins a fresh user identity per scenario iteration so memory
evaluations stay isolated. Real logins cannot forge those identities, so each
pinned identity becomes a **derived sub-account** of the base benchmark
account (on by default, like all provisioning):

- email: plus-addressed from the base email — `bench+<seed>@agpt.co`, where
  the seed comes from the pinned id
- password: HMAC-SHA256 of the derived email, keyed with the base password

One credential pair in the environment, any number of isolated accounts; each
is provisioned through the normal sign-up flow on first use. Expect benchmark
runs to accumulate `+`-suffixed accounts in the target environment — that is
by design (one identity per iteration is the isolation mechanism), but it
means probes should only point at environments that tolerate benchmark
accounts (dev/local); set `AUTOGPT_ALLOW_SIGNUP=false` anywhere they are not
welcome.

With `AUTOGPT_ALLOW_SIGNUP=false`, every iteration signs in as the base
account: runs work, but memory is **not** isolated between iterations and the
CLI logs a warning. Memory suites need derived accounts to be meaningful.

## Rate-limit tier

The ENTERPRISE tier grant hits an admin-only endpoint. It targets the user id
in the minted token's `sub` claim (`AUTOGPT_USER_ID` overrides) and runs when
either:

- the minted token itself carries `role: "admin"` — the platform decides admin
  from that claim alone, and Better Auth stamps it at mint time from the
  account's own `role` column, so marking the benchmark account admin once
  makes the grant work with no second credential to distribute or rotate
  (preferred); or
- `AUTOGPT_ADMIN_TOKEN` supplies a separate admin bearer token.

With neither, the grant is skipped and runs use the account's own tier. Note
that derived sub-accounts are plain users: they self-grant only if the
platform marks them admin, so lifting rate limits for derived accounts needs
`AUTOGPT_ADMIN_TOKEN` (or tolerating the default tier).

## Token expiry

A Better Auth token lasts about an hour — shorter than a long benchmark. The
HTTP adapter re-resolves auth once on a 401 and retries with a fresh token, so
mid-run expiry is not a run failure. A 401 that survives re-authentication
surfaces unchanged.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `sign-in failed (401) … INVALID_EMAIL_OR_PASSWORD` | Wrong password for an existing account, or `AUTOGPT_ALLOW_SIGNUP=false` with a missing one |
| `sign-up failed (403)` | Signup is gated on that environment; provision the account out-of-band and set `AUTOGPT_ALLOW_SIGNUP=false` |
| `requires a stable benchmark account` | `AUTOGPT_EMAIL` is unset — auth will not invent one |
| `AUTOGPT_AUTH_MODE="supabase" is no longer supported` | Stale env var from before the forge removal; unset it and configure the Better Auth credentials |
| `memory is NOT isolated` warning | `AUTOGPT_ALLOW_SIGNUP=false` blocks derived sub-accounts; remove the override where benchmark accounts are tolerated |
| A run "works" against a fresh, empty account | Typo'd `AUTOGPT_EMAIL`/`AUTOGPT_PASSWORD` auto-provisioned a new account; fix the credentials |
