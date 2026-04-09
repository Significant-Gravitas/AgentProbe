#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Checking generated docs freshness..."

# Regenerate into a temp location and diff
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Copy current generated docs
if [ -d "$REPO_ROOT/docs/generated" ]; then
  cp -r "$REPO_ROOT/docs/generated" "$TEMP_DIR/before"
else
  mkdir -p "$TEMP_DIR/before"
fi

# Regenerate
python3 "$SCRIPT_DIR/generate-workspace-docs.py" > /dev/null 2>&1

# Compare
if [ -d "$REPO_ROOT/docs/generated" ]; then
  cp -r "$REPO_ROOT/docs/generated" "$TEMP_DIR/after"
else
  mkdir -p "$TEMP_DIR/after"
fi

# Compare ignoring timestamp lines (Generated: ...)
if diff -r "$TEMP_DIR/before" "$TEMP_DIR/after" | grep -v "^[<>] Generated:" | grep -q "^[<>]"; then
  # There are real differences beyond timestamps
  STALE=true
else
  STALE=false
fi

if [ "$STALE" = "false" ]; then
  echo "Generated docs are up to date."
else
  echo "ERROR: Generated docs are stale. Run: python3 scripts/generate-workspace-docs.py"
  # Restore original
  if [ -d "$TEMP_DIR/before" ]; then
    rm -rf "$REPO_ROOT/docs/generated"
    cp -r "$TEMP_DIR/before" "$REPO_ROOT/docs/generated"
  fi
  exit 1
fi
