import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  renderRunReport,
  writeRunReport,
} from "../../src/domains/reporting/render-report.ts";
import {
  DEFAULT_DB_DIRNAME,
  DEFAULT_DB_FILENAME,
  initDb,
} from "../../src/providers/persistence/sqlite-run-history.ts";
import type { RunRecord } from "../../src/shared/types/contracts.ts";
import { makeTempDir } from "./support.ts";

function buildRun(): RunRecord {
  return {
    runId: "run-12345678",
    status: "completed",
    passed: true,
    exitCode: 0,
    preset: "autogpt",
    startedAt: "2026-03-24T15:00:00+00:00",
    completedAt: "2026-03-24T15:02:00+00:00",
    suiteFingerprint: "suite-123",
    finalError: null,
    sourcePaths: {
      endpoint: "/tmp/endpoint.yaml",
      scenarios: "/tmp/scenarios.yaml",
      personas: "/tmp/personas.yaml",
      rubric: "/tmp/rubric.yaml",
    },
    endpointSnapshot: { transport: "http", preset: "autogpt" },
    aggregateCounts: {
      scenarioTotal: 1,
      scenarioPassedCount: 1,
      scenarioFailedCount: 0,
      scenarioHarnessFailedCount: 0,
      scenarioErroredCount: 0,
    },
    scenarios: [
      {
        scenarioRunId: 1,
        ordinal: 0,
        scenarioId: "refund-policy-basic",
        scenarioName: "Basic refund policy question",
        personaId: "frustrated-customer",
        rubricId: "customer-support",
        userId: "user-123",
        tags: ["smoke", "support"],
        status: "completed",
        passed: true,
        overallScore: 0.8,
        passThreshold: 0.7,
        judge: {
          provider: "openai",
          model: "anthropic/claude-opus-4.6",
          temperature: 0,
          maxTokens: 4096,
          overallNotes: "Clear and empathetic resolution.",
          output: {
            dimensions: {
              task_completion: {
                reasoning: "The assistant explained the refund path.",
                evidence: ["Mentioned the 30-day policy."],
                score: 4,
              },
            },
            overall_notes: "Clear and empathetic resolution.",
            pass: true,
          },
        },
        counts: {
          turnCount: 3,
          assistantTurnCount: 1,
          toolCallCount: 1,
          checkpointCount: 1,
        },
        expectations: {
          expected_behavior: "Acknowledge the issue and explain next steps.",
        },
        turns: [
          {
            turn_index: 0,
            role: "user",
            source: "scenario",
            content: "I bought a laptop 3 weeks ago and it is already broken.",
            created_at: "2026-03-24T15:00:01+00:00",
            usage: null,
          },
          {
            turn_index: 1,
            role: "system",
            source: "session_boundary",
            content:
              "--- Session boundary: session_id: followup reset_policy: fresh_agent time_offset: 48h user_id: user-123 ---",
            created_at: "2026-03-24T15:00:03+00:00",
            usage: null,
          },
          {
            turn_index: 2,
            role: "assistant",
            source: "assistant",
            content:
              "You are still within the 30-day return window, and I can help with the refund process.",
            created_at: "2026-03-24T15:00:05+00:00",
            usage: { input_tokens: 11, output_tokens: 22 },
          },
        ],
        toolCalls: [
          {
            turn_index: 2,
            call_order: 1,
            name: "lookup_order",
            args: { order_id: "123" },
            raw: { name: "lookup_order" },
          },
        ],
        checkpoints: [
          {
            checkpoint_index: 0,
            preceding_turn_index: 2,
            passed: true,
            failures: [],
            assertions: [{ response_mentions: "30-day return policy" }],
          },
        ],
        targetEvents: [
          {
            turn_index: 2,
            exchange_index: 0,
            raw_exchange: {
              request: {
                url: "http://localhost:8006/api/chat/sessions",
              },
              response: { status_code: 200 },
            },
            latency_ms: 12.4,
            usage: { output_tokens: 22 },
          },
        ],
        judgeDimensionScores: [
          {
            dimension_id: "task_completion",
            dimension_name: "Task Completion",
            weight: 0.3,
            scale_type: "likert",
            scale_points: 5,
            raw_score: 4,
            normalized_score: 0.8,
            reasoning: "The assistant addressed the refund request directly.",
            evidence: ["Explained the 30-day refund window."],
          },
        ],
        error: null,
        startedAt: "2026-03-24T15:00:00+00:00",
        completedAt: "2026-03-24T15:01:00+00:00",
      },
    ],
    selectedScenarioIds: null,
  };
}

describe("reporting", () => {
  test("renderRunReport contains conversation and rubric breakdown", () => {
    const html = renderRunReport(buildRun());

    expect(html).toContain("tailwindcss.com");
    expect(html).toContain("Basic refund policy question");
    expect(html).toContain("30-day return window");
    expect(html).toContain('id="scenario-search"');
    expect(html).toContain('id="scenario-tag-filter"');
    expect(html).toContain('data-tab-button="conversation"');
    expect(html).toContain('data-tab-button="rubric"');
    expect(html).toContain("lookup_order");
    expect(html).toContain("Target Exchanges");
    expect(html).toContain("Checkpoints");
    expect(html).toContain("Endpoint Snapshot");
    expect(html).toContain("/tmp/endpoint.yaml");
    expect(html).toContain("&quot;transport&quot;: &quot;http&quot;");
    expect(html).toContain('data-open-tab="rubric"');
    expect(html).toContain("Task Completion");
    expect(html).toContain("user-123");
    expect(html).toContain("Session Boundary");
    expect(html).toContain("followup");
    expect(html).toContain(
      "The assistant addressed the refund request directly.",
    );
  });

  test("writeRunReport raises when no runs exist", () => {
    const searchRoot = join(makeTempDir("empty-report"), "missing");
    expect(() => writeRunReport({ searchRoot })).toThrow(
      /No recorded runs were found/,
    );
  });

  test("writeRunReport uses discovered databases", () => {
    const root = makeTempDir("report-discovery");
    const dbDir = join(root, "project", "data", DEFAULT_DB_DIRNAME);
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, DEFAULT_DB_FILENAME);
    initDb(`sqlite:///${dbPath}`);

    const reportPath = join(root, "report.html");
    const database = new Database(dbPath);
    try {
      database.run(
        `insert into runs (
          id, status, passed, exit_code, preset, started_at, updated_at,
          completed_at, suite_fingerprint, scenario_total, scenario_passed_count,
          scenario_failed_count, scenario_errored_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "run-12345678",
          "completed",
          1,
          0,
          "autogpt",
          "2026-03-24T15:00:00+00:00",
          "2026-03-24T15:02:00+00:00",
          "2026-03-24T15:02:00+00:00",
          "suite-123",
          0,
          0,
          0,
          0,
        ],
      );
    } finally {
      database.close();
    }

    const written = writeRunReport({
      outputPath: reportPath,
      searchRoot: root,
    });

    expect(written).toBe(reportPath);
    expect(Bun.file(reportPath).exists()).resolves.toBe(true);
  });
});
