import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { env } from "./config/env.js";
import { executeHealthCommand } from "./discord/commands/health.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.info(`Ready as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "health") {
      await executeHealthCommand(interaction);
    }
  } catch (error) {
    console.error("Failed to handle interaction", error);

    const reply = {
      content: "The command could not be completed. Please try again later.",
      flags: MessageFlags.Ephemeral as const,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error", error);
});

process.once("SIGINT", () => void client.destroy());
process.once("SIGTERM", () => void client.destroy());

await client.login(env.DISCORD_BOT_TOKEN);

