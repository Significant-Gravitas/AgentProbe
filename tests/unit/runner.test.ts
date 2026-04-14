import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  runScenario,
  runSuite,
} from "../../src/domains/evaluation/run-suite.ts";
import { SqliteRunRecorder } from "../../src/providers/persistence/sqlite-run-history.ts";
import type {
  Endpoints,
  RunProgressEvent,
} from "../../src/shared/types/contracts.ts";
import {
  adapterReply,
  asResponsesClient,
  buildPersona,
  buildPersonaStep,
  buildRubric,
  buildScenario,
  buildScore,
  FailingAdapter,
  FakeAdapter,
  FakeResponsesClient,
  judgeInputText,
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
            attachments: [],
          },
          {
            role: "user",
            content: undefined,
            useExactMessage: false,
            attachments: [],
          },
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
        toolCalls: [
          { name: "lookup_order", args: { order_id: "123" }, order: 1 },
        ],
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
            attachments: [],
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
            attachments: [],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        client: asResponsesClient(client) as never,
      },
    );

    expect(judgeInputText(client.calls.at(-1))).toContain(
      '- lookup_order: {"order_id":"123"}',
    );
    expect(judgeInputText(client.calls.at(-1))).toContain(
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
            attachments: [],
          },
          {
            role: "user",
            content: "Mention that arrival must be before noon.",
            useExactMessage: false,
            attachments: [],
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
    expect(judgeInputText(client.calls.at(-1))).toContain(
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
        turns: [
          {
            role: "user",
            content: "First turn",
            useExactMessage: false,
            attachments: [],
          },
        ],
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
    expect(judgeInputText(client.calls.at(-1))).toContain(
      "Scenario flight-rebooking exceeded max_turns=1.",
    );
    expect(judgeInputText(client.calls.at(-1))).toContain(
      "Assistant: First reply.",
    );
  });

  test("runScenario handles multi-session resets", async () => {
    const adapter = new FakeAdapter(
      [
        adapterReply("Stored it."),
        adapterReply("Sarah handles client proposals."),
      ],
      { session_id: "session-1" },
    );
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Remember that Sarah should be CC'd."),
      buildPersonaStep("completed"),
      buildPersonaStep(
        "continue",
        "Who should I CC on outgoing client proposals?",
      ),
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
                attachments: [],
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
                attachments: [],
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
    expect(
      result.transcript.some((turn) =>
        turn.content?.includes("Session boundary"),
      ),
    ).toBe(true);
  });

  test("runScenario enforces response_must_not_contain assertions", async () => {
    const adapter = new FakeAdapter([
      adapterReply("Sorry, I cannot help with that refund today."),
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
            content: "Can you help with my refund?",
            useExactMessage: true,
            attachments: [],
          },
          {
            role: "checkpoint",
            assertions: [
              {
                responseContainsAny: [],
                responseMustNotContain: ["sorry"],
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

    expect(result.checkpoints[0]).toEqual({
      passed: false,
      failures: ['Response contains forbidden string: "sorry"'],
    });
  });

  test("runScenario carries pinned user_id into the adapter context and transcript boundaries", async () => {
    const adapter = new FakeAdapter(
      [adapterReply("Stored it."), adapterReply("Sarah handles proposals.")],
      { session_id: "session-1" },
    );
    const client = new FakeResponsesClient([
      buildPersonaStep("completed"),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        turns: [],
        sessions: [
          {
            id: "seed",
            timeOffset: "0h",
            reset: "none",
            turns: [
              {
                role: "user",
                content: "Remember Sarah handles proposals.",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
          {
            id: "probe",
            timeOffset: "48h",
            reset: "new",
            turns: [
              {
                role: "user",
                content: "Who handles proposals?",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        client: asResponsesClient(client) as never,
        userId: "user-123",
      },
    );

    expect(adapter.openCalls[0]?.user_id).toBe("user-123");
    expect(adapter.sendCalls[0]?.user_id).toBe("user-123");
    expect(result.userId).toBe("user-123");
    expect(
      result.transcript.find((turn) =>
        turn.content?.includes("Session boundary"),
      )?.content,
    ).toContain(
      "session_id: probe reset_policy: new time_offset: 48h user_id: user-123",
    );
  });

  test("runScenario creates a new adapter on fresh_agent resets when a factory is provided", async () => {
    const firstAdapter = new FakeAdapter([adapterReply("Stored it.")]);
    const secondAdapter = new FakeAdapter([adapterReply("Remembered it.")]);
    const adapters = [secondAdapter];
    const client = new FakeResponsesClient([
      buildPersonaStep("completed"),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      firstAdapter,
      buildScenario({
        id: "memory-scenario",
        name: "Memory Scenario",
        turns: [],
        sessions: [
          {
            id: "seed",
            timeOffset: "0h",
            reset: "none",
            turns: [
              {
                role: "user",
                content: "Remember that Sarah handles proposals.",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
          {
            id: "probe",
            timeOffset: "24h",
            reset: "fresh_agent",
            turns: [
              {
                role: "user",
                content: "Who handles proposals?",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        client: asResponsesClient(client) as never,
        adapterFactory: () => adapters.shift() ?? secondAdapter,
      },
    );

    expect(sendMessages(firstAdapter)).toEqual([
      "Remember that Sarah handles proposals.",
    ]);
    expect(sendMessages(secondAdapter)).toEqual(["Who handles proposals?"]);
    expect(
      result.transcript.filter((turn) => turn.role === "assistant"),
    ).toHaveLength(2);
  });

  test("runScenario warns and degrades when fresh_agent is requested without an adapter factory", async () => {
    const adapter = new FakeAdapter([
      adapterReply("Stored it."),
      adapterReply("I still know that."),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("completed"),
      buildPersonaStep("completed"),
      buildScore(),
    ]);
    const originalConsoleError = console.error;
    const errors: string[] = [];
    console.error = ((...args: unknown[]) => {
      errors.push(args.join(" "));
    }) as typeof console.error;

    try {
      await runScenario(
        adapter,
        buildScenario({
          turns: [],
          sessions: [
            {
              id: "seed",
              timeOffset: "0h",
              reset: "none",
              turns: [
                {
                  role: "user",
                  content: "Remember this for later.",
                  useExactMessage: true,
                  attachments: [],
                },
              ],
            },
            {
              id: "probe",
              timeOffset: "24h",
              reset: "fresh_agent",
              turns: [
                {
                  role: "user",
                  content: "What did I ask you to remember?",
                  useExactMessage: true,
                  attachments: [],
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
    } finally {
      console.error = originalConsoleError;
    }

    expect(adapter.openCalls).toHaveLength(2);
    expect(errors.join("\n")).toContain(
      "fresh_agent reset requested but no adapter_factory provided",
    );
  });

  test("runScenario treats session max_turns as a session-local cap", async () => {
    const adapter = new FakeAdapter([
      adapterReply("Stored it."),
      adapterReply("You asked me to remember Sarah."),
    ]);
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "One more follow-up in the same session."),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runScenario(
      adapter,
      buildScenario({
        turns: [],
        sessions: [
          {
            id: "seed",
            timeOffset: "0h",
            reset: "none",
            maxTurns: 1,
            turns: [
              {
                role: "user",
                content: "Remember Sarah for later.",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
          {
            id: "probe",
            timeOffset: "24h",
            reset: "new",
            turns: [
              {
                role: "user",
                content: "What did I ask you to remember?",
                useExactMessage: true,
                attachments: [],
              },
            ],
          },
        ],
      }),
      buildPersona(),
      buildRubric(),
      {
        defaults: { maxTurns: 5 },
        client: asResponsesClient(client) as never,
      },
    );

    expect(sendMessages(adapter)).toEqual([
      "Remember Sarah for later.",
      "What did I ask you to remember?",
    ]);
    expect(
      result.transcript.some((turn) =>
        turn.content?.includes("One more follow-up in the same session."),
      ),
    ).toBe(false);
    expect(result.passed).toBe(true);
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
    expect(
      events.filter((event) => event.kind === "scenario_started"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "scenario_finished"),
    ).toHaveLength(2);
  });

  test("runSuite honors parallel limits while preserving result ordering", async () => {
    const root = makeTempDir("run-suite-parallel-limit");
    const endpointPath = join(root, "endpoint.yaml");
    const personasPath = join(root, "personas.yaml");
    const rubricPath = join(root, "rubric.yaml");
    const scenariosPath = join(root, "scenarios.yaml");

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
        '    name: "Business Traveler"',
        "    demographics:",
        "      role: business customer",
        "      tech_literacy: high",
        "      domain_expertise: intermediate",
        "      language_style: terse",
        "    personality:",
        "      patience: 3",
        "      assertiveness: 4",
        "      detail_orientation: 4",
        "      cooperativeness: 4",
        "      emotional_intensity: 2",
        "    behavior:",
        '      opening_style: "Be direct."',
        '      follow_up_style: "Be concise."',
        "      escalation_triggers: []",
        '      topic_drift: "none"',
        '      clarification_compliance: "high"',
        '    system_prompt: "You are direct."',
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
        '    name: "Customer Support"',
        "    pass_threshold: 0.7",
        '    meta_prompt: "Judge behavior."',
        "    dimensions:",
        "      - id: task_completion",
        '        name: "Task Completion"',
        "        weight: 1.0",
        "        scale:",
        "          type: likert",
        "          points: 5",
        "          labels:",
        '            1: "bad"',
        '            5: "good"',
        '        judge_prompt: "Check task completion."',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      scenariosPath,
      [
        "scenarios:",
        "  - id: smoke-a",
        '    name: "Smoke A"',
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello A"',
        "        use_exact_message: true",
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "  - id: smoke-b",
        '    name: "Smoke B"',
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello B"',
        "        use_exact_message: true",
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "  - id: smoke-c",
        '    name: "Smoke C"',
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello C"',
        "        use_exact_message: true",
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const concurrency = {
      active: 0,
      max: 0,
    };

    const result = await runSuite({
      endpoint: endpointPath,
      scenarios: scenariosPath,
      personas: personasPath,
      rubric: rubricPath,
      client: {
        async create(request: {
          text: { format: { name?: string } };
        }): Promise<{ outputText: string }> {
          if (request.text.format.name === "persona_step") {
            return {
              outputText: JSON.stringify(buildPersonaStep("completed")),
            };
          }
          return {
            outputText: JSON.stringify({
              dimensions: {
                task_completion: {
                  reasoning: "The agent completed the request.",
                  evidence: ["The transcript shows a direct answer."],
                  score: 4,
                },
              },
              overall_notes: "Solid answer.",
              pass: true,
              failure_mode_detected: null,
            }),
          };
        },
      } as never,
      adapterFactory: (_endpoint: Endpoints) => ({
        async healthCheck(): Promise<void> {},
        async openScenario(): Promise<Record<string, unknown>> {
          return {};
        },
        async sendUserTurn() {
          concurrency.active += 1;
          concurrency.max = Math.max(concurrency.max, concurrency.active);
          try {
            await Bun.sleep(25);
            return adapterReply("Handled.");
          } finally {
            concurrency.active -= 1;
          }
        },
        async closeScenario(): Promise<void> {},
      }),
      parallelLimit: 2,
    });

    expect(result.exitCode).toBe(0);
    expect(result.results.map((item) => item.scenarioId)).toEqual([
      "smoke-a",
      "smoke-b",
      "smoke-c",
    ]);
    expect(concurrency.max).toBe(2);
  });

  test("runSuite emits repeat display ids, run ids, and distinct pinned users", async () => {
    const root = makeTempDir("run-suite-repeat");
    const endpointPath = join(root, "endpoint.yaml");
    const personasPath = join(root, "personas.yaml");
    const rubricPath = join(root, "rubric.yaml");
    const scenariosPath = join(root, "scenarios.yaml");

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
        '    name: "Business Traveler"',
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
        '      opening_style: "Be direct."',
        '      follow_up_style: "Answer directly."',
        "      escalation_triggers: []",
        "      topic_drift: none",
        "      clarification_compliance: high",
        '    system_prompt: "You are a direct business traveler."',
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
        '    name: "Customer Support"',
        "    pass_threshold: 0.7",
        '    meta_prompt: "Judge behavior."',
        "    dimensions:",
        "      - id: task_completion",
        '        name: "Task Completion"',
        "        weight: 1.0",
        "        scale:",
        "          type: likert",
        "          points: 5",
        "          labels:",
        '            1: "bad"',
        '            5: "good"',
        '        judge_prompt: "Check task completion."',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      scenariosPath,
      [
        "scenarios:",
        "  - id: smoke-scenario",
        '    name: "Smoke"',
        "    tags: [smoke]",
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello smoke"',
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: RunProgressEvent[] = [];
    const recorder = new SqliteRunRecorder(
      `sqlite:///${join(root, "runs.sqlite3")}`,
    );
    const result = await runSuite({
      endpoint: endpointPath,
      scenarios: scenariosPath,
      personas: personasPath,
      rubric: rubricPath,
      client: asResponsesClient(new FakeResponsesClient([])) as never,
      recorder,
      dryRun: true,
      repeat: 2,
      progressCallback: (event) => {
        events.push(event);
      },
    });

    expect(result.results.map((item) => item.scenarioId)).toEqual([
      "smoke-scenario",
      "smoke-scenario",
    ]);
    expect(new Set(result.results.map((item) => item.userId)).size).toBe(2);
    expect(events[0]?.runId).toBe(result.runId);
    expect(
      events
        .filter((event) => event.kind === "scenario_started")
        .map((event) => event.scenarioId),
    ).toEqual(["smoke-scenario", "smoke-scenario#2"]);
  });

  test("runSuite emits scenario_error events for parallel failures", async () => {
    const root = makeTempDir("run-suite-parallel-error");
    mkdirSync(root, { recursive: true });
    const endpointPath = join(root, "endpoint.yaml");
    const personasPath = join(root, "personas.yaml");
    const rubricPath = join(root, "rubric.yaml");
    const scenariosPath = join(root, "scenarios.yaml");

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
        '    name: "Business Traveler"',
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
        '      opening_style: "Be direct."',
        '      follow_up_style: "Answer directly."',
        "      escalation_triggers: []",
        "      topic_drift: none",
        "      clarification_compliance: high",
        '    system_prompt: "You are a direct business traveler."',
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
        '    name: "Customer Support"',
        "    pass_threshold: 0.7",
        '    meta_prompt: "Judge behavior."',
        "    dimensions:",
        "      - id: task_completion",
        '        name: "Task Completion"',
        "        weight: 1.0",
        "        scale:",
        "          type: likert",
        "          points: 5",
        "          labels:",
        '            1: "bad"',
        '            5: "good"',
        '        judge_prompt: "Check task completion."',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      scenariosPath,
      [
        "scenarios:",
        "  - id: smoke-a",
        '    name: "Smoke A"',
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello A"',
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "  - id: smoke-b",
        '    name: "Smoke B"',
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    turns:",
        "      - role: user",
        '        content: "Hello B"',
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: RunProgressEvent[] = [];

    const result = await runSuite({
      endpoint: endpointPath,
      scenarios: scenariosPath,
      personas: personasPath,
      rubric: rubricPath,
      client: asResponsesClient(new FakeResponsesClient([])) as never,
      adapterFactory: (_endpoint: Endpoints) =>
        new FailingAdapter("endpoint down"),
      progressCallback: (event) => {
        events.push(event);
      },
      parallel: true,
    });

    expect(
      events.filter((event) => event.kind === "scenario_error"),
    ).toHaveLength(2);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.passed === false)).toBe(true);
    expect(
      result.results.every((item) =>
        item.judgeScore?.overallNotes.includes("endpoint down"),
      ),
    ).toBe(true);
  });
});
