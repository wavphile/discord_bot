import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AiInputLimitError,
  AiProviderError,
  AiUsageLimitError,
  MockAiProvider,
} from "../src/ai/index.js";
import { generateForGuild } from "../src/features/ai-generation.js";
import { openDatabase } from "../src/storage/database.js";
import {
  getAiUsage,
  releaseAiUsageReservation,
  reserveAiUsage,
  settleAiUsage,
} from "../src/storage/ai-usage.js";
import type { AiProvider } from "../src/ai/types.js";

const guildId = "11111111111111111";
const otherGuildId = "99999999999999999";
const now = new Date("2026-10-30T10:00:00.000Z");

function limits(dailyTokenBudgetPerGuild = 100) {
  return {
    maxInputTokens: 100,
    maxOutputTokens: 16,
    dailyTokenBudgetPerGuild,
    requestTimeoutMs: 5_000,
  };
}

function prompt(input = "one two") {
  return { instructions: "Only use evidence.", input };
}

test("daily usage reservations prevent concurrent over-budget requests", () => {
  const database = openDatabase(":memory:");
  try {
    const firstId = randomUUID();
    reserveAiUsage(database, {
      guildId,
      reservationId: firstId,
      requestedTokens: 60,
      dailyLimit: 100,
      reservationTtlMs: 10_000,
      now,
    });

    assert.throws(
      () =>
        reserveAiUsage(database, {
          guildId,
          reservationId: randomUUID(),
          requestedTokens: 41,
          dailyLimit: 100,
          reservationTtlMs: 10_000,
          now,
        }),
      (error: unknown) =>
        error instanceof AiUsageLimitError && error.availableTokens === 40,
    );
    assert.throws(() => settleAiUsage(database, firstId, 61, now), RangeError);
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 60);
    settleAiUsage(database, firstId, 35, now);
    assert.deepEqual(getAiUsage(database, guildId, now), {
      guildId,
      bucketDate: "2026-10-30",
      tokensUsed: 35,
      tokensReserved: 0,
    });
    assert.deepEqual(getAiUsage(database, otherGuildId, now), {
      guildId: otherGuildId,
      bucketDate: "2026-10-30",
      tokensUsed: 0,
      tokensReserved: 0,
    });
  } finally {
    database.close();
  }
});

test("released and expired reservations return capacity to the daily budget", () => {
  const database = openDatabase(":memory:");
  try {
    const firstId = randomUUID();
    reserveAiUsage(database, {
      guildId,
      reservationId: firstId,
      requestedTokens: 70,
      dailyLimit: 100,
      reservationTtlMs: 1_000,
      now,
    });
    releaseAiUsageReservation(database, firstId, now);
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 0);

    reserveAiUsage(database, {
      guildId,
      reservationId: randomUUID(),
      requestedTokens: 70,
      dailyLimit: 100,
      reservationTtlMs: 1_000,
      now,
    });
    const afterExpiry = new Date(now.getTime() + 1_001);
    const result = reserveAiUsage(database, {
      guildId,
      reservationId: randomUUID(),
      requestedTokens: 40,
      dailyLimit: 100,
      reservationTtlMs: 1_000,
      now: afterExpiry,
    });
    assert.equal(result.tokensReserved, 40);
  } finally {
    database.close();
  }
});

test("daily token buckets reset at UTC midnight and old aggregates are pruned", () => {
  const database = openDatabase(":memory:");
  try {
    const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1_000);
    const reservationId = randomUUID();
    reserveAiUsage(database, {
      guildId,
      reservationId,
      requestedTokens: 10,
      dailyLimit: 100,
      reservationTtlMs: 10_000,
      now: oldDate,
    });
    settleAiUsage(database, reservationId, 8, oldDate);
    const tomorrow = new Date("2026-10-31T00:01:00.000Z");
    reserveAiUsage(database, {
      guildId,
      reservationId: randomUUID(),
      requestedTokens: 10,
      dailyLimit: 100,
      reservationTtlMs: 10_000,
      now: tomorrow,
    });
    assert.equal(getAiUsage(database, guildId, tomorrow).tokensUsed, 0);
    assert.equal(getAiUsage(database, guildId, oldDate).tokensUsed, 0);
  } finally {
    database.close();
  }
});

