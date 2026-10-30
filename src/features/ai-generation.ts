import { randomUUID } from "node:crypto";
import { AiInputLimitError, AiProviderError } from "../ai/errors.js";
import type { AiCompletion, AiPrompt, AiProvider } from "../ai/types.js";
import type { DatabaseSync } from "node:sqlite";
import {
  releaseAiUsageReservation,
  reserveAiUsage,
  settleAiUsage,
} from "../storage/ai-usage.js";

export type AiGenerationLimits = Readonly<{
  maxInputTokens: number;
  maxOutputTokens: number;
  dailyTokenBudgetPerGuild: number;
  requestTimeoutMs: number;
}>;

export async function generateForGuild(
  database: DatabaseSync,
  provider: AiProvider,
  guildId: string,
  prompt: AiPrompt,
  limits: AiGenerationLimits,
  now = new Date(),
  signal?: AbortSignal,
) {
  validateLimits(limits);
  const inputTokens = await provider.countInputTokens(prompt, signal);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new AiProviderError(
      "invalid_response",
      "The AI provider returned an invalid input token count.",
    );
  }
  if (inputTokens > limits.maxInputTokens) {
    throw new AiInputLimitError(inputTokens, limits.maxInputTokens);
  }

  const requestedTokens = inputTokens + limits.maxOutputTokens;
  const reservationId = randomUUID();
  reserveAiUsage(database, {
    guildId,
    reservationId,
    requestedTokens,
    dailyLimit: limits.dailyTokenBudgetPerGuild,
    now,
    reservationTtlMs: limits.requestTimeoutMs * 2,
  });

  let completion: AiCompletion;
  try {
    completion = await provider.generateText(
      { ...prompt, maxOutputTokens: limits.maxOutputTokens },
      signal,
    );
  } catch (error) {
    if (!isKnownNoGenerationFailure(error)) {
      // Keep the reservation until expiry whenever generation may have been
      // charged but its completion could not be confirmed.
      throw error;
    }
    releaseAiUsageReservation(database, reservationId, now);
    throw error;
  }

  if (
    completion.usage.inputTokens !== inputTokens ||
    completion.usage.totalTokens !==
      completion.usage.inputTokens + completion.usage.outputTokens ||
    completion.usage.outputTokens > limits.maxOutputTokens
  ) {
    // Keep the reservation until expiry. The provider may have completed and
    // charged for the request, but its usage metadata cannot be trusted.
    throw new AiProviderError(
      "invalid_response",
      "The AI provider returned inconsistent token usage metadata.",
    );
  }
  settleAiUsage(database, reservationId, completion.usage.totalTokens, now);
  return completion;
}

function isKnownNoGenerationFailure(error: unknown): boolean {
  return (
    error instanceof AiProviderError &&
    (error.kind === "configuration" ||
      error.kind === "request_rejected" ||
      error.kind === "rate_limited")
  );
}

function validateLimits(limits: AiGenerationLimits): void {
  if (
    !Number.isSafeInteger(limits.maxInputTokens) ||
    limits.maxInputTokens < 1 ||
    !Number.isSafeInteger(limits.maxOutputTokens) ||
    limits.maxOutputTokens < 16 ||
    !Number.isSafeInteger(limits.dailyTokenBudgetPerGuild) ||
    limits.dailyTokenBudgetPerGuild < 1 ||
    !Number.isSafeInteger(limits.requestTimeoutMs) ||
    limits.requestTimeoutMs < 1_000
  ) {
    throw new RangeError("AI generation limits are invalid.");
  }
}
