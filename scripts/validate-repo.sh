#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Validate Repo ==="

ERRORS=0

# 1. Check for absolute local paths in docs
echo "Checking for absolute local paths..."
if grep -rn '/Users/\|/home/\|C:\\Users' "$REPO_ROOT/docs/" "$REPO_ROOT/AGENTS.md" "$REPO_ROOT/README.md" 2>/dev/null; then
  echo "ERROR: Found absolute local paths in docs"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK"
fi

# 2. Check markdown links
echo "Checking doc links..."
python3 "$SCRIPT_DIR/check-doc-links.py" || ERRORS=$((ERRORS + 1))

# 3. Check AGENTS.md drift
echo "Checking AGENTS.md drift..."
python3 "$SCRIPT_DIR/check-agents-drift.py" || ERRORS=$((ERRORS + 1))

# 4. Check behaviour doc consistency
echo "Checking behaviour docs..."
python3 "$SCRIPT_DIR/check-behaviour-docs.py" || ERRORS=$((ERRORS + 1))

# 5. Check generated docs freshness
echo "Checking generated docs..."
bash "$SCRIPT_DIR/check-generated-docs.sh" || ERRORS=$((ERRORS + 1))

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "FAILED: $ERRORS check(s) failed"
  exit 1
fi

echo ""
echo "All checks passed."
