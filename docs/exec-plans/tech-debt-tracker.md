# Tech Debt Tracker

Known cleanup work that should remain visible until it is planned or fixed.

## Active themes

- Promote Bun + TypeScript quality gates from documented standards into enforced
  scripts and CI checks.
- Replace legacy mixed-language runtime paths with the Bun-first implementation
  described in the docs.
- Add executable observability and latency-budget assertions for critical paths.

## Promotion rule

Move an item into `active/` when it requires sequencing, explicit ownership, or
multi-step validation. Remove it from this file once it is represented by an
active plan or has been shipped.
