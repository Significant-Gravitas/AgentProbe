import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ASSISTANT_REPLIES,
  cleanupWorkspace,
  createWorkspace,
  type E2EWorkspace,
  FakeAutogptBackend,
  readOpenAiLog,
  runAgentprobe,
} from "./support.ts";

const REFUND_SCENARIO = "refund-smoke";
const LOOKUP_TOOL_ARGS = { order_id: "R-100" };
const LOOKUP_TOOL_OUTPUT = {
  order_id: "R-100",
  status: "delivered",
  days_since_purchase: 12,
};

function buildJudgeOrderRules() {
  return {
    rules: [
      {
        name: "refund-scripted-turn",
        kind: "persona_step" as const,
        inputContains: [
          "Ask whether you can still get a refund for order R-100.",
          "A response is required for this scripted turn.",
        ],
        output: {
          message: "Can I still get a refund for order R-100?",
        },
      },
      {
        name: "refund-follow-up-complete",
        kind: "persona_step" as const,
        inputContains: [
          ASSISTANT_REPLIES[REFUND_SCENARIO] ?? "",
          "Decide whether the persona would continue",
        ],
        output: { status: "completed" },
      },
      {
        name: "refund-judge",
        kind: "rubric_score" as const,
        inputContains: [ASSISTANT_REPLIES[REFUND_SCENARIO] ?? ""],
        output: {
          dimensions: {
            task_completion: {
              reasoning: "Tool outputs were consulted before replying.",
              evidence: ["Saw the order lookup tool call."],
              score: 5,
            },
          },
          overall_notes: "Tool call first, then reply.",
          pass: true,
        },
      },
    ],
  };
}

describe("judge transcript ordering", () => {
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

  test("judge input places assistant tool calls before the assistant reply", async () => {
    backend.registerToolEvents(REFUND_SCENARIO, [
      {
        type: "tool-input-available",
        toolCallId: "tc-1",
        toolName: "lookup_order",
        input: LOOKUP_TOOL_ARGS,
      },
      {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: LOOKUP_TOOL_OUTPUT,
      },
    ]);
    await workspace.writeOpenAiScript(buildJudgeOrderRules());

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
        REFUND_SCENARIO,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`PASS ${REFUND_SCENARIO}`);

    const openAiLog = await readOpenAiLog(workspace.openAiLogPath);
    const judgeEntry = openAiLog.find((entry) => entry.kind === "rubric_score");
    expect(judgeEntry).toBeDefined();
    const judgeInput = judgeEntry?.input ?? "";

    const toolHeaderIndex = judgeInput.indexOf("Assistant Tool Calls");
    const toolCallLineIndex = judgeInput.indexOf("- lookup_order:");
    const toolOutputIndex = judgeInput.indexOf("Output:");
    const assistantTextIndex = judgeInput.indexOf(
      `Assistant: ${ASSISTANT_REPLIES[REFUND_SCENARIO]}`,
    );
    const userTurnIndex = judgeInput.indexOf(
      "User: Can I still get a refund for order R-100?",
    );

    expect(userTurnIndex).toBeGreaterThanOrEqual(0);
    expect(toolHeaderIndex).toBeGreaterThan(userTurnIndex);
    expect(toolCallLineIndex).toBeGreaterThan(toolHeaderIndex);
    expect(toolOutputIndex).toBeGreaterThan(toolCallLineIndex);
    expect(assistantTextIndex).toBeGreaterThan(toolOutputIndex);

    expect(judgeInput).toContain(JSON.stringify(LOOKUP_TOOL_ARGS));
    expect(judgeInput).toContain(JSON.stringify(LOOKUP_TOOL_OUTPUT));
  });

  test("judge input preserves multi-turn order with each turn's tool calls before its reply", async () => {
    backend.registerToolEvents(REFUND_SCENARIO, [
      {
        type: "tool-input-available",
        toolCallId: "tc-first",
        toolName: "lookup_order",
        input: LOOKUP_TOOL_ARGS,
      },
      {
        type: "tool-output-available",
        toolCallId: "tc-first",
        output: LOOKUP_TOOL_OUTPUT,
      },
    ]);

    const followUpMessage = "Can you double-check the refund window?";
    const followUpReply = ASSISTANT_REPLIES[REFUND_SCENARIO] ?? "";

    await workspace.writeOpenAiScript({
      rules: [
        {
          name: "refund-scripted-turn",
          kind: "persona_step",
          inputContains: [
            "Ask whether you can still get a refund for order R-100.",
            "A response is required for this scripted turn.",
          ],
          output: {
            message: "Can I still get a refund for order R-100?",
          },
        },
        {
          name: "refund-follow-up-continue",
          kind: "persona_step",
          inputContains: [
            followUpReply,
            "Decide whether the persona would continue",
          ],
          output: { status: "continue", message: followUpMessage },
        },
        {
          name: "refund-follow-up-complete",
          kind: "persona_step",
          inputContains: [
            followUpMessage,
            "Decide whether the persona would continue",
          ],
          output: { status: "completed" },
        },
        {
          name: "refund-judge",
          kind: "rubric_score",
          inputContains: [followUpMessage],
          output: {
            dimensions: {
              task_completion: {
                reasoning: "Both turns have tool calls preceding the reply.",
                evidence: ["Saw the order lookup tool call twice."],
                score: 5,
              },
            },
            overall_notes: "Transcript order is correct.",
            pass: true,
          },
        },
      ],
    });

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
        REFUND_SCENARIO,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);

    const openAiLog = await readOpenAiLog(workspace.openAiLogPath);
    const judgeEntry = openAiLog.find((entry) => entry.kind === "rubric_score");
    expect(judgeEntry).toBeDefined();
    const judgeInput = judgeEntry?.input ?? "";

    const userOneIndex = judgeInput.indexOf(
      "User: Can I still get a refund for order R-100?",
    );
    const firstToolHeaderIndex = judgeInput.indexOf("Assistant Tool Calls");
    const firstAssistantReplyIndex = judgeInput.indexOf(
      `Assistant: ${followUpReply}`,
    );
    const userTwoIndex = judgeInput.indexOf(`User: ${followUpMessage}`);
    const secondToolHeaderIndex = judgeInput.indexOf(
      "Assistant Tool Calls",
      firstAssistantReplyIndex + 1,
    );
    const secondAssistantReplyIndex = judgeInput.indexOf(
      `Assistant: ${followUpReply}`,
      firstAssistantReplyIndex + 1,
    );

    expect(userOneIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolHeaderIndex).toBeGreaterThan(userOneIndex);
    expect(firstAssistantReplyIndex).toBeGreaterThan(firstToolHeaderIndex);
    expect(userTwoIndex).toBeGreaterThan(firstAssistantReplyIndex);
    expect(secondToolHeaderIndex).toBeGreaterThan(userTwoIndex);
    expect(secondAssistantReplyIndex).toBeGreaterThan(secondToolHeaderIndex);
  });

  test("judge input omits the tool-calls header when a turn produced no tools", async () => {
    await workspace.writeOpenAiScript(buildJudgeOrderRules());

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
        REFUND_SCENARIO,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);

    const openAiLog = await readOpenAiLog(workspace.openAiLogPath);
    const judgeEntry = openAiLog.find((entry) => entry.kind === "rubric_score");
    expect(judgeEntry).toBeDefined();
    const judgeInput = judgeEntry?.input ?? "";

    expect(judgeInput).not.toContain("Assistant Tool Calls");
    expect(judgeInput).toContain(
      `Assistant: ${ASSISTANT_REPLIES[REFUND_SCENARIO]}`,
    );
  });
});
