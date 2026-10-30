export type AiProviderErrorKind =
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "configuration"
  | "request_rejected"
  | "invalid_response";

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export class AiInputLimitError extends Error {
  constructor(
    readonly inputTokens: number,
    readonly maxInputTokens: number,
  ) {
    super(
      `The request uses ${inputTokens} input tokens; the configured maximum is ${maxInputTokens}.`,
    );
    this.name = "AiInputLimitError";
  }
}

export class AiUsageLimitError extends Error {
  constructor(
    readonly dailyLimit: number,
    readonly requestedReservation: number,
    readonly availableTokens: number,
  ) {
    super(
      `This server has ${availableTokens} tokens available in its daily AI budget; the request reserves ${requestedReservation}.`,
    );
    this.name = "AiUsageLimitError";
  }
}
