#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ensure uv/uvx are on PATH
export PATH="$HOME/.local/bin:$PATH"

echo "=== Fast Feedback ==="

# 1. Repo validation
echo "--- Repo validation ---"
bash "$SCRIPT_DIR/validate-repo.sh"

# 2. Format check
echo "--- Format check ---"
cd "$REPO_ROOT"
uvx ruff format --check .

# 3. Lint
echo "--- Lint ---"
uvx ruff check .

# 4. Type check
echo "--- Type check ---"
uv run pyright

# 5. Tests
echo "--- Tests ---"
uv run pytest

echo ""
echo "Fast feedback passed."
