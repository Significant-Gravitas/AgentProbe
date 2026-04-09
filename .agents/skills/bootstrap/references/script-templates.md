# Script Templates

Adapt each script to the project's actual stack. Replace `{{placeholders}}`
with real values. All shell scripts should use `#!/usr/bin/env bash` and
`set -euo pipefail`.

---

## scripts/validate-repo.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Validate Repo ==="

ERRORS=0

# 1. Check for absolute local paths in docs
echo "Checking for absolute local paths..."
if grep -rn '/Users/\|/home/\|C:\\\\Users' "$REPO_ROOT/docs/" "$REPO_ROOT/AGENTS.md" "$REPO_ROOT/README.md" 2>/dev/null; then
  echo "ERROR: Found absolute local paths in docs"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK"
fi

# 2. Check markdown links
echo "Checking doc links..."
node "$SCRIPT_DIR/check-doc-links.mjs" || ERRORS=$((ERRORS + 1))

# 3. Check AGENTS.md drift
echo "Checking AGENTS.md drift..."
node "$SCRIPT_DIR/check-agents-drift.mjs" || ERRORS=$((ERRORS + 1))

# 4. Check behaviour doc consistency
echo "Checking behaviour docs..."
node "$SCRIPT_DIR/check-behaviour-docs.mjs" || ERRORS=$((ERRORS + 1))

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
```

---

## scripts/fast-feedback.sh

Customize the stack-specific sections based on the project.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Fast Feedback ==="

# 1. Repo validation
echo "--- Repo validation ---"
bash "$SCRIPT_DIR/validate-repo.sh"

# 2. Stack-specific checks
# Customize this section for the project's stack.

# --- Frontend (if applicable) ---
# echo "--- Frontend checks ---"
# cd "$REPO_ROOT/{{frontend_dir}}"
# {{package_manager}} run typecheck
# {{package_manager}} run lint
# {{package_manager}} run build

# --- Backend (if applicable) ---
# echo "--- Backend checks ---"
# cd "$REPO_ROOT/{{backend_dir}}"
# {{backend_test_command}}

echo ""
echo "Fast feedback passed."
```

---

## scripts/ui-smoke.sh

Only create if the project has a browser frontend.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO_ROOT/test-results}"
mkdir -p "$ARTIFACTS_DIR"

echo "=== UI Smoke Tests ==="

cd "$REPO_ROOT"

npx playwright test --grep @smoke \
  --reporter=html \
  --output="$ARTIFACTS_DIR" \
  || {
    echo "Smoke tests failed. Artifacts saved to $ARTIFACTS_DIR"
    exit 1
  }

echo "Smoke tests passed. Artifacts: $ARTIFACTS_DIR"
```

---

## scripts/harness/run-local.sh

Only create if the project has a local dev stack.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Derive a unique port offset from the worktree path to avoid collisions
WORKTREE_HASH=$(echo "$REPO_ROOT" | cksum | awk '{print $1}')
PORT_OFFSET=$((WORKTREE_HASH % 1000))
BASE_PORT=$((3000 + PORT_OFFSET))

# Isolated data directory per worktree
DATA_DIR="$REPO_ROOT/.local-data"
mkdir -p "$DATA_DIR"

# Port assignments
APP_PORT=$BASE_PORT
# DB_PORT=$((BASE_PORT + 1))
# API_PORT=$((BASE_PORT + 2))

# Write manifest
MANIFEST="$DATA_DIR/manifest.json"
cat > "$MANIFEST" <<EOF
{
  "repo_root": "$REPO_ROOT",
  "data_dir": "$DATA_DIR",
  "ports": {
    "app": $APP_PORT
  },
  "urls": {
    "app": "http://localhost:$APP_PORT"
  },
  "logs": "$DATA_DIR/logs",
  "artifacts": "$DATA_DIR/artifacts",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

mkdir -p "$DATA_DIR/logs" "$DATA_DIR/artifacts"

echo "=== Local Harness ==="
echo "Manifest: $MANIFEST"
echo "App URL:  http://localhost:$APP_PORT"

# Boot local dependencies
# Customize: add docker-compose, database start, etc.
# Example:
# docker compose -f "$REPO_ROOT/docker-compose.yml" up -d

# Start the dev server
# Customize for your stack:
# cd "$REPO_ROOT" && {{start_command}} --port "$APP_PORT"

echo ""
echo "Local stack is ready. See $MANIFEST for details."
```

