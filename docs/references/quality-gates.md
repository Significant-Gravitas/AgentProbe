# Quality Gates Reference

## Canonical stack

- Strict `tsc --noEmit`
- Biome for formatting and linting
- Repo-specific structural checks for architecture and docs integrity
- Deterministic tests with artifacts where useful

## TypeScript rules

- No unchecked `any`
- No guessed external shapes
- Validate data at the boundary
- Keep types and schemas close to the boundary they protect

## Enforcement strategy

- Use generic toolchains for broad correctness (`tsc`, Biome).
- Use repo-specific scripts for architecture, docs freshness, and plan hygiene.
- Promote repeated review feedback into a rule or check whenever possible.
