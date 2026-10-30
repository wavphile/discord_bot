import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

/**
 * The smallest interface for a read-only Discord feature.
 *
 * The application authorizes the interaction before dispatching the module.
 * Modules that need additional data access must perform their own current
 * permission checks in the feature layer.
 */
export type ReadOnlyFeatureModule = Readonly<{
  command: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}>;
