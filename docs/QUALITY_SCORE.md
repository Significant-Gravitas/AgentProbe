# Quality Score

Last updated: 2026-04-10

## Health summary

| Area              | Status | Notes                     |
|-------------------|--------|---------------------------|
| CI                | 🟢     | pytest + pyright + ruff   |
| Test coverage     | 🟢     | Python unit tests + Bun e2e baseline |
| Doc freshness     | 🟢     | Generated docs up to date |
| Baseline debt     | 🟢     | No baselined violations   |

## Incidents

_No incidents yet._

## Next cleanup targets

1. Extend the Bun baseline to the OpenClaw helper commands if they become part of the migration contract
2. Keep the Bun subprocess baseline green while the TypeScript rewrite replaces the Python implementation
3. Fill out remaining behavior scenarios in platform.md