test("generation enforces input limits before provider generation", async () => {
  const database = openDatabase(":memory:");
  let generationCalls = 0;
  const mock = new MockAiProvider();
  const provider: AiProvider = {
    id: mock.id,
    model: mock.model,
    countInputTokens: (request) => mock.countInputTokens(request),
    async generateText(request, signal) {
      generationCalls += 1;
      return mock.generateText(request);
    },
  };
  try {
    await assert.rejects(
      generateForGuild(
        database,
        provider,
        guildId,
        prompt("one two three four"),
        { ...limits(), maxInputTokens: 2 },
        now,
      ),
      (error: unknown) => error instanceof AiInputLimitError,
    );
    assert.equal(generationCalls, 0);
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 0);
  } finally {
    database.close();
  }
});

test("generation reserves the per-server maximum and charges actual usage", async () => {
  const database = openDatabase(":memory:");
  const mock = new MockAiProvider("one two");
  try {
    const result = await generateForGuild(
      database,
      mock,
      guildId,
      prompt(),
      limits(100),
      now,
    );
    assert.equal(result.text, "one two");
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(getAiUsage(database, guildId, now).tokensUsed, 7);
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 0);

    const otherServer = await generateForGuild(
      database,
      mock,
      otherGuildId,
      prompt(),
      limits(100),
      now,
    );
    assert.equal(otherServer.usage.totalTokens, 7);
    assert.equal(getAiUsage(database, otherGuildId, now).tokensUsed, 7);
  } finally {
    database.close();
  }
});

test("generation blocks over-budget requests before calling the provider", async () => {
  const database = openDatabase(":memory:");
  const mock = new MockAiProvider();
  let generationCalls = 0;
  const provider: AiProvider = {
    id: mock.id,
    model: mock.model,
    countInputTokens: (request) => mock.countInputTokens(request),
    async generateText(request, signal) {
      generationCalls += 1;
      return mock.generateText(request);
    },
  };
  try {
    await generateForGuild(
      database,
      provider,
      guildId,
      prompt(),
      limits(22),
      now,
    );
    await assert.rejects(
      generateForGuild(database, provider, guildId, prompt(), limits(22), now),
      (error: unknown) => error instanceof AiUsageLimitError,
    );
    assert.equal(generationCalls, 1);
  } finally {
    database.close();
  }
});

test("known provider failures release reservations while ambiguous failures hold them", async () => {
  const database = openDatabase(":memory:");
  const mock = new MockAiProvider();
  const provider: AiProvider = {
    id: mock.id,
    model: mock.model,
    countInputTokens: (request) => mock.countInputTokens(request),
    async generateText() {
      throw new AiProviderError("rate_limited", "try later");
    },
  };
  try {
    await assert.rejects(
      generateForGuild(database, provider, guildId, prompt(), limits(), now),
      AiProviderError,
    );
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 0);

    const ambiguousProvider: AiProvider = {
      ...provider,
      async generateText() {
        throw new AiProviderError("timeout", "timed out");
      },
    };
    await assert.rejects(
      generateForGuild(
        database,
        ambiguousProvider,
        guildId,
        prompt(),
        limits(),
        now,
      ),
      AiProviderError,
    );
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 21);

    const invalidResponseProvider: AiProvider = {
      ...provider,
      async generateText() {
        throw new AiProviderError("invalid_response", "invalid response");
      },
    };
    await assert.rejects(
      generateForGuild(
        database,
        invalidResponseProvider,
        guildId,
        prompt(),
        limits(),
        now,
      ),
      AiProviderError,
    );
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 42);
  } finally {
    database.close();
  }
});

test("invalid usage metadata keeps a reservation until it expires", async () => {
  const database = openDatabase(":memory:");
  const mock = new MockAiProvider();
  const provider: AiProvider = {
    id: mock.id,
    model: mock.model,
    countInputTokens: (request) => mock.countInputTokens(request),
    async generateText(request) {
      const completion = await mock.generateText(request);
      return {
        ...completion,
        usage: { inputTokens: 5, outputTokens: 17, totalTokens: 22 },
      };
    },
  };
  try {
    await assert.rejects(
      generateForGuild(database, provider, guildId, prompt(), limits(), now),
      (error: unknown) =>
        error instanceof AiProviderError && error.kind === "invalid_response",
    );
    assert.equal(getAiUsage(database, guildId, now).tokensUsed, 0);
    assert.equal(getAiUsage(database, guildId, now).tokensReserved, 21);
  } finally {
    database.close();
  }
});
