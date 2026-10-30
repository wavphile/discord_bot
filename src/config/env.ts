import "dotenv/config";
import { z } from "zod";

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

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_DEV_GUILD_ID: snowflake,
  DISCORD_ALLOWED_USER_IDS: snowflakeList,
  DISCORD_ALLOWED_ROLE_IDS: snowflakeList,
  DISCORD_APPROVER_USER_IDS: snowflakeList,
  DISCORD_APPROVER_ROLE_IDS: snowflakeList,
  DATABASE_PATH: z.string().min(1).default("./data/discord-bot.sqlite"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
