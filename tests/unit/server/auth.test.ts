import { describe, expect, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";

import {
  constantTimeEquals,
  extractBearerToken,
  TOKEN_COMPARE_BYTE_LENGTH,
  verifyBearerToken,
} from "../../../src/runtime/server/auth/token.ts";

describe("server token auth", () => {
  test("compares tokens without accepting length mismatches", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
    expect(constantTimeEquals("secret", "Secret")).toBe(false);
    expect(constantTimeEquals("secret", "secret-extra")).toBe(false);
  });

  test("uses the same padded compare path for length mismatches", () => {
    const comparisons: Array<{
      leftLength: number;
      rightLength: number;
      sameReference: boolean;
    }> = [];
    const compare: typeof timingSafeEqual = (left, right) => {
      comparisons.push({
        leftLength: left.byteLength,
        rightLength: right.byteLength,
        sameReference: Object.is(left, right),
      });
      return timingSafeEqual(left, right);
    };

    expect(constantTimeEquals("secret", "secret", compare)).toBe(true);
    expect(constantTimeEquals("secret", "Secret", compare)).toBe(false);
    expect(constantTimeEquals("secret", "secret-extra", compare)).toBe(false);
    expect(
      constantTimeEquals(
        "a".repeat(TOKEN_COMPARE_BYTE_LENGTH + 1),
        "a".repeat(TOKEN_COMPARE_BYTE_LENGTH + 1),
        compare,
      ),
    ).toBe(false);

    expect(comparisons).toEqual([
      {
        leftLength: TOKEN_COMPARE_BYTE_LENGTH,
        rightLength: TOKEN_COMPARE_BYTE_LENGTH,
        sameReference: false,
      },
      {
        leftLength: TOKEN_COMPARE_BYTE_LENGTH,
        rightLength: TOKEN_COMPARE_BYTE_LENGTH,
        sameReference: false,
      },
      {
        leftLength: TOKEN_COMPARE_BYTE_LENGTH,
        rightLength: TOKEN_COMPARE_BYTE_LENGTH,
        sameReference: false,
      },
      {
        leftLength: TOKEN_COMPARE_BYTE_LENGTH,
        rightLength: TOKEN_COMPARE_BYTE_LENGTH,
        sameReference: false,
      },
    ]);
  });

  test("extracts bearer headers and EventSource access_token fallback", () => {
    const headerRequest = new Request("http://example.test/api/runs", {
      headers: { authorization: "Bearer abc123" },
    });
    const eventSourceRequest = new Request(
      "http://example.test/api/runs/run-1/events?access_token=sse-token",
    );

    expect(extractBearerToken(headerRequest)).toBe("abc123");
    expect(extractBearerToken(eventSourceRequest)).toBe("sse-token");
  });

  test("protects API paths while leaving health and static routes public", () => {
    expect(
      verifyBearerToken(new Request("http://example.test/healthz"), "secret"),
    ).toBe(true);
    expect(
      verifyBearerToken(new Request("http://example.test/readyz"), "secret"),
    ).toBe(true);
    expect(
      verifyBearerToken(new Request("http://example.test/"), "secret"),
    ).toBe(true);
    expect(
      verifyBearerToken(new Request("http://example.test/api/runs"), "secret"),
    ).toBe(false);
    expect(
      verifyBearerToken(
        new Request("http://example.test/api/runs", {
          headers: { authorization: "Bearer secret" },
        }),
        "secret",
      ),
    ).toBe(true);
  });
});
