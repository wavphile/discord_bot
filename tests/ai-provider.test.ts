import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiProvider,
  AiProviderError,
  MockAiProvider,
} from "../src/ai/index.js";
import { OpenAiResponsesProvider } from "../src/ai/openai-responses-provider.js";
import type { AiPrompt } from "../src/ai/types.js";

const prompt: AiPrompt = {
  instructions: "Use only supplied evidence.",
  input: "Why can this member view the channel?",
};

function provider(fetchImplementation: typeof fetch) {
  return new OpenAiResponsesProvider(
    {
      apiKey: "test-api-key-that-must-not-leak",
      baseUrl: "https://api.openai.com/v1",
      model: "test-model",
      timeoutMs: 5_000,
    },
    fetchImplementation,
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("OpenAI input token counting uses the same developer and user input", async () => {
  let requestUrl = "";
  let requestBody = "";
  let requestAuthorization = "";
  const client = provider(async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    requestAuthorization =
      new Headers(init?.headers).get("Authorization") ?? "";
    return jsonResponse({ object: "response.input_tokens", input_tokens: 23 });
  });

  assert.equal(await client.countInputTokens(prompt), 23);
  assert.equal(requestUrl, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(requestAuthorization, "Bearer test-api-key-that-must-not-leak");
  assert.deepEqual(JSON.parse(requestBody), {
    model: "test-model",
    input: [
      { role: "developer", content: prompt.instructions },
      { role: "user", content: prompt.input },
    ],
  });
});

test("OpenAI Responses parsing collects text items and stores no response", async () => {
  let requestUrl = "";
  let requestBody = "";
  const client = provider(async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return jsonResponse({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "The member has the " },
            { type: "output_text", text: "View Channel permission." },
          ],
        },
      ],
      usage: { input_tokens: 23, output_tokens: 9, total_tokens: 32 },
    });
  });

  const result = await client.generateText({ ...prompt, maxOutputTokens: 128 });
  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(result.text, "The member has the View Channel permission.");
  assert.deepEqual(result.usage, {
    inputTokens: 23,
    outputTokens: 9,
    totalTokens: 32,
  });
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "test-model");
  assert.equal(JSON.parse(requestBody).store, false);
  assert.equal(
    JSON.stringify(JSON.parse(requestBody)).includes("test-api-key"),
    false,
  );
});

test("OpenAI provider errors do not include API response bodies or credentials", async () => {
  const client = provider(async () =>
    jsonResponse({ error: { message: "secret details and credentials" } }, 429),
  );

  await assert.rejects(client.countInputTokens(prompt), (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.message.includes("secret details"), false);
    assert.equal(error.message.includes("test-api-key"), false);
    return true;
  });
});

test("OpenAI provider maps an aborted request to a bounded timeout error", async () => {
  const client = provider(async () => {
    throw new DOMException("aborted", "TimeoutError");
  });

  await assert.rejects(
    client.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError &&
      error.kind === "timeout" &&
      !error.message.includes("test-api-key"),
  );
});

test("OpenAI provider rejects incomplete output and inconsistent usage", async () => {
  const incomplete = provider(async () =>
    jsonResponse({
      status: "incomplete",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  );
  await assert.rejects(
    incomplete.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );

  const inconsistent = provider(async () =>
    jsonResponse({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 3 },
    }),
  );
  await assert.rejects(
    inconsistent.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );
});

test("mock provider is deterministic and does not make network requests", async () => {
  const mock = new MockAiProvider("one two three", "fixture");
  assert.equal(await mock.countInputTokens(prompt), 11);
  assert.deepEqual(await mock.generateText({ ...prompt, maxOutputTokens: 2 }), {
    text: "one two",
    provider: "mock",
    model: "fixture",
    usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
  });
});

test("provider factory defaults to the mock and requires OpenAI credentials", () => {
  const settings = {
    AI_PROVIDER: "mock" as const,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL: "test-model",
    AI_REQUEST_TIMEOUT_MS: 5_000,
  };
  assert.ok(createAiProvider(settings) instanceof MockAiProvider);
  assert.throws(
    () => createAiProvider({ ...settings, AI_PROVIDER: "openai" }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "configuration",
  );
});
