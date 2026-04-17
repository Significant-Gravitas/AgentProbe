import { beforeEach, describe, expect, test } from "bun:test";

import {
  generateNextStep,
  generatePersonaStep,
} from "../../src/domains/evaluation/simulator.ts";
import { AgentProbeRuntimeError } from "../../src/shared/utils/errors.ts";
import {
  asResponsesClient,
  buildPersona,
  buildPersonaStep,
  FakeResponsesClient,
} from "./support.ts";

describe("simulator", () => {
  const originalModel = process.env.AGENTPROBE_PERSONA_MODEL;

  beforeEach(() => {
    if (originalModel === undefined) {
      delete process.env.AGENTPROBE_PERSONA_MODEL;
    } else {
      process.env.AGENTPROBE_PERSONA_MODEL = originalModel;
    }
  });

  test("uses env default model and guidance for required turns", async () => {
    process.env.AGENTPROBE_PERSONA_MODEL = "env-persona-model";
    const client = new FakeResponsesClient([
      buildPersonaStep(
        "continue",
        "I need to know when the refund will show up.",
      ),
    ]);

    const result = await generatePersonaStep(
      buildPersona({
        id: "frustrated-customer",
        name: "Frustrated Customer",
        description: "Emotionally charged support user.",
        demographics: {
          role: "end-user customer",
          techLiteracy: "low",
          domainExpertise: "none",
          languageStyle: "casual",
        },
        personality: {
          patience: 2,
          assertiveness: 4,
          detailOrientation: 2,
          cooperativeness: 3,
          emotionalIntensity: 4,
        },
        behavior: {
          openingStyle: "Start frustrated.",
          followUpStyle: "Push for specifics when the agent is vague.",
          escalationTriggers: ["Ask for a human after repeated dead ends."],
          topicDrift: "low",
          clarificationCompliance: "medium",
        },
        systemPrompt:
          "You are a frustrated customer asking for help with a broken order.",
      }),
      [
        { role: "user", content: "My order arrived broken." },
        {
          role: "assistant",
          content: "I can help with that. Do you want a refund?",
        },
      ],
      asResponsesClient(client) as never,
      {
        guidance: "Ask about refund timing.",
        requireResponse: true,
      },
    );

    expect(result).toEqual({
      status: "continue",
      message: "I need to know when the refund will show up.",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.model).toBe("env-persona-model");
    expect(client.calls[0]?.instructions).toContain("Frustrated Customer");
    expect(client.calls[0]?.input).toContain("Ask about refund timing.");
    expect(client.calls[0]?.input).toContain("Conversation so far:");
    expect(client.calls[0]?.input).toContain(
      "A response is required for this scripted turn.",
    );
    expect(client.calls[0]?.text.format.type).toBe("json_schema");
    expect(client.calls[0]?.text.format.name).toBe("persona_step");
    expect(client.calls[0]?.text.format.strict).toBe(true);
    expect(client.calls[0]?.text.format.schema.required).toEqual(["message"]);
  });

  test("prefers persona model override", async () => {
    process.env.AGENTPROBE_PERSONA_MODEL = "env-persona-model";
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Refund, and I need it processed today."),
    ]);

    await generatePersonaStep(
      buildPersona({ model: "persona-override-model" }),
      "User: My order is broken.\nAssistant: Do you want a refund or replacement?",
      asResponsesClient(client) as never,
      { requireResponse: true },
    );

    expect(client.calls[0]?.model).toBe("persona-override-model");
  });

  test("ignores checkpoint turns", async () => {
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Yes, order 1234. Can you fix this?"),
    ]);

    const result = await generatePersonaStep(
      buildPersona(),
      [
        { role: "user", content: "I was charged twice." },
        { role: "checkpoint", assert: [{ tool_called: "lookup_charge" }] },
        {
          role: "assistant",
          content: "I can check that. What is the order number?",
        },
      ],
      asResponsesClient(client) as never,
      { requireResponse: true },
    );

    expect(result).toEqual({
      status: "continue",
      message: "Yes, order 1234. Can you fix this?",
    });
    const input = client.calls[0]?.input;
    const inputText =
      typeof input === "string"
        ? input
        : (input
            ?.flatMap((message) => message.content.map((part) => part.text))
            .join("\n\n") ?? "");
    expect(inputText.toLowerCase()).not.toContain("checkpoint");
  });

  test("supports stop statuses", async () => {
    for (const status of ["completed", "stalled"] as const) {
      const client = new FakeResponsesClient([buildPersonaStep(status)]);
      const result = await generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(client) as never,
      );
      expect(result).toEqual({ status, message: null });
    }
  });

  test("normalizes placeholder and acknowledgement terminal messages", async () => {
    const cases = [":", "...", " null ", "Thanks, that's all."];
    for (const message of cases) {
      const client = new FakeResponsesClient([
        buildPersonaStep("completed", message),
      ]);
      const result = await generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(client) as never,
      );
      expect(result).toEqual({ status: "completed", message: null });
    }
  });

  test("coerces conversational terminal messages to continue", async () => {
    const client = new FakeResponsesClient([
      buildPersonaStep("completed", "How complicated would that be?"),
    ]);

    const result = await generatePersonaStep(
      buildPersona(),
      [{ role: "assistant", content: "I can create the posts." }],
      asResponsesClient(client) as never,
    );

    expect(result).toEqual({
      status: "continue",
      message: "How complicated would that be?",
    });
  });

  test("coerces required response payloads and rejects invalid required turns", async () => {
    const acceptableClient = new FakeResponsesClient([
      buildPersonaStep("completed", "I need the CRM record for Sarah."),
    ]);
    const acceptable = await generatePersonaStep(
      buildPersona(),
      [{ role: "assistant", content: "What should I look up?" }],
      asResponsesClient(acceptableClient) as never,
      { requireResponse: true },
    );
    expect(acceptable).toEqual({
      status: "continue",
      message: "I need the CRM record for Sarah.",
    });

    const invalidStatusClient = new FakeResponsesClient([
      buildPersonaStep("completed"),
    ]);
    await expect(
      generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(invalidStatusClient) as never,
        { requireResponse: true },
      ),
    ).rejects.toThrow(/must return `continue`/);

    const emptyMessageClient = new FakeResponsesClient([
      buildPersonaStep("continue", "   "),
    ]);
    await expect(
      generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(emptyMessageClient) as never,
        { requireResponse: true },
      ),
    ).rejects.toThrow(/non-empty `message`/);
  });

  test("generateNextStep returns a plain message", async () => {
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "I need a refund, and I need it today."),
    ]);

    const result = await generateNextStep(
      buildPersona(),
      [{ role: "user", content: "Hello" }],
      asResponsesClient(client) as never,
      { guidance: "Ask for urgent refund handling." },
    );

    expect(result).toBe("I need a refund, and I need it today.");
  });

  test("accepts fenced JSON, embedded JSON, and plaintext fallbacks", async () => {
    const fencedClient = new FakeResponsesClient([
      {
        outputText:
          '```json\n{"status":"continue","message":"I need the refund timeline."}\n```',
      },
    ]);
    expect(
      await generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(fencedClient) as never,
        { requireResponse: true },
      ),
    ).toEqual({
      status: "continue",
      message: "I need the refund timeline.",
    });

    const embeddedClient = new FakeResponsesClient([
      {
        outputText: 'Here is the result: {"status":"completed","message":null}',
      },
    ]);
    expect(
      await generatePersonaStep(
        buildPersona(),
        [{ role: "user", content: "Hello" }],
        asResponsesClient(embeddedClient) as never,
      ),
    ).toEqual({ status: "completed", message: null });

    const plaintextRequiredClient = new FakeResponsesClient([
      {
        outputText: "I need you to check the CRM contact for Sarah.",
      },
    ]);
    expect(
      await generatePersonaStep(
        buildPersona(),
        [{ role: "assistant", content: "Who should I look up?" }],
        asResponsesClient(plaintextRequiredClient) as never,
        { requireResponse: true },
      ),
    ).toEqual({
      status: "continue",
      message: "I need you to check the CRM contact for Sarah.",
    });

    const plaintextContinueClient = new FakeResponsesClient([
      { outputText: "Can you also verify their company?" },
    ]);
    expect(
      await generatePersonaStep(
        buildPersona(),
        [{ role: "assistant", content: "I found the contact." }],
        asResponsesClient(plaintextContinueClient) as never,
      ),
    ).toEqual({
      status: "continue",
      message: "Can you also verify their company?",
    });

    const plaintextCompletedClient = new FakeResponsesClient([
      { outputText: "The task is complete. No further response." },
    ]);
    expect(
      await generatePersonaStep(
        buildPersona(),
        [{ role: "assistant", content: "Done." }],
        asResponsesClient(plaintextCompletedClient) as never,
      ),
    ).toEqual({ status: "completed", message: null });
  });

  test("rejects empty model output", async () => {
    const client = new FakeResponsesClient([{ outputText: "" }]);
    await expect(
      generatePersonaStep(
        buildPersona(),
        [{ role: "assistant", content: "Done." }],
        asResponsesClient(client) as never,
      ),
    ).rejects.toThrow(AgentProbeRuntimeError);
  });
});
