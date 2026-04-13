# Design

## Agent-first principles

AgentProbe is designed so agents can discover, validate, and extend the system
from repository-local context.

- `AGENTS.md` is a router, not an encyclopedia.
- `docs/` is the system of record.
- Progressive disclosure beats giant instruction blobs.
- Mechanical checks beat tribal memory.
- Humans encode rules once; agents apply them everywhere.

## Repository legibility

The repository should answer these questions without outside help:

- What the product does
- How the code is layered
- Which commands prove a change is safe
- Where plans live
- How logging, metrics, traces, and latency budgets are enforced
- Which invariants are hard rules rather than style preferences

If a future agent cannot answer one of those questions from the repo, the fix is
to improve the repo, not to rely on a better prompt.

## Enforcement philosophy

- Enforce boundaries and invariants centrally.
- Allow local implementation freedom inside those boundaries.
- Promote repeated review feedback into docs, scripts, or lints.
- Prefer deterministic structure over cleverness.
- Keep PRs small enough that an agent can validate and explain them in one pass.

## Taste invariants

- Validate data at the boundary.
- Keep transport concerns behind typed SDK/provider interfaces.
- Use structured logging instead of ad-hoc string dumps.
- Make performance expectations explicit and testable.
- Prefer simple, inspectable helpers over abstractions that hide behavior.
