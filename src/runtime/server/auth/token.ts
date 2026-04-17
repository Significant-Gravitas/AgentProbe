import { timingSafeEqual } from "node:crypto";

export const TOKEN_COMPARE_BYTE_LENGTH = 128;

type TimingSafeEqual = typeof timingSafeEqual;

export function constantTimeEquals(
  left: string,
  right: string,
  safeEqual: TimingSafeEqual = timingSafeEqual,
): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const leftPadded = Buffer.alloc(TOKEN_COMPARE_BYTE_LENGTH);
  const rightPadded = Buffer.alloc(TOKEN_COMPARE_BYTE_LENGTH);

  leftBytes.copy(leftPadded, 0, 0, TOKEN_COMPARE_BYTE_LENGTH);
  rightBytes.copy(rightPadded, 0, 0, TOKEN_COMPARE_BYTE_LENGTH);

  const equalBytes = safeEqual(leftPadded, rightPadded);
  const equalLengths = leftBytes.length === rightBytes.length;
  const withinCompareLimit =
    leftBytes.length <= TOKEN_COMPARE_BYTE_LENGTH &&
    rightBytes.length <= TOKEN_COMPARE_BYTE_LENGTH;

  return equalBytes && equalLengths && withinCompareLimit;
}

export function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  const url = new URL(request.url);
  const accessToken = url.searchParams.get("access_token");
  if (accessToken) {
    return accessToken.trim();
  }
  return undefined;
}

export function isAuthenticatedPath(pathname: string): boolean {
  if (pathname === "/healthz" || pathname === "/readyz") {
    return false;
  }
  if (pathname === "/" || !pathname.startsWith("/api/")) {
    return false;
  }
  return true;
}

export function verifyBearerToken(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  const pathname = new URL(request.url).pathname;
  if (!isAuthenticatedPath(pathname)) {
    return true;
  }
  const provided = extractBearerToken(request);
  if (!provided) {
    return false;
  }
  return constantTimeEquals(provided, expected);
}
