#!/usr/bin/env bun
/**
 * Refreshes INDEX.md files for directories under docs/.
 * Keeps the hand-authored Purpose/File conventions sections, then rewrites the
 * file and subdirectory link sections so they stay current.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS_DIR = "docs";
const INDEX_NAME = "INDEX.md";
const START_FILES = "<!-- AUTO-GENERATED FILE LINKS START -->";
const END_FILES = "<!-- AUTO-GENERATED FILE LINKS END -->";
const START_DIRS = "<!-- AUTO-GENERATED SUBDIR LINKS START -->";
const END_DIRS = "<!-- AUTO-GENERATED SUBDIR LINKS END -->";

function walkDocDirectories(dir: string): string[] {
  const directories = [dir];
  for (const name of readdirSync(join(REPO_ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`;
    const full = join(REPO_ROOT, rel);
    if (!statSync(full).isDirectory() || name.startsWith(".")) continue;
    directories.push(...walkDocDirectories(rel));
  }
  return directories;
}

const directories = new Set(walkDocDirectories(DOCS_DIR));

function collectFor(dir: string): { files: string[]; subdirs: string[] } {
  const fullDir = join(REPO_ROOT, dir);
  const entries = readdirSync(fullDir).sort();
  const files = entries
    .filter((name) => name.endsWith(".md") && name !== INDEX_NAME)
    .sort();

  const subdirs = entries
    .filter((name) => statSync(join(fullDir, name)).isDirectory())
    .filter((name) => !name.startsWith("."))
    .map((name) => `${dir}/${name}`)
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
  lines: string[],
): string {
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped(start)}[\\s\\S]*?${escaped(end)}`);
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
          `- [${s.split("/").slice(-1)[0]}/INDEX.md](${s.split("/").slice(-1)[0]}/INDEX.md)`,
      )
    : ["- No tracked subdirectories."];

  let next = replaceSection(current, START_FILES, END_FILES, fileLines);
  next = replaceSection(next, START_DIRS, END_DIRS, dirLines);
  if (!next.endsWith("\n")) next += "\n";

  writeFileSync(indexPath, next);
  console.log(`Updated ${join(dir, INDEX_NAME)}`);
}
