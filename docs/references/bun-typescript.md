# Bun + TypeScript Reference

## Canonical toolchain

- Bun is the primary repo workflow entrypoint.
- TypeScript is the canonical implementation language.
- Package scripts should be the stable interface for common repo workflows.

## Repo workflow expectations

- Prefer `bun run ...` over calling tooling directly from docs.
- Keep scripts deterministic and agent-friendly.
- Keep Bun entrypoints stable even when the implementation behind a workflow is
  refactored.

## Boundary expectations

- Parse config and external payloads at the boundary.
- Keep domain services typed and transport-agnostic.
- Prefer explicit provider interfaces for endpoint integrations, persistence,
  metrics, and logging.
