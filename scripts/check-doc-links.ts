#!/usr/bin/env bun
/**
 * Validates relative markdown links in docs/ and AGENTS.md.
 * Exits non-zero if any link target is missing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

let errors = 0;

function checkFile(filePath: string): void {
  const content = readFileSync(filePath, "utf8");
  let match: RegExpExecArray | null;
  // Reset lastIndex for global regex
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(content)) !== null) {
    const target = match[2];
    if (
      target.startsWith("http") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    )
      continue;
    const targetPath = target.split("#")[0];
    if (!targetPath) continue;
    const resolved = resolve(dirname(filePath), targetPath);
    if (!existsSync(resolved)) {
      console.error(`BROKEN LINK: ${filePath} -> ${target}`);
      errors++;
    }
  }
}

function walkMd(dir: string): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".git") walkMd(full);
    } else if (name.endsWith(".md")) {
      checkFile(full);
    }
  }
}

walkMd(join(REPO_ROOT, "docs"));

for (const f of ["AGENTS.md", "README.md"]) {
  const p = join(REPO_ROOT, f);
  if (existsSync(p)) checkFile(p);
}

if (errors > 0) {
  console.error(`\n${errors} broken link(s) found.`);
  process.exit(1);
} else {
  console.log("All doc links OK.");
}
