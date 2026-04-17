import { describe, expect, test } from "bun:test";

import {
  constantTimeEquals,
  extractBearerToken,
  verifyBearerToken,
} from "../../../src/runtime/server/auth/token.ts";

describe("server token auth", () => {
  test("compares tokens without accepting length mismatches", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
    expect(constantTimeEquals("secret", "Secret")).toBe(false);
    expect(constantTimeEquals("secret", "secret-extra")).toBe(false);
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
