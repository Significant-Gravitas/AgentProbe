# E2E Test Checklist

Derived from `platform.md`. Every scenario should have a coverage owner.

| Scenario | Test file | Status |
| --- | --- | --- |
| YAML validation succeeds for well-formed data | `tests/e2e/cli.e2e.test.ts` | ✅ covered |
| Evaluation run records ordered results and artifacts | `tests/e2e/cli.e2e.test.ts` | ✅ covered |
| AutoGPT preset forges auth tokens internally | `tests/unit/autogpt-auth.test.ts` | ✅ covered |
| Fast feedback enforces the repo quality gates | `scripts/fast-feedback.sh` | ✅ covered |
| HTML report renders from recorded run history | `tests/e2e/cli.e2e.test.ts` | ✅ covered |
| Reliability signals exist for critical command paths | `docs/RELIABILITY.md` + future performance checks | ⏳ planned |
