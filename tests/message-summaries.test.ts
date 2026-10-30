import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessageQuestionEvidence,
  type RetrievedMessage,
} from "../src/features/message-retrieval.js";
import {
  buildMessageSummaryPrompt,
  parseMessageSummary,
  selectMessageSummarySources,
} from "../src/features/message-summaries.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const now = new Date("2026-10-30T10:00:00.000Z");

function message(index: number): RetrievedMessage {
  return {
    guildId,
    channelId,
    messageId: String(3_333_333_333_333_333_30n + BigInt(index)),
    authorId: "44444444444444444",
    authorName: "Test member",
    createdAt: new Date(now.getTime() - index * 1_000).toISOString(),
    content: `Discussion point ${index}`,
  };
}

function evidence() {
  const result = buildMessageQuestionEvidence({
    question: "Summarize this channel.",
    guildId,
    channelId,
    channelName: "bots",
    messages: [message(1), message(2)],
    maxAgeDays: 1,
    maxMessages: 10,
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture evidence should be valid");
  return result.evidence;
}

test("summary prompt requires supported source IDs and treats messages as data", () => {
  const prompt = buildMessageSummaryPrompt(evidence());
  assert.match(prompt.instructions, /untrusted user content/);
  assert.match(prompt.instructions, /exactly two keys/);
  assert.match(prompt.instructions, /source_id values present/);
  assert.match(prompt.instructions, /No tools are available/);
  assert.match(prompt.input, /"source_id":1/);
  assert.match(prompt.input, /"source_id":2/);
  assert.match(prompt.input, /Discussion point/);
});

test("summary parser accepts only bounded source-linked output", () => {
  const available = evidence().sources;
  const parsed = parseMessageSummary(
    JSON.stringify({
      summary: "Members are discussing the next bot test.",
      source_ids: [1, 2],
    }),
    available,
  );
  assert.deepEqual(parsed, {
    ok: true,
    summary: {
      summary: "Members are discussing the next bot test.",
      sourceIds: [1, 2],
    },
  });
  if (!parsed.ok) return;
  assert.deepEqual(
    selectMessageSummarySources(parsed.summary, available)?.map(
      (source) => source.messageId,
    ),
    available.map((source) => source.messageId),
  );
});

test("summary parser rejects missing, fabricated, duplicate, and extra source data", () => {
  const available = evidence().sources;
  const invalidOutputs = [
    "not JSON",
    JSON.stringify({ summary: "A summary with no citations.", source_ids: [] }),
    JSON.stringify({ summary: "Fabricated", source_ids: [99] }),
    JSON.stringify({ summary: "Duplicate", source_ids: [1, 1] }),
    JSON.stringify({
      summary: "Click [Message 99](https://example.com)",
      source_ids: [1],
    }),
    JSON.stringify({
      summary: "See https://discord.com/channels/foreign/source",
      source_ids: [1],
    }),
    JSON.stringify({
      summary: "Extra field",
      source_ids: [1],
      url: "https://example.com",
    }),
    JSON.stringify({ summary: "", source_ids: [1] }),
  ];
  for (const output of invalidOutputs) {
    assert.deepEqual(parseMessageSummary(output, available), { ok: false });
  }
  assert.deepEqual(
    parseMessageSummary(
      JSON.stringify({ summary: "Oversized", source_ids: [1] }).repeat(1_000),
      available,
    ),
    { ok: false },
  );
});
