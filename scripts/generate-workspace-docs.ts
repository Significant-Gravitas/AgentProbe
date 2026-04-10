#!/usr/bin/env bun
/**
 * Generates a workspace inventory for mechanical repo-map verification.
 * Output: docs/generated/workspace-inventory.md
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const OUTPUT = join(REPO_ROOT, "docs", "generated", "workspace-inventory.md");

const IGNORE = new Set([
  ".git",
  "node_modules",
  ".local-data",
  "test-results",
  "dist",
  "build",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  ".DS_Store",
]);

interface Entry {
  path: string;
  type: "dir" | "file";
}

function walk(dir: string, depth = 0, maxDepth = 3): Entry[] {
  if (depth > maxDepth) return [];
  const entries: Entry[] = [];
  let children: string[];
  try {
    children = readdirSync(dir).sort();
  } catch {
    return entries;
  }
  for (const name of children) {
    if (IGNORE.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    const rel = relative(REPO_ROOT, full);
    if (stat.isDirectory()) {
      entries.push({ path: `${rel}/`, type: "dir" });
      entries.push(...walk(full, depth + 1, maxDepth));
    } else {
      entries.push({ path: rel, type: "file" });
    }
  }
  return entries;
}

const entries = walk(REPO_ROOT);
const lines = [
  "# Workspace Inventory",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "```text",
  ...entries.map((e) => (e.type === "dir" ? e.path : `  ${e.path}`)),
  "```",
  "",
];

mkdirSync(join(REPO_ROOT, "docs", "generated"), { recursive: true });
writeFileSync(OUTPUT, lines.join("\n"));
console.log(`Wrote ${OUTPUT}`);
