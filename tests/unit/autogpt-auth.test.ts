import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveAuth } from "../../src/providers/sdk/autogpt-auth.ts";

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {
    AUTOGPT_AUTH_MODE: process.env.AUTOGPT_AUTH_MODE,
    AUTOGPT_EMAIL: process.env.AUTOGPT_EMAIL,
    AUTOGPT_PASSWORD: process.env.AUTOGPT_PASSWORD,
  };
  for (const key of Object.keys(originalEnv)) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("autogpt auth", () => {
  test("resolveAuth is the real-login strategy (which needs a real account)", async () => {
    await expect(resolveAuth()).rejects.toThrow(
      /requires a stable benchmark account/i,
    );
    await expect(resolveAuth({ email: "bench@agpt.co" })).rejects.toThrow(
      /requires a password/i,
    );
  });

  test("resolveAuth rejects the removed supabase mode loudly", async () => {
    process.env.AUTOGPT_AUTH_MODE = "supabase";
    await expect(resolveAuth()).rejects.toThrow(/no longer supported/i);
  });

  test("resolveAuth rejects an unknown AUTOGPT_AUTH_MODE", async () => {
    process.env.AUTOGPT_AUTH_MODE = "totally-bogus";
    await expect(resolveAuth()).rejects.toThrow(/no longer supported/i);
  });

  test("resolveAuth tolerates a leftover better-auth mode setting", async () => {
    process.env.AUTOGPT_AUTH_MODE = "better-auth";
    await expect(resolveAuth()).rejects.toThrow(
      /requires a stable benchmark account/i,
    );
  });
});
