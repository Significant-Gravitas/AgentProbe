import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  runScenario,
  runSuite,
} from "../../src/domains/evaluation/run-suite.ts";
import type {
  Endpoints,
  RunProgressEvent,
  Scenario,
  ScenarioDefaults,
} from "../../src/shared/types/contracts.ts";
import {
  adapterReply,
  asResponsesClient,
  buildPersona,
  buildPersonaStep,
  buildRubric,
  buildScenario,
  buildScore,
  FakeAdapter,
  FakeResponsesClient,
  makeTempDir,
  sendMessages,
} from "./support.ts";

describe("runner", () => {
  test("runScenario renders injected data and uses persona generation", async () => {
    const adapter = new FakeAdapter([
      adapterReply("What is your timing constraint?"),
      adapterReply("I found a flight arriving at 11:15 AM."),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Please change booking FLT-29481."),
      buildPersonaStep("continue", "I need to land before noon."),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        turns: [
          {
            role: "user",
            content: "Please change booking {{ booking_id }}.",
            useExactMessage: false,
          },
          { role: "user", content: undefined, useExactMessage: false },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        defaults: { maxTurns: 2 },
        client: asResponsesClient(client) as never,
      },
    );

    expect(sendMessages(adapter)).toEqual([
      "Please change booking FLT-29481.",
      "I need to land before noon.",
    ]);
    expect(client.calls[0]?.input).toContain(
      "Please change booking FLT-29481.",
    );
    expect(result.transcript.map((turn) => turn.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("runScenario respects exact messages and checkpoint failures", async () => {
    const adapter = new FakeAdapter([
      adapterReply("Tracking number ZX9 is on the way.", {
        toolCalls: [{ name: "lookup_order", args: { order_id: "123" }, order: 1 }],
      }),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        turns: [
          {
            role: "user",
            content: "Where is order 123?",
            useExactMessage: true,
          },
          {
            role: "checkpoint",
            assertions: [
              {
                toolCalled: "lookup_order",
                withArgs: { order_id: "123" },
                responseContainsAny: [],
                responseMentions: "ZX9",
              },
            ],
          },
          {
            role: "checkpoint",
            assertions: [
              {
                responseContainsAny: [],
                responseMentions: "refund",
              },
            ],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        client: asResponsesClient(client) as never,
      },
    );

    expect(sendMessages(adapter)).toEqual(["Where is order 123?"]);
    expect(result.checkpoints.map((checkpoint) => checkpoint.passed)).toEqual([
      true,
      false,
    ]);
    expect(result.passed).toBe(true);
  });

  test("runScenario includes tool outputs in the judge transcript", async () => {
    const adapter = new FakeAdapter([
      adapterReply("Tracking number ZX9 is on the way.", {
        toolCalls: [
          {
            name: "lookup_order",
            args: { order_id: "123" },
            order: 1,
            raw: {
              output: { status: "found", tracking_number: "ZX9" },
            },
          },
        ],
      }),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    await runScenario(
      adapter,
      buildScenario({
        turns: [
          {
            role: "user",
            content: "Where is order 123?",
            useExactMessage: true,
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        client: asResponsesClient(client) as never,
      },
    );

    expect(client.calls.at(-1)?.input).toContain(
      '- lookup_order: {"order_id":"123"}',
    );
    expect(client.calls.at(-1)?.input).toContain(
      'Output: {"status":"found","tracking_number":"ZX9"}',
    );
  });

  test("runScenario exposes rendered turns to rubric templates and continues until stalled", async () => {
    const adapter = new FakeAdapter([
      adapterReply("What timing works?"),
      adapterReply("I can get you in before noon."),
      adapterReply("There is a 6:45 AM option."),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Please change booking FLT-29481."),
      buildPersonaStep("continue", "I need to land before noon."),
      buildPersonaStep("continue", "What options are available?"),
      buildPersonaStep("stalled"),
      buildScore(),
    ]);
    const rubric = buildRubric({
      dimensions: [
        {
          ...buildRubric().dimensions[0],
          judgePrompt: "User asked: {{ turns[0].content }}",
        },
      ],
    });

    await runScenario(
      adapter,
      buildScenario({
        turns: [
          {
            role: "user",
            content: "Please change booking {{ booking_id }}.",
            useExactMessage: false,
          },
          {
            role: "user",
            content: "Mention that arrival must be before noon.",
            useExactMessage: false,
          },
        ],
      }),
      buildPersona(),
      rubric,
      {
        defaults: { maxTurns: 3 },
        client: asResponsesClient(client) as never,
      },
    );

    expect(sendMessages(adapter)).toEqual([
      "Please change booking FLT-29481.",
      "I need to land before noon.",
      "What options are available?",
    ]);
    expect(client.calls.at(-1)?.instructions).toContain(
      "User asked: Please change booking FLT-29481.",
    );
  });

  test("runScenario judges after max-turn overflow", async () => {
    const adapter = new FakeAdapter([adapterReply("First reply.")]);
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "First turn"),
      buildPersonaStep("continue", "Second turn"),
      buildScore({ score: 2 }),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        turns: [{ role: "user", content: "First turn", useExactMessage: false }],
      }),
      buildPersona(),
      buildRubric(),
      {
        defaults: { maxTurns: 1 },
        client: asResponsesClient(client) as never,
      },
    );

    expect(sendMessages(adapter)).toEqual(["First turn"]);
    expect(result.passed).toBe(false);
    expect(result.overallScore).toBeCloseTo(0.4);
    expect(client.calls.at(-1)?.input).toContain(
      "Scenario flight-rebooking exceeded max_turns=1.",
    );
    expect(client.calls.at(-1)?.input).toContain("Assistant: First reply.");
  });

  test("runScenario handles multi-session resets", async () => {
    const adapter = new FakeAdapter(
      [adapterReply("Stored it."), adapterReply("Sarah handles client proposals.")],
      { session_id: "session-1" },
    );
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Remember that Sarah should be CC'd."),
      buildPersonaStep("completed"),
      buildPersonaStep("continue", "Who should I CC on outgoing client proposals?"),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        id: "multi-session-memory",
        name: "Multi Session Memory",
        turns: [],
        sessions: [
          {
            id: "seed",
            timeOffset: "0h",
            reset: "none",
            turns: [
              {
                role: "user",
                content: "Remember that Sarah should be CC'd.",
                useExactMessage: false,
              },
            ],
          },
          {
            id: "probe",
            timeOffset: "48h",
            reset: "fresh_agent",
            turns: [
              {
                role: "user",
                content: "Who should I CC on outgoing client proposals?",
                useExactMessage: false,
              },
            ],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        defaults: { maxTurns: 2 },
        client: asResponsesClient(client) as never,
        adapterFactory: () => adapter,
      },
    );

    expect(adapter.healthCalls).toHaveLength(2);
    expect(adapter.openCalls).toHaveLength(2);
    expect(result.transcript.some((turn) => turn.content?.includes("Session boundary"))).toBe(
      true,
    );
  });

  test("runSuite filters tags, merges directories, emits progress, and preserves parallel order", async () => {
    const root = makeTempDir("run-suite");
    mkdirSync(root, { recursive: true });
    const endpointPath = join(root, "endpoint.yaml");
    const personasPath = join(root, "personas.yaml");
    const rubricPath = join(root, "rubric.yaml");
    const scenariosDir = join(root, "scenarios");
    mkdirSync(scenariosDir, { recursive: true });

    writeFileSync(
      endpointPath,
      [
        "transport: http",
        "connection:",
        "  base_url: http://example.test",
        "request:",
        "  method: POST",
        '  url: "{{ base_url }}/chat"',
        "response:",
        "  format: text",
        '  content_path: "$"',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      personasPath,
      [
        "personas:",
        "  - id: business-traveler",
        "    name: Business Traveler",
        "    demographics:",
        "      role: business customer",
        "      tech_literacy: high",
        "      domain_expertise: intermediate",
        "      language_style: terse",
        "    personality:",
        "      patience: 2",
        "      assertiveness: 4",
        "      detail_orientation: 5",
        "      cooperativeness: 4",
        "      emotional_intensity: 2",
        "    behavior:",
        "      opening_style: Be direct.",
        "      follow_up_style: Answer follow-up questions directly.",
        "      escalation_triggers: []",
        "      topic_drift: none",
        "      clarification_compliance: high",
        "    system_prompt: You are a direct business traveler.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      rubricPath,
      [
        "judge:",
        "  provider: openai",
        "  model: anthropic/claude-opus-4.6",
        "  temperature: 0.0",
        "  max_tokens: 500",
        "rubrics:",
        "  - id: customer-support",
        "    name: Customer Support",
        "    pass_threshold: 0.7",
        "    meta_prompt: Judge behavior.",
        "    dimensions:",
        "      - id: task_completion",
        "        name: Task Completion",
        "        weight: 1.0",
        "        scale:",
        "          type: likert",
        "          points: 5",
        "          labels:",
        "            1: bad",
        "            5: good",
        "        judge_prompt: Check task completion.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(scenariosDir, "smoke.yaml"),
      [
        "defaults:",
        "  max_turns: 1",
        "scenarios:",
        "  - id: smoke-scenario",
        "    name: Smoke",
        "    tags: [smoke]",
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        "        content: Hello smoke",
        "    expectations:",
        "      expected_behavior: Help.",
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(scenariosDir, "regression.yaml"),
      [
        "scenarios:",
        "  - id: regression-scenario",
        "    name: Regression",
        "    tags: [regression]",
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        "        content: Hello regression",
        "    expectations:",
        "      expected_behavior: Help.",
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const filteredClient = new FakeResponsesClient([
      buildPersonaStep("continue", "Hello smoke"),
      buildPersonaStep("completed"),
      buildScore(),
    ]);
    const filtered = await runSuite({
      endpoint: endpointPath,
      scenarios: scenariosDir,
      personas: personasPath,
      rubric: rubricPath,
      tags: "smoke",
      adapterFactory: (_endpoint: Endpoints) =>
        new FakeAdapter([adapterReply("Handled.")]),
      client: asResponsesClient(filteredClient) as never,
    });

    expect(filtered.exitCode).toBe(0);
    expect(filtered.results.map((item) => item.scenarioId)).toEqual([
      "smoke-scenario",
    ]);

    const events: RunProgressEvent[] = [];
    const parallel = await runSuite({
      endpoint: endpointPath,
      scenarios: scenariosDir,
      personas: personasPath,
      rubric: rubricPath,
      client: asResponsesClient(new FakeResponsesClient([])) as never,
      adapterFactory: (_endpoint: Endpoints) =>
        new FakeAdapter([adapterReply("Handled.")]),
      progressCallback: (event) => {
        events.push(event);
      },
      parallel: true,
      dryRun: true,
    });

    expect(parallel.exitCode).toBe(0);
    expect(parallel.results.map((item) => item.scenarioId)).toEqual([
      "regression-scenario",
      "smoke-scenario",
    ]);
    expect(events[0]).toMatchObject({
      kind: "suite_started",
      scenarioTotal: 2,
    });
    expect(events.filter((event) => event.kind === "scenario_started")).toHaveLength(
      2,
    );
    expect(events.filter((event) => event.kind === "scenario_finished")).toHaveLength(
      2,
    );
  });
});
