# Encoding Reference

## Text file defaults

- All committed text files use UTF-8.
- All committed text files use LF line endings.
- Avoid BOM-prefixed files.

## Bun/Node I/O rules

- Pass explicit `"utf8"` when reading or writing text.
- Treat binary payloads and text payloads as different concerns.
- Normalize line endings in generated text so artifacts are deterministic.

## CLI and report rules

- Do not assume locale-specific encodings.
- Emit deterministic text output suitable for logs, reports, and snapshots.
- Preserve user-visible Unicode where it is intentional, but never rely on
  accidental encoding behavior.