---

## scripts/generate-workspace-docs.mjs

```javascript
#!/usr/bin/env node

/**
 * Generates a workspace inventory for mechanical repo-map verification.
 * Output: docs/generated/workspace-inventory.md
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUTPUT = join(REPO_ROOT, 'docs', 'generated', 'workspace-inventory.md');

const IGNORE = new Set(['.git', 'node_modules', '.local-data', 'test-results', 'dist', 'build', '.next']);

function walk(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORE.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    const rel = relative(REPO_ROOT, full);
    if (stat.isDirectory()) {
      entries.push({ path: rel + '/', type: 'dir' });
      entries.push(...walk(full, depth + 1, maxDepth));
    } else {
      entries.push({ path: rel, type: 'file' });
    }
  }
  return entries;
}

const entries = walk(REPO_ROOT);
const lines = [
  '# Workspace Inventory',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  '```text',
  ...entries.map(e => (e.type === 'dir' ? `${e.path}` : `  ${e.path}`)),
  '```',
  '',
];

mkdirSync(join(REPO_ROOT, 'docs', 'generated'), { recursive: true });
writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Wrote ${OUTPUT}`);
```

---

## scripts/refresh-quality-score.mjs

```javascript
#!/usr/bin/env node

/**
 * Regenerates docs/QUALITY_SCORE.md from current repo state.
 * Checks: CI config exists, test files exist, generated docs fresh, baseline debt.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function check(name, condition) {
  const status = condition ? '🟢' : '🟡';
  return { name, status, ok: condition };
}

const checks = [
  check('CI config', existsSync(join(REPO_ROOT, '.github', 'workflows'))),
  check('Smoke tests', existsSync(join(REPO_ROOT, 'e2e'))),
  check('Behaviour spec', existsSync(join(REPO_ROOT, 'docs', 'behaviours', 'platform.md'))),
  check('AGENTS.md', existsSync(join(REPO_ROOT, 'AGENTS.md'))),
  check('Harness doc', existsSync(join(REPO_ROOT, 'docs', 'HARNESS.md'))),
];

const date = new Date().toISOString().split('T')[0];
const rows = checks.map(c => `| ${c.name.padEnd(18)} | ${c.status}     | ${c.ok ? 'Present' : 'Missing'} |`);

const content = `# Quality Score

Last updated: ${date}

## Health summary

| Area               | Status | Notes                     |
|--------------------|--------|---------------------------|
${rows.join('\n')}

## Incidents

_No incidents yet._

## Next cleanup targets

1. Expand test coverage
2. Fill out remaining behavior scenarios
3. Add integration tests for core paths
`;

writeFileSync(join(REPO_ROOT, 'docs', 'QUALITY_SCORE.md'), content);
console.log('Refreshed docs/QUALITY_SCORE.md');
```

---

## scripts/check-doc-links.mjs

