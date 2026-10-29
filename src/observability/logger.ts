type LogContext = Readonly<{
  commandName?: string;
  guildId?: string;
  schemaVersion?: number;
  signal?: "SIGINT" | "SIGTERM";
  userId?: string;
}>;

type LogLevel = "info" | "warn" | "error";

function safeContext(context: LogContext): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  if (context.commandName && /^[a-z0-9_-]{1,32}$/.test(context.commandName)) {
    result["commandName"] = context.commandName;
  }
  if (context.guildId && /^\d{17,20}$/.test(context.guildId)) {
    result["guildId"] = context.guildId;
  }
  if (context.userId && /^\d{17,20}$/.test(context.userId)) {
    result["userId"] = context.userId;
  }
  if (Number.isSafeInteger(context.schemaVersion)) {
    result["schemaVersion"] = context.schemaVersion as number;
  }
  if (context.signal) result["signal"] = context.signal;

  return result;
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}

function write(
  level: LogLevel,
  event: string,
  context: LogContext = {},
  error?: unknown,
): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeContext(context),
    ...(error === undefined ? {} : { errorName: safeErrorName(error) }),
  };
  const line = JSON.stringify(record);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info(event: string, context?: LogContext): void {
    write("info", event, context);
  },
  warn(event: string, context?: LogContext): void {
    write("warn", event, context);
  },
  error(event: string, error?: unknown, context?: LogContext): void {
    write("error", event, context, error);
  },
};
