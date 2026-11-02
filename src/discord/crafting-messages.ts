import { Events, type Client } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import {
  extractCraftingQuery,
  findCraftingRecipe,
  getCraftingSettings,
} from "../storage/crafting.js";
import { formatCrafterReply } from "./commands/crafting.js";
import { logger } from "../observability/logger.js";

export function registerCraftingMessageEvents(
  client: Client,
  database: DatabaseSync,
  enabled: boolean,
  allowedGuildId: string,
): () => void {
  if (!enabled) return () => {};

  const listener = async (message: import("discord.js").Message) => {
    if (
      message.author.bot ||
      message.guildId !== allowedGuildId ||
      !message.content
    ) {
      return;
    }
    const settings = getCraftingSettings(database, message.guildId);
    if (!settings || message.channelId !== settings.queryChannelId) return;
    const query = extractCraftingQuery(message.content);
    if (!query) return;
    const recipe = findCraftingRecipe(
      database,
      message.guildId,
      settings.gameVersion,
      query,
    );
    try {
      if (!recipe) {
        await message.reply({
          content: `I don't have a recipe listed for **${escapeMarkdown(query)}** in the configured Wowhead database. A crafter can add its Wowhead link with \`/crafting add\`.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const reply = formatCrafterReply(
        recipe.name,
        recipe.crafters,
        recipe.url,
      );
      await message.reply({
        content: reply.content,
        allowedMentions: { parse: [], users: reply.allowedMentions.users },
      });
    } catch {
      logger.warn("crafting.reply.failed", {
        ...(message.guildId ? { guildId: message.guildId } : {}),
      });
    }
  };

  client.on(Events.MessageCreate, listener);
  return () => client.off(Events.MessageCreate, listener);
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&")
    .replace(/@(everyone|here)/gi, "@​$1");
}
