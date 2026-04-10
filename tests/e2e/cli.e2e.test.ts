import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ASSISTANT_REPLIES,
  buildOpenAiRules,
  cleanupWorkspace,
  createWorkspace,
  type E2EWorkspace,
  FakeAutogptBackend,
  queryRows,
  readOpenAiLog,
  runAgentprobe,
  scenarioIds,
} from "./support.ts";

describe("bun e2e baseline for the typescript cli", () => {
  let backend: FakeAutogptBackend;
  let workspace: E2EWorkspace;

  beforeEach(async () => {
    backend = await FakeAutogptBackend.start();
    workspace = await createWorkspace();
  });

  afterEach(async () => {
    await backend.stop();
    await cleanupWorkspace(workspace);
  });

  test("validate reports the fixture yaml suite", async () => {
    const result = await runAgentprobe(
      ["validate", "--data-path", workspace.suiteDir],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Processed YAML files:");
    expect(result.stdout).toContain("endpoints.yaml");
    expect(result.stdout).toContain("personas.yaml");
    expect(result.stdout).toContain("rubric.yaml");
    expect(result.stdout).toContain("scenarios.yaml");
  });

  test("run records the suite in sqlite and report renders both explicit and discovered outputs", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const runResult = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(runResult.exitCode).toBe(0);
    expect(runResult.stderr).toContain("Running 2 scenarios...");
    expect(runResult.stderr).toContain("RUN refund-smoke");
    expect(runResult.stderr).toContain("RUN billing-followup");
    expect(runResult.stdout).toContain("PASS refund-smoke score=1.00");
    expect(runResult.stdout).toContain("PASS billing-followup score=0.80");
    expect(runResult.stdout).toContain("Summary: 2 passed, 0 failed, 2 total");

    expect(existsSync(workspace.dbPath)).toBe(true);

    const runRows = queryRows(
      workspace.dbPath,
      [
        "id",
        "status",
        "passed",
        "exit_code",
        "scenario_total",
        "scenario_passed_count",
        "selected_scenario_ids_json",
      ],
      "runs",
      "started_at DESC",
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe("completed");
    expect(runRows[0]?.passed).toBe(1);
    expect(runRows[0]?.exit_code).toBe(0);
    expect(runRows[0]?.scenario_total).toBe(2);
    expect(runRows[0]?.scenario_passed_count).toBe(2);
    expect(runRows[0]?.selected_scenario_ids_json).toEqual(scenarioIds);

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["ordinal", "scenario_id", "status", "passed", "overall_score"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toEqual([
      {
        ordinal: 0,
        scenario_id: "refund-smoke",
        status: "completed",
        passed: 1,
        overall_score: 1,
      },
      {
        ordinal: 1,
        scenario_id: "billing-followup",
        status: "completed",
        passed: 1,
        overall_score: 0.8,
      },
    ]);

    expect(backend.countByKind("register_user")).toBe(2);
    expect(backend.countByKind("create_session")).toBe(2);
    expect(backend.countByKind("send_message")).toBe(2);

    const openAiLog = await readOpenAiLog(workspace.openAiLogPath);
    expect(openAiLog.map((entry) => entry.kind)).toEqual([
      "persona_step",
      "persona_step",
      "rubric_score",
      "persona_step",
      "persona_step",
      "rubric_score",
    ]);

    const explicitReport = await runAgentprobe(
      [
        "report",
        "--db-path",
        workspace.dbPath,
        "--output",
        workspace.explicitReportPath,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(explicitReport.exitCode).toBe(0);
    expect(explicitReport.stdout.trim()).toBe(workspace.explicitReportPath);

    const explicitHtml = await readFile(workspace.explicitReportPath, "utf8");
    expect(explicitHtml).toContain("Refund smoke question");
    expect(explicitHtml).toContain(ASSISTANT_REPLIES["refund-smoke"]);
    expect(explicitHtml).toContain("Clear refund guidance.");

    const discoveredReport = await runAgentprobe(["report"], {
      backendUrl: backend.url,
      cwd: workspace.suiteDir,
      suiteDir: workspace.suiteDir,
      workspace,
    });

    const reportPath = join(
      workspace.suiteDir,
      `agentprobe-report-${runRows[0]?.id}.html`,
    );
    expect(discoveredReport.exitCode).toBe(0);
    expect(discoveredReport.stdout.trim()).toBe(reportPath);
    expect(existsSync(reportPath)).toBe(true);

    const discoveredHtml = await readFile(reportPath, "utf8");
    expect(discoveredHtml).toContain("Billing escalation follow-up");
    expect(discoveredHtml).toContain(ASSISTANT_REPLIES["billing-followup"]);
    expect(discoveredHtml).toContain("Solid escalation guidance.");
  });

  test("scenario-id filtering runs only the requested scenario", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario-id",
        "billing-followup",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refund-smoke");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual([
      "billing-followup",
    ]);
    expect(backend.countByKind("send_message")).toBe(1);
  });

  test("tag filtering runs only matching scenarios", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--tags",
        "smoke",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=1.00");
    expect(result.stdout).not.toContain("billing-followup");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual(["refund-smoke"]);
    expect(backend.countByKind("send_message")).toBe(1);
  });

  test("no-match filtering returns a configuration error without target traffic", async () => {
    await workspace.writeOpenAiScript({ rules: [] });

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--tags",
        "does-not-exist",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Configuration error: No scenarios matched the requested filters.",
    );
    expect(backend.requestLog).toHaveLength(0);
    expect(await readOpenAiLog(workspace.openAiLogPath)).toHaveLength(0);
  });

  test("dry-run avoids backend and openai calls while still recording the run", async () => {
    await workspace.writeOpenAiScript({ rules: [] });

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--dry-run",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=0.00");
    expect(result.stdout).toContain("PASS billing-followup score=0.00");
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed, 2 total");
    expect(backend.requestLog).toHaveLength(0);
    expect(await readOpenAiLog(workspace.openAiLogPath)).toHaveLength(0);

    const runRows = queryRows(
      workspace.dbPath,
      [
        "status",
        "scenario_total",
        "scenario_passed_count",
        "selected_scenario_ids_json",
      ],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]).toEqual({
      status: "completed",
      scenario_total: 0,
      scenario_passed_count: 0,
      selected_scenario_ids_json: scenarioIds,
    });

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["scenario_id"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toHaveLength(0);
  });

  test("parallel preserves result ordering while overlapping target requests", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());
    backend.enableSendBarrier(2);

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--parallel",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=1.00");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");
    expect(backend.maxConcurrentSends).toBeGreaterThanOrEqual(2);

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["ordinal", "scenario_id"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toEqual([
      { ordinal: 0, scenario_id: "refund-smoke" },
      { ordinal: 1, scenario_id: "billing-followup" },
    ]);
  });
});
