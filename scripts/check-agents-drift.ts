#!/usr/bin/env bun
/**
 * Checks that the repo map in AGENTS.md reflects the actual directory structure.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

const mapMatch = agents.match(/```text\n([\s\S]*?)```/);
if (!mapMatch) {
  console.log(
    "No repo map code block found in AGENTS.md — skipping drift check.",
  );
  process.exit(0);
}

const TREE_LINE_RE = /[│\s]*[├└]──\s+(\S+)/g;
let errors = 0;
while (true) {
  const match = TREE_LINE_RE.exec(mapMatch[1]);
  if (!match) {
    break;
  }
  const entry = match[1].replace(/\/$/, "");
  if (!entry || entry.startsWith(".") || entry.includes("#")) {
    continue;
  }
  if (!existsSync(join(REPO_ROOT, entry))) {
    console.error(`DRIFT: AGENTS.md lists "${entry}/" but it does not exist`);
    errors++;
  }
}

if (errors > 0) {
  console.error(
    `\n${errors} drift issue(s). Update the repo map in AGENTS.md.`,
  );
  process.exit(1);
} else {
  console.log("AGENTS.md repo map matches directory structure.");
}
