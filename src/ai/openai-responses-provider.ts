import { AiProviderError } from "./errors.js";
import type {
  AiCompletion,
  AiGenerationRequest,
  AiPrompt,
  AiProvider,
} from "./types.js";

export type OpenAiResponsesConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}>;

type JsonObject = Record<string, unknown>;
type FetchImplementation = typeof fetch;

export class OpenAiResponsesProvider implements AiProvider {
  readonly id = "openai";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(
    private readonly config: OpenAiResponsesConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    if (!config.apiKey.trim()) {
      throw new AiProviderError("configuration", "OpenAI API key is missing.");
    }
    if (!config.model.trim()) {
      throw new AiProviderError("configuration", "OpenAI model is missing.");
    }
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000) {
      throw new AiProviderError(
        "configuration",
        "AI request timeout must be at least 1,000 milliseconds.",
      );
    }
    const endpoint = new URL(config.baseUrl);
    const localHttpEndpoint =
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== "https:" && !localHttpEndpoint) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new AiProviderError(
        "configuration",
        "OpenAI base URL must be an HTTP(S) endpoint without URL credentials, query, or fragment.",
      );
    }
    this.baseUrl = `${config.baseUrl.replace(/\/+$/, "")}/`;
    this.model = config.model;
  }

  async countInputTokens(
    prompt: AiPrompt,
    signal?: AbortSignal,
  ): Promise<number> {
    const payload = await this.post(
      "responses/input_tokens",
      {
        model: this.model,
        input: toInputMessages(prompt),
      },
      signal,
    );
    const inputTokens = payload["input_tokens"];
    if (!isNonNegativeInteger(inputTokens)) {
      throw new AiProviderError(
        "invalid_response",
        "OpenAI returned an invalid input token count.",
      );
    }
    return inputTokens;
  }

  async generateText(
    request: AiGenerationRequest,
    signal?: AbortSignal,
  ): Promise<AiCompletion> {
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 16
    ) {
      throw new AiProviderError(
        "configuration",
        "Maximum output tokens must be an integer of at least 16.",
      );
    }
    const payload = await this.post(
      "responses",
      {
        model: this.model,
        input: toInputMessages(request),
        max_output_tokens: request.maxOutputTokens,
        store: false,
      },
      signal,
    );
    if (payload["status"] !== "completed") {
      throw new AiProviderError(
        "invalid_response",
        "OpenAI did not complete the text generation request.",
      );
    }
    const text = readOutputText(payload["output"]);
    const usage = readUsage(payload["usage"]);
    if (!text) {
      throw new AiProviderError(
        "invalid_response",
        "OpenAI returned no assistant text.",
      );
    }
    if (!usage) {
      throw new AiProviderError(
        "invalid_response",
        "OpenAI returned invalid token usage metadata.",
      );
    }
    return { text, provider: this.id, model: this.model, usage };
  }

  private async post(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
      : AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted || isAbortError(error)) {
        throw new AiProviderError(
          "timeout",
          "The AI provider request timed out or was cancelled.",
        );
      }
      throw new AiProviderError(
        "unavailable",
        "The AI provider could not be reached.",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError(
          "configuration",
          "The AI provider rejected its configured credentials or project access.",
        );
      }
      if (response.status === 429) {
        throw new AiProviderError(
          "rate_limited",
          "The AI provider is rate limiting requests; try again later.",
        );
      }
      if (response.status >= 500) {
        throw new AiProviderError(
          "unavailable",
          "The AI provider is temporarily unavailable.",
        );
      }
      throw new AiProviderError(
        "request_rejected",
        `The AI provider rejected the request (HTTP ${response.status}).`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError(
        "invalid_response",
        "The AI provider returned invalid JSON.",
      );
    }
    if (!isJsonObject(body)) {
      throw new AiProviderError(
        "invalid_response",
        "The AI provider returned an unexpected response shape.",
      );
    }
    return body;
  }
}

function toInputMessages(prompt: AiPrompt): readonly JsonObject[] {
  return [
    { role: "developer", content: prompt.instructions },
    { role: "user", content: prompt.input },
  ];
}

function readOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (
      !isJsonObject(item) ||
      item["type"] !== "message" ||
      item["role"] !== "assistant"
    ) {
      continue;
    }
    if (!Array.isArray(item["content"])) continue;
    for (const content of item["content"]) {
      if (
        isJsonObject(content) &&
        content["type"] === "output_text" &&
        typeof content["text"] === "string"
      ) {
        chunks.push(content["text"]);
      }
    }
  }
  return chunks.join("").trim();
}

function readUsage(value: unknown): AiCompletion["usage"] | null {
  if (!isJsonObject(value)) return null;
  const inputTokens = value["input_tokens"];
  const outputTokens = value["output_tokens"];
  const totalTokens = value["total_tokens"];
  if (
    !isNonNegativeInteger(inputTokens) ||
    !isNonNegativeInteger(outputTokens) ||
    !isNonNegativeInteger(totalTokens) ||
    totalTokens !== inputTokens + outputTokens
  ) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
