import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiProvider,
  createAiProviders,
  AiProviderError,
  MockAiProvider,
} from "../src/ai/index.js";
import { AnthropicMessagesProvider } from "../src/ai/anthropic-messages-provider.js";
import type { AiPrompt } from "../src/ai/types.js";

const prompt: AiPrompt = {
  instructions: "Use only supplied evidence.",
  input: "Why can this member view the channel?",
};
const apiKey = "test-anthropic-key-that-must-not-leak";

function provider(fetchImplementation: typeof fetch) {
  return new AnthropicMessagesProvider(
    {
      apiKey,
      baseUrl: "https://api.anthropic.com/v1",
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

test("Anthropic token counting uses the same system and user content", async () => {
  let requestUrl = "";
  let requestBody = "";
  let requestHeaders = new Headers();
  const client = provider(async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    requestHeaders = new Headers(init?.headers);
    return jsonResponse({ input_tokens: 23 });
  });

  assert.equal(await client.countInputTokens(prompt), 23);
  assert.equal(
    requestUrl,
    "https://api.anthropic.com/v1/messages/count_tokens",
  );
  assert.equal(requestHeaders.get("Authorization"), `Bearer ${apiKey}`);
  assert.equal(requestHeaders.get("anthropic-version"), "2026-10-21");
  assert.deepEqual(JSON.parse(requestBody), {
    model: "test-model",
    system: prompt.instructions,
    messages: [{ role: "user", content: prompt.input }],
  });
  assert.equal(requestBody.includes(apiKey), false);
});

test("Anthropic Messages parses text blocks and records input plus output usage", async () => {
  let requestUrl = "";
  let requestBody = "";
  const client = provider(async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return jsonResponse({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "The member has the " },
        { type: "text", text: "View Channel permission." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 23, output_tokens: 9 },
    });
  });

  const result = await client.generateText({ ...prompt, maxOutputTokens: 128 });
  assert.equal(requestUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(result.text, "The member has the View Channel permission.");
  assert.deepEqual(result.usage, {
    inputTokens: 23,
    outputTokens: 9,
    totalTokens: 32,
  });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "test-model");
  assert.deepEqual(JSON.parse(requestBody), {
    model: "test-model",
    system: prompt.instructions,
    messages: [{ role: "user", content: prompt.input }],
    max_tokens: 128,
  });
  assert.equal(requestBody.includes(apiKey), false);
});

test("Anthropic rejects incomplete, empty, malformed, and inconsistent responses", async () => {
  const truncated = provider(async () =>
    jsonResponse({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  );
  await assert.rejects(
    truncated.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );

  const inconsistent = provider(async () =>
    jsonResponse({
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER },
    }),
  );
  await assert.rejects(
    inconsistent.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );

  const invalidCount = provider(async () =>
    jsonResponse({ input_tokens: 1.5 }),
  );
  await assert.rejects(
    invalidCount.countInputTokens(prompt),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );

  const empty = provider(async () =>
    jsonResponse({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  await assert.rejects(
    empty.generateText({ ...prompt, maxOutputTokens: 128 }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "invalid_response",
  );
});

test("Anthropic maps HTTP failures safely and never exposes response bodies", async () => {
  const cases = [
    [400, "request_rejected"],
    [401, "configuration"],
    [402, "configuration"],
    [403, "configuration"],
    [408, "timeout"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [504, "timeout"],
    [529, "unavailable"],
  ] as const;

  for (const [status, kind] of cases) {
    const client = provider(async () =>
      jsonResponse(
        { error: { message: "secret response body and credential" } },
        status,
      ),
    );
    await assert.rejects(client.countInputTokens(prompt), (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes("secret response body"), false);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    });
  }
});

test("Anthropic distinguishes timeouts from connection failures", async () => {
  const timedOut = provider(async () => {
    throw new DOMException("aborted", "TimeoutError");
  });
  await assert.rejects(
    timedOut.countInputTokens(prompt),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "timeout",
  );

  const unavailable = provider(async () => {
    throw new Error("private network details");
  });
  await assert.rejects(
    unavailable.countInputTokens(prompt),
    (error: unknown) =>
      error instanceof AiProviderError &&
      error.kind === "unavailable" &&
      !error.message.includes("private network details"),
  );
});

test("Anthropic validates credentials and endpoint configuration", () => {
  assert.throws(
    () =>
      new AnthropicMessagesProvider({
        apiKey: " ",
        baseUrl: "https://api.anthropic.com/v1",
        model: "test-model",
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "configuration",
  );
  assert.throws(
    () =>
      new AnthropicMessagesProvider({
        apiKey,
        baseUrl: "http://example.com/v1",
        model: "test-model",
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "configuration",
  );
  assert.throws(
    () =>
      new AnthropicMessagesProvider({
        apiKey,
        baseUrl: "https://api.anthropic.com/v1?token=secret",
        model: "test-model",
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "configuration",
  );
});

test("provider factory keeps mock default and exposes only configured hosted providers", () => {
  const settings = {
    AI_PROVIDER: "mock" as const,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL: "openai-test-model",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
    ANTHROPIC_MODEL: "anthropic-test-model",
    AI_REQUEST_TIMEOUT_MS: 5_000,
  };
  assert.ok(createAiProvider(settings) instanceof MockAiProvider);
  assert.throws(
    () => createAiProvider({ ...settings, AI_PROVIDER: "anthropic" }),
    (error: unknown) =>
      error instanceof AiProviderError && error.kind === "configuration",
  );

  const mockOnly = createAiProviders(settings);
  assert.deepEqual([...mockOnly.keys()], ["mock"]);
  const anthropicOnly = createAiProviders({
    ...settings,
    ANTHROPIC_API_KEY: apiKey,
  });
  assert.deepEqual([...anthropicOnly.keys()], ["mock", "anthropic"]);
  assert.ok(
    anthropicOnly.get("anthropic") instanceof AnthropicMessagesProvider,
  );
  const both = createAiProviders({
    ...settings,
    OPENAI_API_KEY: "openai-test-key",
    ANTHROPIC_API_KEY: apiKey,
  });
  assert.deepEqual([...both.keys()], ["mock", "openai", "anthropic"]);
});
