import "dotenv/config";
import { z } from "zod";

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "must be a Discord snowflake");

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_DEV_GUILD_ID: snowflake,
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

