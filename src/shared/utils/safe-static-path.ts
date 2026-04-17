import { resolve, sep } from "node:path";

export type SafePathResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string };

export function safeStaticPath(
  rootDir: string,
  requestedPath: string,
): SafePathResult {
  const resolvedRoot = resolve(rootDir);
  let relative = requestedPath;
  try {
    relative = decodeURIComponent(requestedPath);
  } catch {
    return { ok: false, reason: "invalid encoding" };
  }
  if (relative.startsWith("/")) {
    relative = relative.slice(1);
  }
  if (relative.includes("\0")) {
    return { ok: false, reason: "null byte" };
  }
  const absolutePath = resolve(resolvedRoot, relative);
  if (
    absolutePath !== resolvedRoot &&
    !absolutePath.startsWith(resolvedRoot + sep)
  ) {
    return { ok: false, reason: "escape detected" };
  }
  return { ok: true, absolutePath };
}
