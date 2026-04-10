# Bun + TypeScript Reference

## Canonical toolchain

- Bun is the primary repo workflow entrypoint.
- TypeScript is the target implementation language.
- Package scripts should be the stable interface for common repo workflows.

## Repo workflow expectations

- Prefer `bun run ...` over calling tooling directly from docs.
- Keep scripts deterministic and agent-friendly.
- If a workflow still shells into a legacy tool during migration, keep the Bun
  entrypoint stable and migrate the implementation beneath it.

## Boundary expectations

- Parse config and external payloads at the boundary.
- Keep domain services typed and transport-agnostic.
- Prefer explicit provider interfaces for endpoint integrations, persistence,
  metrics, and logging.
