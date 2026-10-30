import { MockAiProvider } from "./mock-provider.js";
import {
  OpenAiResponsesProvider,
  type OpenAiResponsesConfig,
} from "./openai-responses-provider.js";
import type { AiProvider } from "./types.js";

export type AiProviderSettings = Readonly<{
  AI_PROVIDER: "mock" | "openai";
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  AI_REQUEST_TIMEOUT_MS: number;
}>;

export function createAiProvider(settings: AiProviderSettings): AiProvider {
  if (settings.AI_PROVIDER === "mock") return new MockAiProvider();
  const config: OpenAiResponsesConfig = {
    apiKey: settings.OPENAI_API_KEY ?? "",
    baseUrl: settings.OPENAI_BASE_URL,
    model: settings.OPENAI_MODEL,
    timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
  };
  return new OpenAiResponsesProvider(config);
}

export {
  AiProviderError,
  AiInputLimitError,
  AiUsageLimitError,
} from "./errors.js";
export { MockAiProvider } from "./mock-provider.js";
export { OpenAiResponsesProvider } from "./openai-responses-provider.js";
export type {
  AiCompletion,
  AiGenerationRequest,
  AiPrompt,
  AiProvider,
  AiTokenUsage,
} from "./types.js";
