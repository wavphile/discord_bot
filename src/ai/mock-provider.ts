import type {
  AiCompletion,
  AiGenerationRequest,
  AiPrompt,
  AiProvider,
} from "./types.js";

export class MockAiProvider implements AiProvider {
  readonly id = "mock";
  readonly model: string;

  constructor(
    private readonly responseText = "Mock AI response. No hosted provider was contacted.",
    model = "mock-v1",
  ) {
    this.model = model;
  }

  async countInputTokens(prompt: AiPrompt): Promise<number> {
    return countMockTokens(`${prompt.instructions}\n${prompt.input}`);
  }

  async generateText(request: AiGenerationRequest): Promise<AiCompletion> {
    const text = this.responseText
      .trim()
      .split(/\s+/)
      .slice(0, request.maxOutputTokens)
      .join(" ");
    const inputTokens = await this.countInputTokens(request);
    const outputTokens = countMockTokens(text);
    return {
      text,
      provider: this.id,
      model: this.model,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}

function countMockTokens(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
