import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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

  test("allows loopback ranges and accepts postgres URLs in Phase 3", () => {
    const data = makeDataDir();

    expect(
      buildServerConfig({
        args: ["--data", data, "--host", "127.9.8.7"],
        env: {},
      }).host,
    ).toBe("127.9.8.7");

    const pg = buildServerConfig({
      args: ["--data", data, "--db", "postgres://u:p@localhost/agentprobe"],
      env: {},
    });
    expect(pg.dbUrl).toBe("postgres://u:p@localhost/agentprobe");

    const pgql = buildServerConfig({
      args: [
        "--data",
        data,
        "--db",
        "postgresql://u:p@localhost:5432/agentprobe",
      ],
      env: {},
    });
    expect(pgql.dbUrl).toBe("postgresql://u:p@localhost:5432/agentprobe");
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
});
