# Agent Harness Contract

## Commands agents must run

| When                       | Command                    |
|----------------------------|----------------------------|
| Before every PR            | `bun run fast-feedback`    |
| To validate repo truth     | `bun run docs:validate`    |
| To refresh docs indexes    | `bun run docs:index`       |
| To refresh workspace docs  | `bun run docs:workspace`   |
| To refresh quality score   | `bun run docs:quality`     |

## Test timeouts

`bun run test` and `bun run test:e2e` set `--timeout 30000` (30s per test). The
e2e suite spawns the CLI subprocess per case, which routinely takes 1–4s on a
warm box and can exceed Bun's 5s default under coverage instrumentation or a
loaded CI worker. Subprocess teardown still surfaces normally — a hung child
will fail the test at the 30s mark rather than the 5s default, but it will
still fail. Do not raise this further without a justification recorded here.

## PR requirements

Every PR must:
- [ ] Pass `fast-feedback.sh`
- [ ] Include a filled-out PR template
- [ ] Update `docs/product-specs/platform.md` first if behavior changed
- [ ] Leave behind enough logs, metrics, tests, or screenshots for the next
      agent to audit the change without reconstructing hidden context

## Automerge eligibility

### Stage 1 (current)
- Green CI
- One independent agent review
- **Human merge required**

### Stage 2 (when repo is stable)
Automerge allowed for: docs, tests, non-auth code.

### Stage 3 (when test loop is proven)
Wider automerge with human override.

## Always human-reviewed

These paths never automerge:
- `**/auth/**`
- `**/.env*`, `**/credentials*`, `**/secrets*`
- `.github/**`
- `AGENTS.md`
- `docs/HARNESS.md`
- `docs/SECURITY.md`

## Failure escalation

1. If `fast-feedback.sh` fails: fix before merging. No exceptions.
2. If nightly baseline breaks: an auto-PR is opened. Fix forward.
3. If generated docs are stale: refresh and commit.
4. If a change affects latency or observability-critical paths, attach evidence
   that the documented budgets in `docs/RELIABILITY.md` still hold.
