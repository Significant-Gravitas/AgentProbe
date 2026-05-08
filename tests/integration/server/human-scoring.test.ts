import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initDb } from "../../../src/providers/persistence/sqlite-run-history.ts";
import {
  type StartedServer,
  startAgentProbeServer,
} from "../../../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../../../src/runtime/server/config.ts";
import { makeTempDir } from "../../unit/support.ts";

type RubricsResponse = {
  rubrics: Array<{
    rubricId: string;
    rubricName: string;
    totalScenarios: number;
    dimensions: Array<{
      id: string;
      name: string;
      unscored: number;
      scale: { type: string; points?: number; labels: Record<string, string> };
    }>;
  }>;
};

type NextResponse = {
  item: {
    scenarioRunId: number;
    runId: string;
    ordinal: number;
    rubricId: string;
    remaining: number;
    turns: Array<{ turn_index: number; role: string }>;
  } | null;
};

type ScoreResponse = {
  ok: boolean;
  next: NextResponse["item"];
};

const RUBRIC_SNAPSHOT = {
  id: "support",
  name: "Support",
  passThreshold: 0.7,
  dimensions: [
    {
      id: "task_completion",
      name: "Task Completion",
      weight: 1,
      scale: {
        type: "likert",
        points: 5,
        labels: {
          "1": "bad",
          "5": "good",
        },
      },
      judgePrompt: "Score it.",
    },
  ],
  metaPrompt: "Judge it.",
};

function writeMinimalSuite(root: string): string {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  // The server reads the suite directory at startup but does not require any
  // entries for the human-scoring API surface.
  writeFileSync(join(data, ".keep"), "", "utf8");
  return data;
}

function seedScoredScenarios(dbPath: string, count: number): string[] {
  const dbUrl = `sqlite:///${dbPath}`;
  initDb(dbUrl);
  const ids: string[] = [];
  const database = new Database(dbPath);
  try {
    for (let index = 0; index < count; index += 1) {
      const runId = `run-${index}`;
      ids.push(runId);
      database
        .query(
          `insert into runs (
            id, status, passed, exit_code, preset, suite_fingerprint, started_at,
            updated_at, completed_at, scenario_total, scenario_passed_count,
            scenario_failed_count, scenario_errored_count
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          "completed",
          1,
          0,
          "support",
          "fingerprint",
          `2026-04-17T10:0${index}:00.000Z`,
          `2026-04-17T10:0${index}:10.000Z`,
          `2026-04-17T10:0${index}:10.000Z`,
          1,
          1,
          0,
          0,
        );
      database
        .query(
          `insert into scenario_runs (
            run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
            rubric_snapshot_json, status, passed, overall_score, pass_threshold,
            turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
            started_at, updated_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          0,
          `scenario-${index}`,
          `Scenario ${index}`,
          "analyst",
          "support",
          JSON.stringify(RUBRIC_SNAPSHOT),
          "completed",
          1,
          0.9,
          0.7,
          2,
          1,
          0,
          0,
          `2026-04-17T10:0${index}:00.000Z`,
          `2026-04-17T10:0${index}:10.000Z`,
          `2026-04-17T10:0${index}:10.000Z`,
        );
      const scenarioRunId = Number(
        (
          database.query("select last_insert_rowid() as id").get() as {
            id: number;
          }
        ).id,
      );
      database
        .query(
          `insert into turns (
            scenario_run_id, turn_index, role, source, content, created_at
          ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scenarioRunId,
          0,
          "user",
          "user_exact",
          "say hello",
          "2026-04-17T10:00:01Z",
        );
      database
        .query(
          `insert into turns (
            scenario_run_id, turn_index, role, source, content, created_at
          ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scenarioRunId,
          1,
          "assistant",
          "target",
          "hello",
          "2026-04-17T10:00:02Z",
        );
    }
  } finally {
    database.close();
  }
  return ids;
}

describe("human scoring HTTP API", () => {
  const servers: StartedServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  async function start() {
    const root = makeTempDir("human-scoring-server");
    const data = writeMinimalSuite(root);
    const dbPath = join(root, "runs.sqlite3");
    const runIds = seedScoredScenarios(dbPath, 2);
    const server = await startAgentProbeServer(
      buildServerConfig({
        args: [
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--data",
          data,
          "--db",
          dbPath,
        ],
        env: {},
      }),
    );
    servers.push(server);
    return { server, runIds };
  }

  test("flow: list rubrics, fetch next, post score, drain queue", async () => {
    const { server } = await start();

    const list = (await (
      await fetch(`${server.url}/api/human-scoring/rubrics`)
    ).json()) as RubricsResponse;
    expect(list.rubrics).toHaveLength(1);
    expect(list.rubrics[0]?.rubricId).toBe("support");
    expect(list.rubrics[0]?.totalScenarios).toBe(2);
    expect(list.rubrics[0]?.dimensions[0]?.unscored).toBe(2);

    const first = (await (
      await fetch(
        `${server.url}/api/human-scoring/next?rubric_id=support&dimension_id=task_completion`,
      )
    ).json()) as NextResponse;
    expect(first.item).not.toBeNull();
    expect(first.item?.remaining).toBe(2);
    expect(first.item?.turns?.length ?? 0).toBeGreaterThan(0);

    const post1 = await fetch(`${server.url}/api/human-scoring/scores`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario_run_id: first.item?.scenarioRunId,
        rubric_id: "support",
        dimension_id: "task_completion",
        raw_score: 4,
      }),
    });
    expect(post1.ok).toBe(true);
    const body1 = (await post1.json()) as ScoreResponse;
    expect(body1.ok).toBe(true);
    expect(body1.next).not.toBeNull();
    expect(body1.next?.scenarioRunId).not.toBe(first.item?.scenarioRunId);

    const post2 = await fetch(`${server.url}/api/human-scoring/scores`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario_run_id: body1.next?.scenarioRunId,
        rubric_id: "support",
        dimension_id: "task_completion",
        raw_score: 3,
      }),
    });
    const body2 = (await post2.json()) as ScoreResponse;
    expect(body2.ok).toBe(true);
    expect(body2.next).toBeNull();

    const finalList = (await (
      await fetch(`${server.url}/api/human-scoring/rubrics`)
    ).json()) as RubricsResponse;
    expect(finalList.rubrics[0]?.dimensions[0]?.unscored).toBe(0);
  });

  test("rejects raw_score outside the rubric scale", async () => {
    const { server } = await start();
    const next = (await (
      await fetch(
        `${server.url}/api/human-scoring/next?rubric_id=support&dimension_id=task_completion`,
      )
    ).json()) as NextResponse;
    expect(next.item).not.toBeNull();

    const response = await fetch(`${server.url}/api/human-scoring/scores`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario_run_id: next.item?.scenarioRunId,
        rubric_id: "support",
        dimension_id: "task_completion",
        raw_score: 99,
      }),
    });
    expect(response.status).toBe(400);
  });

  test("rejects missing query parameters on /api/human-scoring/next", async () => {
    const { server } = await start();
    const response = await fetch(`${server.url}/api/human-scoring/next`);
    expect(response.status).toBe(400);
  });
});
