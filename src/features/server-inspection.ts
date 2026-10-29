import {
  type Client,
  type Guild,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import {
  saveConfigurationSnapshot,
  type ConfigurationSnapshot,
  type SavedConfigurationSnapshot,
} from "../storage/snapshots.js";

function captureGuild(guild: Guild): ConfigurationSnapshot["guild"] {
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    icon: guild.icon,
    features: [...guild.features].sort(),
    preferred_locale: guild.preferredLocale,
    verification_level: guild.verificationLevel,
    default_message_notifications: guild.defaultMessageNotifications,
    explicit_content_filter: guild.explicitContentFilter,
    afk_channel_id: guild.afkChannelId,
    afk_timeout: guild.afkTimeout,
    system_channel_id: guild.systemChannelId,
    system_channel_flags: guild.systemChannelFlags.bitfield.toString(10),
    rules_channel_id: guild.rulesChannelId,
    public_updates_channel_id: guild.publicUpdatesChannelId,
    mfa_level: guild.mfaLevel,
    nsfw_level: guild.nsfwLevel,
    premium_tier: guild.premiumTier,
  };
}

function captureChannel(
  channel: NonThreadGuildBasedChannel,
): ConfigurationSnapshot["channels"][number] {
  const topic = "topic" in channel ? channel.topic : null;
  const nsfw = "nsfw" in channel ? channel.nsfw : null;
  const rateLimit =
    "rateLimitPerUser" in channel ? channel.rateLimitPerUser : null;

  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    position: channel.position,
    parent_id: channel.parentId,
    topic,
    nsfw,
    rate_limit_per_user: rateLimit,
    viewable: channel.viewable,
    permission_overwrites: [...channel.permissionOverwrites.cache.values()]
      .sort(
        (left, right) =>
          left.type - right.type || left.id.localeCompare(right.id),
      )
      .map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(10),
        deny: overwrite.deny.bitfield.toString(10),
      })),
  };
}

export async function captureConfigurationSnapshot(
  client: Client,
  database: DatabaseSync,
  guildId: string,
  requestedBy: string,
): Promise<SavedConfigurationSnapshot> {
  const guild = await client.guilds.fetch({
    guild: guildId,
    force: true,
    withCounts: false,
  });
  const [roles, channels] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(undefined, { force: true }),
  ]);
  const returnedChannels = [...channels.values()].filter(
    (channel): channel is NonThreadGuildBasedChannel => channel !== null,
  );
  const payload: ConfigurationSnapshot = {
    guild: captureGuild(guild),
    roles: [...roles.values()]
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      )
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        permissions: role.permissions.bitfield.toString(10),
        colors: {
          primary_color: role.colors.primaryColor,
          secondary_color: role.colors.secondaryColor,
          tertiary_color: role.colors.tertiaryColor,
        },
        hoist: role.hoist,
        managed: role.managed,
        mentionable: role.mentionable,
        flags: role.flags.bitfield.toString(10),
      })),
    channels: returnedChannels
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      )
      .map(captureChannel),
    visibility: {
      state: "limited",
      note: "Discord only supplies channels visible to the bot; omitted channels cannot be confirmed absent.",
      returned_unviewable_channel_count: returnedChannels.filter(
        (channel) => !channel.viewable,
      ).length,
    },
  };

  return saveConfigurationSnapshot(database, {
    guildId,
    requestedBy,
    visibility: "limited",
    payload,
  });
}
