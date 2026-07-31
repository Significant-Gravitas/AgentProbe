# Current State

Last validated against `platform.md`: 2026-05-15

## Implemented scenarios

- [x] YAML validation succeeds for well-formed data
- [x] Evaluation run records ordered results and artifacts
- [x] Scenario filters narrow execution to matching scenarios
- [x] List command shows available scenarios
- [x] Dry-run mode records intent without contacting external systems
- [x] Judge requests preserve cache-friendly prompt prefixes
- [x] Persona simulation uses a configurable default model with hidden reasoning
- [x] Parallel mode overlaps scenario execution while preserving ordering
- [ ] Multi-session memory scenarios preserve pinned identity and session controls
- [x] AutoGPT preset resolves auth internally via Better Auth
- [x] Pinned identities become derived Better Auth sub-accounts
- [x] Expired AutoGPT tokens are refreshed mid-run
- [ ] Repeat mode reruns scenarios with isolated users per iteration
- [x] OpenClaw CLI commands manage sessions, chat, and history
- [x] Fast feedback enforces the repo quality gates
- [ ] HTML report renders from recorded run history
- [ ] Dashboard mode serves live run state from a Bun HTTP server
- [ ] Reliability signals exist for critical command paths

### Server control plane (Phase 1-4)

- [x] Default start-server boot binds loopback with read-only history browsing
- [x] Non-loopback exposure requires unsafe flag only
- [x] Read-only HTTP and UI surfaces browse persisted run history
- [x] Live run events stream through Server-Sent Events with replay support
- [x] Run executor failures are logged and persisted
- [x] Run control starts validated ad-hoc or preset-backed runs
- [x] Cancellation cooperatively stops a server-managed run
- [x] Presets save cross-file scenario selections for one-click rerun
- [ ] Comparison workspace diffs 2 to 10 historical runs
- [x] Docker image boots safely with durable persistence
- [x] Database URL credentials stay redacted in operator-visible output
- [x] Docker Compose readiness waits for server readiness
- [x] Human scoring drains an unscored backlog one chat at a time
- [x] Ranking-scored scenarios grade retrieval relevance against a curated golden set
- [x] Dream-system scenarios validate demotion, procedure, and dedup behavior

## Notes

- The Bun-owned end-to-end baseline now covers validation, run/report flows,
  filtering, dry-run, parallel execution, and the OpenClaw CLI path.
- AutoGPT auth is Better Auth only: a pre-provisioned benchmark account signs
  in against the platform frontend and mints a real ES256 token the backend
  verifies via JWKS. The legacy forged-HS256 GoTrue path was removed; a
  leftover `AUTOGPT_AUTH_MODE=supabase` fails loudly. Accounts (the benchmark
  account and the derived plus-addressed per-iteration sub-accounts used for
  memory isolation) auto-provision by default via sign-in-first sign-up;
  `AUTOGPT_ALLOW_SIGNUP=false` makes a missing account a hard error and drops
  iterations onto the shared base account with a not-isolated warning.
- Internally-resolved AutoGPT tokens are refreshed once on a 401, so a token
  expiring mid-run does not fail the run.
- The copied `data/` and `dashboard/` assets have landed ahead of the runtime
  parity work, so the remaining gap is the Bun runtime, persistence, and
  reporting support that makes those assets executable.
- Run filtering rejects empty selections before any target or judge traffic,
  and persisted run metadata records the selected scenario IDs.
- Dry-run intentionally records run-level selection metadata without creating
  scenario-run rows or contacting target systems.
- Judge-model requests now preserve a stable rubric-first prefix, add a stable
  prompt cache key, and enable supported provider caching on the OpenRouter
  Responses path.
- Persona simulator requests default to `deepseek/deepseek-v4-flash` unless a
  persona-level `model` or `AGENTPROBE_PERSONA_MODEL` override is present, and
  they use medium reasoning effort while excluding reasoning from responses,
  low-temperature decoding, bounded output, and a retry guard for degenerate
  token-soup messages.
- The OpenClaw CLI surface is implemented behind websocket endpoint presets and
  can create sessions, send chat turns, and read session history.
- `bun run fast-feedback` now refreshes generated docs and quality score before
  enforcing repo validation, Biome linting, strict TypeScript checks, and Bun
  tests.
- `agentprobe start-server` now supports token-protected write routes for
  ad-hoc dry-runs, cooperative cancellation, preset CRUD, preset launch, SSE
  replay, and Docker packaging with SQLite-on-volume persistence.
- Database URL userinfo passwords are redacted before reaching logs, health
  payloads, migration output, or configuration errors.
- The packaged Compose service uses `/readyz` for its healthcheck so downstream
  dependencies can wait on server readiness rather than only process start.
- Reliability and latency-budget enforcement are now documented as required, but
  the repo has not fully promoted them into executable checks yet.
- The repository contract is Bun-first even while some baseline implementation
  paths are still migrating.
