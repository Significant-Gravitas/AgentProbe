/**
 * One-off retargeting script for /score test data.
 *
 * The merged rubric.yaml replaced `operations-automation` with `product`. The
 * existing 83 completed scenario_runs still carry the old rubric_id and a
 * judge_dimension_scores set keyed on (`task_completion`, `hallucination`,
 * `tool_accuracy`, `response_quality`). This walks the SQLite db and:
 *
 *   1. Rewrites rubric_id → "product" on every scenario_run row.
 *   2. Replaces rubric_snapshot_json with a snapshot of the new product rubric
 *      built directly from data/rubric.yaml (so the score page reads the new
 *      dimension labels and scales).
 *   3. Deletes the existing judge_dimension_scores and inserts fresh rows for
 *      the 6 new dimensions with random raw scores.
 *   4. Clears human_dimension_scores so nothing dangles on a deleted dimension.
 *   5. Recomputes scenario_runs.overall_score as a weighted average of the new
 *      normalized scores.
 *
 * This intentionally produces meaningless scores — the user explicitly only
 * wants test data, not correctness.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const DB_PATH = resolve(".agentprobe/runs.sqlite3");
const RUBRIC_PATH = resolve("data/rubric.yaml");
const TARGET_RUBRIC_ID = "product";

type YamlRubric = {
  id: string;
  name: string;
  description?: string;
  pass_threshold: number;
  dimensions: Array<{
    id: string;
    name: string;
    weight: number;
    scale: {
      type: string;
      points?: number;
      labels?: Record<string, string>;
    };
    judge_prompt: string;
  }>;
  meta_prompt?: string;
};

type RubricsYaml = {
  judge?: unknown;
  rubrics: YamlRubric[];
};

function rubricSnapshotFromYaml(yaml: YamlRubric): unknown {
  return {
    id: yaml.id,
    name: yaml.name,
    description: yaml.description ?? null,
    passThreshold: yaml.pass_threshold,
    metaPrompt: yaml.meta_prompt ?? "",
    dimensions: yaml.dimensions.map((dim) => ({
      id: dim.id,
      name: dim.name,
      weight: dim.weight,
      scale: {
        type: dim.scale.type,
        points: dim.scale.points,
        labels: dim.scale.labels ?? {},
      },
      judgePrompt: dim.judge_prompt,
    })),
  };
}

function randomRawScore(scaleType: string, scalePoints: number): number {
  if (scaleType === "binary") {
    return Math.random() < 0.5 ? 0 : 1;
  }
  // Bias slightly toward 3-4 so the data isn't all extremes.
  const r = Math.random();
  if (r < 0.1) return 1;
  if (r < 0.25) return 2;
  if (r < 0.55) return 3;
  if (r < 0.85) return 4;
  return Math.min(scalePoints, 5);
}

function main(): void {
  const yaml = parse(readFileSync(RUBRIC_PATH, "utf8")) as RubricsYaml;
  const target = yaml.rubrics.find((r) => r.id === TARGET_RUBRIC_ID);
  if (!target) {
    throw new Error(
      `Rubric "${TARGET_RUBRIC_ID}" not found in ${RUBRIC_PATH}.`,
    );
  }

  const snapshot = rubricSnapshotFromYaml(target);
  const snapshotJson = JSON.stringify(snapshot);
  const db = new Database(DB_PATH);
  db.exec("pragma foreign_keys = on;");

  const tx = db.transaction(() => {
    const scenarioRuns = db
      .query(
        "select id from scenario_runs where status = 'completed' order by id",
      )
      .all() as Array<{ id: number }>;
    console.log(`scenario_runs to retarget: ${scenarioRuns.length}`);

    const setRubric = db.query(
      `update scenario_runs
         set rubric_id = ?, rubric_snapshot_json = ?, pass_threshold = ?,
             updated_at = ?
       where id = ?`,
    );
    const wipeJudge = db.query(
      "delete from judge_dimension_scores where scenario_run_id = ?",
    );
    const wipeHuman = db.query(
      "delete from human_dimension_scores where scenario_run_id = ?",
    );
    const insertJudge = db.query(
      `insert into judge_dimension_scores (
         scenario_run_id, dimension_id, dimension_name, weight, scale_type,
         scale_points, raw_score, normalized_score, reasoning, evidence_json,
         created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const setOverall = db.query(
      "update scenario_runs set overall_score = ? where id = ?",
    );

    const now = new Date().toISOString();
    for (const row of scenarioRuns) {
      setRubric.run(
        TARGET_RUBRIC_ID,
        snapshotJson,
        target.pass_threshold,
        now,
        row.id,
      );
      wipeJudge.run(row.id);
      wipeHuman.run(row.id);

      let weightedSum = 0;
      let weightTotal = 0;
      for (const dim of target.dimensions) {
        const points = dim.scale.points ?? 5;
        const raw = randomRawScore(dim.scale.type, points);
        const normalized =
          dim.scale.type === "binary" ? raw : raw / Math.max(points, 1);
        const reasoning = `Synthetic placeholder score for ${dim.id} (test data).`;
        insertJudge.run(
          row.id,
          dim.id,
          dim.name,
          dim.weight,
          dim.scale.type,
          dim.scale.type === "binary" ? null : points,
          raw,
          normalized,
          reasoning,
          JSON.stringify([]),
          now,
        );
        weightedSum += normalized * dim.weight;
        weightTotal += dim.weight;
      }
      const overall = weightTotal > 0 ? weightedSum / weightTotal : 0;
      setOverall.run(overall, row.id);
    }
  });

  tx();
  db.close();
  console.log(
    `done. rubric_id=${TARGET_RUBRIC_ID}, dimensions=${target.dimensions
      .map((d) => d.id)
      .join(", ")}`,
  );
}

main();
