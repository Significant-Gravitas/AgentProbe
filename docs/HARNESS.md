# Agent Harness Contract

## Commands agents must run

| When                          | Command                      |
|-------------------------------|------------------------------|
| Before every PR               | `./scripts/fast-feedback.sh` |
| To validate repo structure    | `./scripts/validate-repo.sh` |

## PR requirements

Every PR must:
- [ ] Pass `fast-feedback.sh`
- [ ] Include a filled-out PR template
- [ ] Update `docs/behaviours/platform.md` if behavior changed

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
- `src/agentprobe/endpoints/autogpt_auth.py`

## Failure escalation

1. If `fast-feedback.sh` fails: fix before merging. No exceptions.
2. If nightly baseline breaks: an auto-PR is opened. Fix forward.
3. If generated docs are stale: refresh and commit.
