#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Checking generated docs freshness..."

# Regenerate into a temp location and diff
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

restore_originals() {
  rm -rf "$REPO_ROOT/docs/generated"
  if [ -d "$TEMP_DIR/before-generated" ]; then
    cp -r "$TEMP_DIR/before-generated" "$REPO_ROOT/docs/generated"
  else
    mkdir -p "$REPO_ROOT/docs/generated"
  fi

  if [ -f "$TEMP_DIR/before-quality.md" ]; then
    cp "$TEMP_DIR/before-quality.md" "$REPO_ROOT/docs/QUALITY_SCORE.md"
  else
    rm -f "$REPO_ROOT/docs/QUALITY_SCORE.md"
  fi
}

# Copy current generated docs and generated quality score
if [ -d "$REPO_ROOT/docs/generated" ]; then
  cp -r "$REPO_ROOT/docs/generated" "$TEMP_DIR/before-generated"
else
  mkdir -p "$TEMP_DIR/before-generated"
fi

if [ -f "$REPO_ROOT/docs/QUALITY_SCORE.md" ]; then
  cp "$REPO_ROOT/docs/QUALITY_SCORE.md" "$TEMP_DIR/before-quality.md"
fi

# Regenerate
bun "$SCRIPT_DIR/generate-workspace-docs.ts" > /dev/null 2>&1
bun "$SCRIPT_DIR/refresh-quality-score.ts" > /dev/null 2>&1

# Compare
if [ -d "$REPO_ROOT/docs/generated" ]; then
  cp -r "$REPO_ROOT/docs/generated" "$TEMP_DIR/after-generated"
else
  mkdir -p "$TEMP_DIR/after-generated"
fi

if [ -f "$REPO_ROOT/docs/QUALITY_SCORE.md" ]; then
  cp "$REPO_ROOT/docs/QUALITY_SCORE.md" "$TEMP_DIR/after-quality.md"
fi

# Compare ignoring timestamp lines (Generated: ...)
if diff -r "$TEMP_DIR/before-generated" "$TEMP_DIR/after-generated" | grep -v "^[<>] Generated:" | grep -q "^[<>]"; then
  # There are real differences beyond timestamps
  STALE=true
else
  STALE=false
fi

if [ "$STALE" = "false" ]; then
  if ! diff \
    <(grep -v '^Last updated:' "$TEMP_DIR/before-quality.md" 2>/dev/null || true) \
    <(grep -v '^Last updated:' "$TEMP_DIR/after-quality.md" 2>/dev/null || true) \
    > /dev/null; then
    STALE=true
  fi
fi

if [ "$STALE" = "false" ]; then
  echo "Generated docs are up to date."
else
  echo "ERROR: Generated docs are stale. Run: bun scripts/generate-workspace-docs.ts && bun scripts/refresh-quality-score.ts"
  restore_originals
  exit 1
fi

restore_originals
