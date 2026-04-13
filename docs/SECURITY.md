# Security

## Boundary validation

Security starts with trustworthy boundaries.

- Parse and validate environment, YAML, and network payloads before use.
- Treat unchecked external shapes as untrusted input.
- Prefer typed SDK/provider interfaces over ad-hoc transport calls.
- Avoid broad pass-through blobs crossing layers.

## Secret handling

- Secrets must come from environment or secret providers, never committed docs
  or fixtures.
- Logs, metrics, traces, reports, and persisted artifacts must redact tokens,
  cookies, API keys, and session credentials.
- Generated docs must never contain live credentials or workstation-specific
  absolute paths.

## SDK and auth rules

- Auth flows belong in dedicated provider/SDK layers.
- Business logic must consume typed auth results, not raw token payloads.
- Protected integrations should have clear boundaries for refresh, retry,
  redaction, and failure reporting.

## Review triggers

Require extra review when a change touches:

- authentication or credential flows
- endpoint signing or request canonicalization
- secret storage or redaction logic
- persistence of raw exchanges or third-party responses
