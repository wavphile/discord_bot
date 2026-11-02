import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import {
  addCrafter,
  getCraftingSettings,
  isWowheadGameVersion,
  parseWowheadRecipeLink,
  removeCrafter,
  setCraftingSettings,
  verifyWowheadRecipe,
  wowheadGameVersions,
  type RecipeVerifier,
} from "../../storage/crafting.js";

const versionNames: Record<(typeof wowheadGameVersions)[number], string> = {
  forever: "WoW Forever",
  classic: "Classic Era",
  tbc: "The Burning Crusade",
  wotlk: "Wrath of the Lich King",
  cata: "Cataclysm",
  mop: "Mists of Pandaria",
  retail: "Retail",
};

export const craftingCommand = new SlashCommandBuilder()
  .setName("crafting")
  .setDescription("Find and register guild crafters for Wowhead recipes.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription(
        "Choose the Wowhead game, crafter role, and query channel.",
      )
      .addStringOption((option) =>
        option
          .setName("game")
          .setDescription("Wowhead game database used by this guild.")
          .addChoices(
            ...wowheadGameVersions.map((value) => ({
              name: versionNames[value],
              value,
            })),
          )
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("crafter_role")
          .setDescription("Role allowed to add or remove crafter listings.")
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("query_channel")
          .setDescription("Text channel where members can ask who can craft.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("settings")
      .setDescription("Show the current crafter registry setup."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Register yourself or an authorized guild member.")
      .addStringOption((option) =>
        option
          .setName("recipe")
          .setDescription("Wowhead item, recipe, or spell page URL.")
          .setMaxLength(500)
          .setRequired(true),
      )
      .addUserOption((option) =>
        option
          .setName("crafter")
          .setDescription("Other guild member (requires the crafter role)."),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a crafter from a Wowhead recipe.")
      .addStringOption((option) =>
        option
          .setName("recipe")
          .setDescription("Wowhead item, recipe, or spell page URL.")
          .setMaxLength(500)
          .setRequired(true),
      )
      .addUserOption((option) =>
        option
          .setName("crafter")
          .setDescription("Other guild member (requires the crafter role)."),
      ),
  );

export async function executeCraftingCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  verifier: RecipeVerifier = async (recipe) => verifyWowheadRecipe(recipe),
): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    await privateReply(
      interaction,
      "Crafting registry commands only work in a server.",
    );
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "setup") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await privateReply(
        interaction,
        "Manage Server permission is required to configure the crafter registry.",
      );
      return;
    }
    const game = interaction.options.getString("game", true);
    const role = interaction.options.getRole("crafter_role", true);
    const channel = interaction.options.getChannel("query_channel", true);
    if (!isWowheadGameVersion(game)) {
      await privateReply(
        interaction,
        "Choose a supported Wowhead game database.",
      );
      return;
    }
    if (
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
        channel.type,
      )
    ) {
      await privateReply(
        interaction,
        "Choose a role and text channel from this server.",
      );
      return;
    }
    setCraftingSettings(database, {
      guildId,
      gameVersion: game,
      crafterRoleId: role.id,
      queryChannelId: channel.id,
    });
    await privateReply(
      interaction,
      `Crafter registry set to **${versionNames[game]}**, with ${role} allowed to manage listings and ${channel} accepting item questions. The bot needs Message Content Intent enabled to read plain text questions.`,
    );
    return;
  }

  const settings = getCraftingSettings(database, guildId);
  if (subcommand === "settings") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await privateReply(
        interaction,
        "Manage Server permission is required to view the crafter registry setup.",
      );
      return;
    }
    if (!settings) {
      await privateReply(
        interaction,
        "The crafter registry is not configured. A server manager can run `/crafting setup`.",
      );
      return;
    }
    await privateReply(
      interaction,
      `Game database: **${versionNames[settings.gameVersion]}**\nCrafter role: <@&${settings.crafterRoleId}>\nQuestion channel: <#${settings.queryChannelId}>`,
    );
    return;
  }
  if (!settings) {
    await privateReply(
      interaction,
      "The crafter registry is not configured. A server manager can run `/crafting setup`.",
    );
    return;
  }
  const crafter = interaction.options.getUser("crafter") ?? interaction.user;
  if (
    !canChangeCrafterListing(
      interaction.member,
      settings.crafterRoleId,
      interaction.user.id,
      crafter.id,
    )
  ) {
    await privateReply(
      interaction,
      `You can register or remove yourself. To manage another member, you need the <@&${settings.crafterRoleId}> role.`,
    );
    return;
  }

  const rawRecipe = interaction.options.getString("recipe", true);
  const recipe = parseWowheadRecipeLink(rawRecipe, settings.gameVersion);
  if (!recipe) {
    await privateReply(
      interaction,
      `Use an HTTPS Wowhead item, recipe, or spell page for the configured **${versionNames[settings.gameVersion]}** database.`,
    );
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const verified = await verifier(recipe, new AbortController().signal);
  if (!verified) {
    await privateReply(
      interaction,
      "I could not verify that page in the selected Wowhead database. Check the link and try again.",
    );
    return;
  }

  try {
    await guild.members.fetch({ user: crafter.id, force: true });
  } catch {
    await privateReply(
      interaction,
      "Choose a member of this server as the crafter.",
    );
    return;
  }
  if (subcommand === "add") {
    const result = addCrafter(
      database,
      guildId,
      { ...recipe, name: verified.name },
      crafter.id,
      interaction.user.id,
    );
    await privateReply(
      interaction,
      result === "added"
        ? `Registered ${crafter} for [${verified.name}](${recipe.url}).`
        : `${crafter} is already registered for [${verified.name}](${recipe.url}).`,
    );
    return;
  }
  const removed = removeCrafter(database, guildId, recipe, crafter.id);
  await privateReply(
    interaction,
    removed
      ? `Removed ${crafter} from [${verified.name}](${recipe.url}).`
      : `${crafter} was not registered for [${verified.name}](${recipe.url}).`,
  );
}

export function canChangeCrafterListing(
  member: ChatInputCommandInteraction["member"],
  roleId: string,
  actorId: string,
  targetId: string,
): boolean {
  if (actorId === targetId) return true;
  if (!member) return false;
  if ("roles" in member && Array.isArray(member.roles)) {
    return member.roles.includes(roleId);
  }
  if ("roles" in member && member.roles instanceof Set) {
    return member.roles.has(roleId);
  }
  if ("roles" in member && "cache" in member.roles) {
    return member.roles.cache.has(roleId);
  }
  return false;
}

async function privateReply(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({
      content,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export function formatCrafterReply(
  itemName: string,
  crafters: readonly Readonly<{ userId: string }>[],
  recipeUrl: string,
): Readonly<{
  content: string;
  allowedMentions: { parse: string[]; users: string[] };
}> {
  if (crafters.length === 0) {
    return {
      content: `No one is registered for [${escapeMarkdown(itemName)}](${recipeUrl}) yet.`,
      allowedMentions: { parse: [], users: [] },
    };
  }
  const users = crafters.map(({ userId }) => userId);
  return {
    content: `**${escapeMarkdown(itemName)}** can be crafted by ${users.map((id) => `<@${id}>`).join(", ")}.\n${recipeUrl}`,
    allowedMentions: { parse: [], users },
  };
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&")
    .replace(/@(everyone|here)/gi, "@​$1");
}
