import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { startAgentProbeServer } from "../../../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../../../src/runtime/server/config.ts";
import { AgentProbeConfigError } from "../../../src/shared/utils/errors.ts";
import { makeTempDir } from "../support.ts";

function makeDataDir(): string {
  const root = makeTempDir("server-config");
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  return data;
}

describe("server config", () => {
  test("defaults to loopback, port 7878, sqlite history, and dashboard dist", () => {
    const data = makeDataDir();
    const config = buildServerConfig({
      args: ["--data", data],
      env: {},
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7878);
    expect(config.dataPath).toBe(resolve(data));
    expect(config.dbUrl).toBe(
      `sqlite:///${resolve(".agentprobe", "runs.sqlite3")}`,
    );
    expect(config.dashboardDist).toBe(resolve("dashboard/dist"));
    expect(config.corsOrigins).toEqual([]);
    expect(config.openBrowser).toBe(false);
  });

  test("rejects non-loopback exposure without unsafe flag, token, and CORS origins", () => {
    const data = makeDataDir();

    expect(() =>
      buildServerConfig({
        args: ["--data", data, "--host", "0.0.0.0"],
        env: {},
      }),
    ).toThrow(AgentProbeConfigError);
    expect(() =>
      buildServerConfig({
        args: ["--data", data, "--host", "0.0.0.0", "--unsafe-expose"],
        env: {},
      }),
    ).toThrow(/token/);
    expect(() =>
      buildServerConfig({
        args: [
          "--data",
          data,
          "--host",
          "0.0.0.0",
          "--unsafe-expose",
          "--token",
          "secret",
        ],
        env: {},
      }),
    ).toThrow(/CORS origins/);

    const config = buildServerConfig({
      args: [
        "--data",
        data,
        "--host",
        "0.0.0.0",
        "--unsafe-expose",
        "--token",
        "secret",
      ],
      env: {
        AGENTPROBE_SERVER_CORS_ORIGINS:
          "https://dashboard.example, http://localhost:5173",
      },
    });
    expect(config.unsafeExpose).toBe(true);
    expect(config.token).toBe("secret");
    expect(config.corsOrigins).toEqual([
      "https://dashboard.example",
      "http://localhost:5173",
    ]);
  });

  test("allows loopback ranges and rejects postgres URLs for write-enabled server mode", () => {
    const data = makeDataDir();

    expect(
      buildServerConfig({
        args: ["--data", data, "--host", "127.9.8.7"],
        env: {},
      }).host,
    ).toBe("127.9.8.7");

    expect(() =>
      buildServerConfig({
        args: ["--data", data, "--db", "postgres://u:p@localhost/agentprobe"],
        env: {},
      }),
    ).toThrow(/Postgres is read-only for run recording/);

    expect(() =>
      buildServerConfig({
        args: ["--data", data],
        env: {
          AGENTPROBE_DB_URL: "postgresql://u:p@localhost:5432/agentprobe",
        },
      }),
    ).toThrow(/POST \/api\/runs/);
  });

  test("uses env fallbacks when CLI flags are absent", () => {
    const data = makeDataDir();
    const dbPath = join(makeTempDir("server-config-db"), "runs.sqlite3");

    const config = buildServerConfig({
      args: [],
      env: {
        AGENTPROBE_SERVER_HOST: "localhost",
        AGENTPROBE_SERVER_PORT: "0",
        AGENTPROBE_SERVER_DATA: data,
        AGENTPROBE_SERVER_DB: dbPath,
        AGENTPROBE_SERVER_TOKEN: "env-token",
        AGENTPROBE_SERVER_CORS_ORIGINS:
          "https://dashboard.example, https://dashboard.example",
        AGENTPROBE_SERVER_LOG_FORMAT: "json",
      },
    });

    expect(config.host).toBe("localhost");
    expect(config.port).toBe(0);
    expect(config.dbUrl).toBe(`sqlite:///${resolve(dbPath)}`);
    expect(config.token).toBe("env-token");
    expect(config.corsOrigins).toEqual(["https://dashboard.example"]);
    expect(config.logFormat).toBe("json");
  });

  test("redacts unsupported database URL credentials in config errors", () => {
    const data = makeDataDir();

    try {
      buildServerConfig({
        args: ["--data", data],
        env: {
          AGENTPROBE_DB_URL: "mysql://user:pa@ss@host/db",
        },
      });
      throw new Error("Expected buildServerConfig to reject mysql URLs.");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProbeConfigError);
      const message = String((error as Error).message);
      expect(message).toContain("mysql://user:***@host/db");
      expect(message).not.toContain("pa@ss");
      expect(message).not.toContain("ss@host");
    }
  });

  test("rejects invalid CORS origins", () => {
    const data = makeDataDir();

    expect(() =>
      buildServerConfig({
        args: ["--data", data],
        env: {
          AGENTPROBE_SERVER_CORS_ORIGINS: "https://dashboard.example/app",
        },
      }),
    ).toThrow(/without paths/);

    expect(() =>
      buildServerConfig({
        args: ["--data", data],
        env: {
          AGENTPROBE_SERVER_CORS_ORIGINS: "file:///tmp/dashboard.html",
        },
      }),
    ).toThrow(/http or https/);
  });

  test("server startup refuses postgres before schema probing when config is prebuilt", async () => {
    const data = makeDataDir();

    await expect(
      startAgentProbeServer({
        host: "127.0.0.1",
        port: 0,
        dataPath: data,
        dbUrl: "postgres://u:p@localhost/agentprobe",
        corsOrigins: [],
        unsafeExpose: false,
        openBrowser: false,
        logFormat: "text",
      }),
    ).rejects.toThrow(/Postgres is read-only for run recording/);
  });
});
