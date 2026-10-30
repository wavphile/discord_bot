import { REST, Routes } from "discord.js";
import { env } from "./config/env.js";
import { createCommands } from "./discord/commands/index.js";
import type { MessageProviderId } from "./features/message-retrieval.js";

const configuredMessageProviders: MessageProviderId[] = ["mock"];
if (env.OPENAI_API_KEY) configuredMessageProviders.push("openai");
if (env.ANTHROPIC_API_KEY) configuredMessageProviders.push("anthropic");
const commands = createCommands(configuredMessageProviders);

const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(
    env.DISCORD_APPLICATION_ID,
    env.DISCORD_DEV_GUILD_ID,
  ),
  { body: commands.map((command) => command.toJSON()) },
);

console.info(
  `Registered ${commands.length} command(s) in the development server.`,
);
