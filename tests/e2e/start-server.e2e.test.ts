import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

async function waitForListeningUrl(
  process: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number,
): Promise<string> {
  const reader = process.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for server")),
          remaining,
        ),
      ),
    ]);
    if (result.done) {
      throw new Error(`server exited before listening:\n${stderr}`);
    }
    stderr += decoder.decode(result.value, { stream: true });
    const match = stderr.match(
      /AgentProbe server listening on (http:\/\/[^\s]+)/,
    );
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(`server did not report a listening URL:\n${stderr}`);
}

describe("agentprobe start-server", () => {
  test("boots without OPEN_ROUTER_API_KEY and shuts down on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentprobe-server-e2e-"));
    const dbPath = join(root, "runs.sqlite3");
    const process = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "agentprobe",
        "start-server",
        "--port",
        "0",
        "--data",
        "data",
        "--db",
        dbPath,
      ],
      cwd: PROJECT_ROOT,
      env: {
        ...Bun.env,
        AGENTPROBE_DISABLE_BROWSER_OPEN: "1",
        OPEN_ROUTER_API_KEY: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const url = await waitForListeningUrl(process, 10_000);
      const health = await fetch(`${url}/healthz`);
      const ready = await fetch(`${url}/readyz`);

      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
    } finally {
      process.kill("SIGTERM");
    }

    const exitCode = await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("server did not stop")), 5_000),
      ),
    ]);
    expect(exitCode).toBe(0);
  });
});
