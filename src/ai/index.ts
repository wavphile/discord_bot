import { MockAiProvider } from "./mock-provider.js";
import {
  AnthropicMessagesProvider,
  type AnthropicMessagesConfig,
} from "./anthropic-messages-provider.js";
import {
  OpenAiResponsesProvider,
  type OpenAiResponsesConfig,
} from "./openai-responses-provider.js";
import type { AiProvider } from "./types.js";

export type AiProviderSettings = Readonly<{
  AI_PROVIDER: "mock" | "openai" | "anthropic";
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  AI_REQUEST_TIMEOUT_MS: number;
}>;

export type AiProviderId = "mock" | "openai" | "anthropic";

export function createAiProvider(settings: AiProviderSettings): AiProvider {
  if (settings.AI_PROVIDER === "mock") return new MockAiProvider();
  if (settings.AI_PROVIDER === "openai") {
    const config: OpenAiResponsesConfig = {
      apiKey: settings.OPENAI_API_KEY ?? "",
      baseUrl: settings.OPENAI_BASE_URL,
      model: settings.OPENAI_MODEL,
      timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
    };
    return new OpenAiResponsesProvider(config);
  }
  const config: AnthropicMessagesConfig = {
    apiKey: settings.ANTHROPIC_API_KEY ?? "",
    baseUrl: settings.ANTHROPIC_BASE_URL,
    model: settings.ANTHROPIC_MODEL,
    timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
  };
  return new AnthropicMessagesProvider(config);
}

export function createAiProviders(
  settings: AiProviderSettings,
): ReadonlyMap<AiProviderId, AiProvider> {
  const providers = new Map<AiProviderId, AiProvider>([
    ["mock", new MockAiProvider()],
  ]);
  if (settings.OPENAI_API_KEY) {
    const config: OpenAiResponsesConfig = {
      apiKey: settings.OPENAI_API_KEY,
      baseUrl: settings.OPENAI_BASE_URL,
      model: settings.OPENAI_MODEL,
      timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
    };
    providers.set("openai", new OpenAiResponsesProvider(config));
  }
  if (settings.ANTHROPIC_API_KEY) {
    const config: AnthropicMessagesConfig = {
      apiKey: settings.ANTHROPIC_API_KEY,
      baseUrl: settings.ANTHROPIC_BASE_URL,
      model: settings.ANTHROPIC_MODEL,
      timeoutMs: settings.AI_REQUEST_TIMEOUT_MS,
    };
    providers.set("anthropic", new AnthropicMessagesProvider(config));
  }
  return providers;
}

export {
  AiProviderError,
  AiInputLimitError,
  AiUsageLimitError,
} from "./errors.js";
export { MockAiProvider } from "./mock-provider.js";
export { AnthropicMessagesProvider } from "./anthropic-messages-provider.js";
export { OpenAiResponsesProvider } from "./openai-responses-provider.js";
export type {
  AiCompletion,
  AiGenerationRequest,
  AiPrompt,
  AiProvider,
  AiTokenUsage,
} from "./types.js";