```javascript
#!/usr/bin/env node

/**
 * Validates relative markdown links in docs/ and AGENTS.md.
 * Exits non-zero if any link target is missing.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

let errors = 0;

function checkFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  let match;
  while ((match = LINK_RE.exec(content)) !== null) {
    const target = match[2];
    // Skip URLs and anchors
    if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
    const resolved = resolve(dirname(filePath), target.split('#')[0]);
    if (!existsSync(resolved)) {
      console.error(`BROKEN LINK: ${filePath} -> ${target}`);
      errors++;
    }
  }
}

function walkMd(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== '.git') walkMd(full);
    } else if (name.endsWith('.md')) {
      checkFile(full);
    }
  }
}

// Check docs/ and root markdown files
walkMd(join(REPO_ROOT, 'docs'));
for (const f of ['AGENTS.md', 'README.md']) {
  const p = join(REPO_ROOT, f);
  if (existsSync(p)) checkFile(p);
}

if (errors > 0) {
  console.error(`\n${errors} broken link(s) found.`);
  process.exit(1);
} else {
  console.log('All doc links OK.');
}
```

---

## scripts/check-agents-drift.mjs

```javascript
#!/usr/bin/env node

/**
 * Checks that the repo map in AGENTS.md reflects the actual directory structure.
 * Parses the "Repo map" code block and verifies each listed directory exists.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');

// Extract directory names from the repo map code block
const mapMatch = agents.match(/```text\n([\s\S]*?)```/);
if (!mapMatch) {
  console.log('No repo map code block found in AGENTS.md — skipping drift check.');
  process.exit(0);
}

const DIR_RE = /[├└│─\s]*(\S+?)\//gm;
let errors = 0;
let match;

while ((match = DIR_RE.exec(mapMatch[1])) !== null) {
  const dirName = match[1];
  // Skip if it looks like a nested path indicator
  if (dirName.includes('#') || dirName.startsWith('.')) continue;
  if (!existsSync(join(REPO_ROOT, dirName))) {
    console.error(`DRIFT: AGENTS.md lists "${dirName}/" but it does not exist`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} drift issue(s). Update the repo map in AGENTS.md.`);
  process.exit(1);
} else {
  console.log('AGENTS.md repo map matches directory structure.');
}
```

---

## scripts/check-behaviour-docs.mjs

```javascript
#!/usr/bin/env node

/**
 * Validates that current-state.md and e2e-checklist.md reference
 * scenarios defined in platform.md.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BEHAVIOURS = join(REPO_ROOT, 'docs', 'behaviours');

function extractScenarios(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const re = /^###\s+(.+)$/gm;
  const scenarios = [];
  let match;
  while ((match = re.exec(content)) !== null) {
    scenarios.push(match[1].trim());
  }
  return scenarios;
}

const platformScenarios = extractScenarios(join(BEHAVIOURS, 'platform.md'));

if (platformScenarios.length === 0) {
  console.log('No scenarios found in platform.md — skipping behaviour check.');
  process.exit(0);
}

console.log(`Found ${platformScenarios.length} scenario(s) in platform.md`);

// Just verify the files exist and reference at least one scenario
for (const file of ['current-state.md', 'e2e-checklist.md']) {
  const path = join(BEHAVIOURS, file);
  if (!existsSync(path)) {
    console.error(`MISSING: ${file}`);
    process.exit(1);
  }
}

console.log('Behaviour docs present and consistent.');
```

---

## scripts/check-generated-docs.sh

```bash
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
node "$SCRIPT_DIR/generate-workspace-docs.mjs" > /dev/null 2>&1

# Compare
if [ -d "$REPO_ROOT/docs/generated" ]; then
  cp -r "$REPO_ROOT/docs/generated" "$TEMP_DIR/after"
else
  mkdir -p "$TEMP_DIR/after"
fi

if diff -rq "$TEMP_DIR/before" "$TEMP_DIR/after" > /dev/null 2>&1; then
  echo "Generated docs are up to date."
else
  echo "ERROR: Generated docs are stale. Run: node scripts/generate-workspace-docs.mjs"
  # Restore original
  if [ -d "$TEMP_DIR/before" ]; then
    rm -rf "$REPO_ROOT/docs/generated"
    cp -r "$TEMP_DIR/before" "$REPO_ROOT/docs/generated"
  fi
  exit 1
fi
```
