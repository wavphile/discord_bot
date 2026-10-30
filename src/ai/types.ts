export type AiPrompt = Readonly<{
  instructions: string;
  input: string;
}>;

export type AiGenerationRequest = AiPrompt &
  Readonly<{
    maxOutputTokens: number;
  }>;

export type AiTokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type AiCompletion = Readonly<{
  text: string;
  provider: string;
  model: string;
  usage: AiTokenUsage;
}>;

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  countInputTokens(prompt: AiPrompt, signal?: AbortSignal): Promise<number>;
  generateText(
    request: AiGenerationRequest,
    signal?: AbortSignal,
  ): Promise<AiCompletion>;
}
