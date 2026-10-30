import "dotenv/config";
import { z } from "zod";
import { booleanEnv } from "./boolean-env.js";

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "must be a Discord snowflake");
const snowflakeList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(z.array(snowflake));

const envSchema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: snowflake,
    DISCORD_DEV_GUILD_ID: snowflake,
    DISCORD_ALLOWED_USER_IDS: snowflakeList,
    DISCORD_ALLOWED_ROLE_IDS: snowflakeList,
    DISCORD_APPROVER_USER_IDS: snowflakeList,
    DISCORD_APPROVER_ROLE_IDS: snowflakeList,
    DISCORD_ENABLE_GUILD_MEMBERS_INTENT: booleanEnv,
    DISCORD_ENABLE_MESSAGE_CONTENT_INTENT: booleanEnv,
    DATABASE_PATH: z.string().min(1).default("./data/discord-bot.sqlite"),
    AI_PROVIDER: z.enum(["mock", "openai", "anthropic"]).default("mock"),
    OPENAI_API_KEY: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-6-astra"),
    ANTHROPIC_API_KEY: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    ANTHROPIC_BASE_URL: z
      .string()
      .url()
      .default("https://api.anthropic.com/v1"),
    ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-sonnet-5-5"),
    AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(20_000),
    AI_MAX_INPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(200_000)
      .default(12_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(16)
      .max(32_000)
      .default(1_024),
    AI_DAILY_TOKEN_BUDGET_PER_GUILD: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .default(100_000),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .superRefine((value, context) => {
    if (value.AI_PROVIDER === "openai" && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "is required when AI_PROVIDER is openai",
      });
    }
    if (value.AI_PROVIDER === "anthropic" && !value.ANTHROPIC_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "is required when AI_PROVIDER is anthropic",
      });
    }

    const endpoint = new URL(value.OPENAI_BASE_URL);
    const localDevelopmentEndpoint =
      value.NODE_ENV !== "production" &&
      (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1");
    if (
      (endpoint.protocol !== "https:" &&
        !(endpoint.protocol === "http:" && localDevelopmentEndpoint)) ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_BASE_URL"],
        message:
          "must be an HTTPS endpoint (HTTP is allowed for localhost outside production) without URL credentials, query, or fragment",
      });
    }

    const anthropicEndpoint = new URL(value.ANTHROPIC_BASE_URL);
    const localAnthropicDevelopmentEndpoint =
      value.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(anthropicEndpoint.hostname);
    if (
      (anthropicEndpoint.protocol !== "https:" &&
        !(
          anthropicEndpoint.protocol === "http:" &&
          localAnthropicDevelopmentEndpoint
        )) ||
      anthropicEndpoint.username !== "" ||
      anthropicEndpoint.password !== "" ||
      anthropicEndpoint.search !== "" ||
      anthropicEndpoint.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        path: ["ANTHROPIC_BASE_URL"],
        message:
          "must be an HTTPS endpoint (HTTP is allowed for localhost outside production) without URL credentials, query, or fragment",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
