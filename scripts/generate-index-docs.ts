#!/usr/bin/env bun
/**
 * Refreshes INDEX.md files for directories under docs/.
 * Keeps the hand-authored Purpose/File conventions sections, then rewrites the
 * file and subdirectory link sections so they stay current.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, posix } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS_DIR = "docs";
const INDEX_NAME = "INDEX.md";
const START_FILES = "<!-- AUTO-GENERATED FILE LINKS START -->";
const END_FILES = "<!-- AUTO-GENERATED FILE LINKS END -->";
const START_DIRS = "<!-- AUTO-GENERATED SUBDIR LINKS START -->";
const END_DIRS = "<!-- AUTO-GENERATED SUBDIR LINKS END -->";

const tracked = execFileSync("git", ["ls-files"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((p) => p && p.startsWith(`${DOCS_DIR}/`));

const directories = new Set([DOCS_DIR]);
for (const path of tracked) {
  const parts = path.split("/");
  if (parts.length <= 1) continue;
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    if (current === DOCS_DIR || current.startsWith(`${DOCS_DIR}/`)) {
      directories.add(current);
    }
  }
}

function collectFor(dir: string): { files: string[]; subdirs: string[] } {
  const prefix = `${dir}/`;
  const files = tracked
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((p) => p && !p.includes("/") && p !== INDEX_NAME)
    .sort();

  const subdirs = [...directories]
    .filter((c) => c !== dir)
    .filter((c) => c.startsWith(`${dir}/`) && !c.slice(dir.length + 1).includes("/"))
    .sort();

  return { files, subdirs };
}

function defaultContent(dir: string): string {
  const title = `${dir.split("/").slice(-1)[0]} Index`;
  return `# ${title}

## Purpose

Describe what belongs in this directory.

## File conventions

- Describe the file types stored here.
- Describe naming/content format expectations.
- Describe what should not be committed here.

## Files

${START_FILES}
${END_FILES}

## Subdirectories

${START_DIRS}
${END_DIRS}
`;
}

function replaceSection(
  content: string,
  start: string,
  end: string,
  lines: string[]
): string {
  const escaped = (s: string) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `${escaped(start)}[\\s\\S]*?${escaped(end)}`
  );
  const body = [start, ...lines, end].join("\n");
  return pattern.test(content)
    ? content.replace(pattern, body)
    : `${content.trim()}\n\n${body}\n`;
}

for (const dir of [...directories].sort()) {
  const indexPath = join(REPO_ROOT, dir, INDEX_NAME);
  mkdirSync(dirname(indexPath), { recursive: true });
  const current = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : defaultContent(dir);
  const { files, subdirs } = collectFor(dir);

  const fileLines = files.length
    ? files.map((name) => `- [${name}](${name})`)
    : ["- No tracked files in this directory yet."];

  const dirLines = subdirs.length
    ? subdirs.map(
        (s) =>
          `- [${s.split("/").slice(-1)[0]}/INDEX.md](${s.split("/").slice(-1)[0]}/INDEX.md)`
      )
    : ["- No tracked subdirectories."];

  let next = replaceSection(current, START_FILES, END_FILES, fileLines);
  next = replaceSection(next, START_DIRS, END_DIRS, dirLines);
  if (!next.endsWith("\n")) next += "\n";

  writeFileSync(indexPath, next);
  console.log(`Updated ${join(dir, INDEX_NAME)}`);
}
