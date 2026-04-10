#!/usr/bin/env bun
/**
 * Regenerates docs/QUALITY_SCORE.md from current repo state.
 */

import { existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

type Check = {
  area: string;
  ok: boolean;
  notes: string;
};

function has(path: string): boolean {
  return existsSync(join(REPO_ROOT, path));
}

function row(area: string, required: string[], notes: string): Check {
  const missing = required.filter((path) => !has(path));
  return {
    area,
    ok: missing.length === 0,
    notes: missing.length === 0 ? notes : `Missing: ${missing.join(", ")}`,
  };
}

const checks: Check[] = [
  row(
    "Knowledge base",
    ["AGENTS.md", "docs/README.md", "docs/DESIGN.md", "docs/ARCHITECTURE.md"],
    "Agent-first docs entrypoints present"
  ),
  row(
    "Product specs",
    [
      "docs/product-specs/platform.md",
      "docs/product-specs/current-state.md",
      "docs/product-specs/e2e-checklist.md",
    ],
    "Canonical behavior and coverage snapshots present"
  ),
  row(
    "Planning",
    [
      "docs/PLANS.md",
      "docs/exec-plans/README.md",
      "docs/exec-plans/tech-debt-tracker.md",
    ],
    "Plans and debt tracking are versioned in-repo"
  ),
  row(
    "Toolchain contract",
    ["package.json", "docs/references/bun-typescript.md", "docs/references/quality-gates.md"],
    "Bun-first workflow and TypeScript standards documented"
  ),
  row(
    "Reliability standards",
    ["docs/RELIABILITY.md", "docs/references/observability.md"],
    "Logging, metrics, spans, and latency budgets are documented"
  ),
  row(
    "Generated docs",
    ["docs/generated/INDEX.md", "docs/generated/workspace-inventory.md"],
    "Generated inventories available and script-owned"
  ),
];

const date = new Date().toISOString().split("T")[0];
const rows = checks
  .map(
    (c) =>
      `| ${c.area.padEnd(20)} | ${c.ok ? "\u{1F7E2}" : "\u{1F7E1}"} | ${c.notes} |`
  )
  .join("\n");

const content = `# Quality Score

Last updated: ${date}

## Health summary

| Area                 | Status | Notes |
|----------------------|--------|-------|
${rows}

## Incidents

_No incidents yet._

## Next cleanup targets

1. Land the Bun + TypeScript runtime so the implementation matches the docs contract.
2. Promote Biome and strict \`tsc --noEmit\` from documented standards into enforced repo gates.
3. Extend Bun-owned coverage to helper commands, observability assertions, and latency-budget checks.
`;

writeFileSync(join(REPO_ROOT, "docs", "QUALITY_SCORE.md"), content);
console.log("Refreshed docs/QUALITY_SCORE.md");
