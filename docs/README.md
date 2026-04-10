# Docs Index

Start here when you need repository truth instead of local guesswork.

## Core contracts

- [ARCHITECTURE.md](ARCHITECTURE.md) explains the layered Bun/TypeScript
  architecture, dependency direction, and SDK/provider boundaries.
- [DESIGN.md](DESIGN.md) captures the agent-first principles behind the repo.
- [HARNESS.md](HARNESS.md) defines the working contract for validation, PRs,
  and escalation.
- [RELIABILITY.md](RELIABILITY.md) defines logging, metrics, traces, and the
  latency budgets agents must preserve.
- [SECURITY.md](SECURITY.md) defines boundary validation and secret rules.

## Product and planning

- [PRODUCT_SENSE.md](PRODUCT_SENSE.md) explains user-facing priorities and what
  makes the CLI successful.
- [product-specs/](product-specs/) contains the canonical behavior spec and the
  current coverage snapshot derived from it.
- [PLANS.md](PLANS.md) explains how to use execution plans and debt tracking.
- [exec-plans/](exec-plans/) holds active plans, completed plans, and the
  shared tech debt tracker.

## Durable references

- [design-docs/](design-docs/) stores long-lived beliefs and design decisions.
- [references/](references/) stores toolchain, encoding, observability, and
  quality-gate references that agents can reuse without re-deriving.

## Generated and operational docs

- [QUALITY_SCORE.md](QUALITY_SCORE.md) is refreshed by script and summarizes
  repo pressure and missing enforcement.
- [generated/](generated/) contains script-owned inventories.
- [playbooks/](playbooks/) contains operational runbooks for repeatable tasks.
