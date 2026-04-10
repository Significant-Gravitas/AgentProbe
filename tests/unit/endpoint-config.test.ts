import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEndpointsYaml, processYamlFiles } from "../../src/domains/validation/load-suite.ts";
import { configureEndpoint } from "../../src/providers/sdk/preset-config.ts";
import { DATA_DIR, makeTempDir } from "./support.ts";

describe("endpoint configuration", () => {
  const envSnapshot = {
    OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
    OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
    AUTOGPT_BACKEND_URL: process.env.AUTOGPT_BACKEND_URL,
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("configures openclaw by preset and source filename", () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway.test/socket";
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";

    const tempPath = join(makeTempDir("openclaw-endpoint"), "openclaw-endpoints.yaml");
    writeFileSync(
      tempPath,
      readFileSync(join(DATA_DIR, "openclaw-endpoints.yaml"), "utf8"),
      "utf8",
    );

    const byPreset = configureEndpoint(parseEndpointsYaml(tempPath));
    expect(byPreset.transport).toBe("websocket");
    expect("url" in (byPreset.connection ?? {})).toBe(true);
    expect((byPreset.connection as { url: string }).url).toBe(
      "wss://gateway.test/socket",
    );
    expect(byPreset.websocket?.connect?.challengeEvent).toBe("connect.challenge");
    expect(byPreset.websocket?.connect?.method).toBe("connect");
    expect(byPreset.websocket?.connect?.params.client).toMatchObject({
      id: "openclaw-probe",
      mode: "probe",
    });
    expect(byPreset.websocket?.connect?.params.auth).toEqual({
      token: "test-token",
    });

    const byFilename = parseEndpointsYaml(join(DATA_DIR, "openclaw-endpoints.yaml"));
    byFilename.preset = undefined;
    const configuredByFilename = configureEndpoint(byFilename);
    expect((configuredByFilename.connection as { url: string }).url).toBe(
      "wss://gateway.test/socket",
    );

    unlinkSync(tempPath);
  });

  test("rejects non-websocket openclaw urls", () => {
    const endpoint = parseEndpointsYaml(join(DATA_DIR, "openclaw-endpoints.yaml"));
    (endpoint.connection as { url: string }).url = "http://gateway.test";
    expect(() => configureEndpoint(endpoint)).toThrow(/ws:\/\/ or wss:\/\//);
  });

  test("interpolates opencode and autogpt config", () => {
    process.env.OPENCODE_BASE_URL = "http://opencode.test:9999";
    process.env.AUTOGPT_BACKEND_URL = "http://backend.test:8006";

    const opencode = configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "opencode-endpoints.yaml")),
    );
    expect((opencode.connection as { baseUrl: string }).baseUrl).toBe(
      "http://opencode.test:9999",
    );

    const autogpt = configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "autogpt-endpoint.yaml")),
    );
    expect((autogpt.connection as { baseUrl: string }).baseUrl).toBe(
      "http://backend.test:8006",
    );
    expect(autogpt.auth?.type).toBe("none");
  });

  test("synthesizes opencode basic auth", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret-pass";

    const defaultUser = configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "opencode-endpoints.yaml")),
    );
    expect(defaultUser.auth?.type).toBe("header");
    expect(defaultUser.auth?.headerValue).toBe(
      `Basic ${Buffer.from("opencode:secret-pass").toString("base64")}`,
    );

    process.env.OPENCODE_SERVER_USERNAME = "alice";
    const customUser = configureEndpoint(
      parseEndpointsYaml(join(DATA_DIR, "opencode-endpoints.yaml")),
    );
    expect(customUser.auth?.headerValue).toBe(
      `Basic ${Buffer.from("alice:secret-pass").toString("base64")}`,
    );
  });

  test("preserves builtin endpoint yaml coverage", () => {
    const root = makeTempDir("endpoint-coverage");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "autogpt-endpoint.yaml"),
      readFileSync(join(DATA_DIR, "autogpt-endpoint.yaml"), "utf8"),
      "utf8",
    );
    writeFileSync(
      join(root, "opencode-endpoints.yaml"),
      readFileSync(join(DATA_DIR, "opencode-endpoints.yaml"), "utf8"),
      "utf8",
    );
    writeFileSync(
      join(root, "openclaw-endpoints.yaml"),
      readFileSync(join(DATA_DIR, "openclaw-endpoints.yaml"), "utf8"),
      "utf8",
    );

    const processed = processYamlFiles(root);
    expect(
      processed
        .map((item) => item.path.split("/").at(-1))
        .sort(),
    ).toEqual([
      "autogpt-endpoint.yaml",
      "openclaw-endpoints.yaml",
      "opencode-endpoints.yaml",
    ]);
  });
});
