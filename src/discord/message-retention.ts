import {
  ChannelType,
  Events,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type Client,
  type GuildTextBasedChannel,
  type Message,
  type NonThreadGuildBasedChannel,
  type PartialMessage,
  type ThreadChannel,
  type DMChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import type { GatewayCapabilities } from "./gateway-capabilities.js";
import {
  deleteStoredMessage,
  deleteStoredMessages,
  deleteStoredMessagesById,
  disableMessageRetention,
  purgeExpiredMessages,
  removeGuildRetentionData,
  storeNewMessage,
  updateStoredMessage,
  type RetentionMessageCandidate,
} from "../storage/message-retention.js";
import { logger } from "../observability/logger.js";

const purgeIntervalMilliseconds = 60 * 60 * 1_000;

export function registerMessageRetentionEvents(
  client: Client,
  database: DatabaseSync,
  capabilities: GatewayCapabilities,
): () => void {
  runExpirySweep(database);
  const timer = setInterval(
    () => runExpirySweep(database),
    purgeIntervalMilliseconds,
  );
  timer.unref();

  const onMessageCreate = (message: Message) => {
    if (!capabilities.messageContent) return;
    const candidate = toCandidate(message, capabilities.messageContent);
    if (!candidate) return;
    try {
      storeNewMessage(database, candidate);
    } catch (error) {
      logger.error("message_retention.capture.failed", error);
    }
  };

  const onMessageUpdate = async (
    _oldMessage: Message | PartialMessage,
    updatedMessage: Message | PartialMessage,
  ) => {
    const guildId = updatedMessage.guildId;
    if (!guildId) return;
    try {
      const message = updatedMessage.partial
        ? await updatedMessage.fetch().catch(() => null)
        : updatedMessage;
      if (!message) {
        deleteStoredMessage(database, guildId, updatedMessage.id);
        return;
      }
      const candidate = toCandidate(message, capabilities.messageContent);
      if (candidate) updateStoredMessage(database, candidate);
      else deleteStoredMessage(database, guildId, message.id);
    } catch (error) {
      logger.error("message_retention.edit.failed", error);
    }
  };

  const onMessageDelete = (message: Message | PartialMessage) => {
    if (!message.guildId) return;
    try {
      deleteStoredMessage(database, message.guildId, message.id);
    } catch (error) {
      logger.error("message_retention.delete.failed", error);
    }
  };

  const onMessagesDelete = (
    messages: ReadonlyMap<string, Message | PartialMessage>,
    channel: { guildId: string | null },
  ) => {
    if (!channel.guildId) return;
    try {
      deleteStoredMessagesById(database, channel.guildId, [...messages.keys()]);
    } catch (error) {
      logger.error("message_retention.bulk_delete.failed", error);
    }
  };

  const onChannelDelete = (channel: DMChannel | NonThreadGuildBasedChannel) => {
    if (!("guildId" in channel) || !channel.guildId) return;
    try {
      disableMessageRetention(database, channel.guildId, channel.id);
    } catch (error) {
      logger.error("message_retention.channel_delete.failed", error);
    }
  };

  const onChannelUpdate = (
    _oldChannel: DMChannel | NonThreadGuildBasedChannel,
    channel: DMChannel | NonThreadGuildBasedChannel,
  ) => {
    if (!("guild" in channel)) return;
    if (!isStorageTextChannel(channel)) return;
    try {
      const botMember = channel.guild.members.me;
      const permissions = botMember ? channel.permissionsFor(botMember) : null;
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ) {
        disableMessageRetention(database, channel.guildId, channel.id);
      }
    } catch (error) {
      logger.error("message_retention.access_revoke.failed", error);
    }
  };

  const onThreadDelete = (thread: AnyThreadChannel) => {
    try {
      deleteStoredMessages(database, thread.guildId, thread.id);
    } catch (error) {
      logger.error("message_retention.thread_delete.failed", error);
    }
  };

  const onThreadUpdate = (
    _oldThread: AnyThreadChannel,
    thread: AnyThreadChannel,
  ) => {
    const botMember = thread.guild.members.me;
    const permissions = botMember ? thread.permissionsFor(botMember) : null;
    if (
      permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      return;
    }
    try {
      deleteStoredMessages(database, thread.guildId, thread.id);
    } catch (error) {
      logger.error("message_retention.thread_access_revoke.failed", error);
    }
  };

  const onGuildDelete = (guild: { id: string }) => {
    try {
      removeGuildRetentionData(database, guild.id);
    } catch (error) {
      logger.error("message_retention.guild_delete.failed", error);
    }
  };

  client.on(Events.MessageCreate, onMessageCreate);
  client.on(Events.MessageUpdate, onMessageUpdate);
  client.on(Events.MessageDelete, onMessageDelete);
  client.on(Events.MessageBulkDelete, onMessagesDelete);
  client.on(Events.ChannelDelete, onChannelDelete);
  client.on(Events.ChannelUpdate, onChannelUpdate);
  client.on(Events.ThreadDelete, onThreadDelete);
  client.on(Events.ThreadUpdate, onThreadUpdate);
  client.on(Events.GuildDelete, onGuildDelete);

  return () => {
    clearInterval(timer);
    client.off(Events.MessageCreate, onMessageCreate);
    client.off(Events.MessageUpdate, onMessageUpdate);
    client.off(Events.MessageDelete, onMessageDelete);
    client.off(Events.MessageBulkDelete, onMessagesDelete);
    client.off(Events.ChannelDelete, onChannelDelete);
    client.off(Events.ChannelUpdate, onChannelUpdate);
    client.off(Events.ThreadDelete, onThreadDelete);
    client.off(Events.ThreadUpdate, onThreadUpdate);
    client.off(Events.GuildDelete, onGuildDelete);
  };
}

function toCandidate(
  message: Message,
  messageContentEnabled: boolean,
): RetentionMessageCandidate | undefined {
  if (
    message.partial ||
    !message.guild ||
    !message.guildId ||
    message.author.bot ||
    message.system ||
    message.webhookId
  ) {
    return undefined;
  }

  const channel = message.channel;
  let parentChannelId: string | null = null;
  if (isThreadChannelType(channel.type)) {
    parentChannelId = (channel as ThreadChannel).parentId;
    const parent = parentChannelId
      ? message.guild.channels.cache.get(parentChannelId)
      : null;
    if (!parent || !isStorageTextChannel(parent)) return undefined;
  } else if (!isStorageTextChannel(channel)) {
    return undefined;
  }

  const botMember = message.guild.members.me;
  const permissions = botMember
    ? (channel as GuildTextBasedChannel).permissionsFor(botMember)
    : null;
  const botCanRead = Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.ReadMessageHistory),
  );

  return {
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId,
    messageId: message.id,
    createdAt: message.createdAt.toISOString(),
    content: message.content,
    isBot: message.author.bot,
    isWebhook: message.webhookId !== null,
    messageContentEnabled,
    botCanRead,
  };
}

function isStorageTextChannel(channel: { type: ChannelType }): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}

function isThreadChannelType(type: ChannelType): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function runExpirySweep(database: DatabaseSync): void {
  try {
    purgeExpiredMessages(database);
  } catch (error) {
    logger.error("message_retention.expiry.failed", error);
  }
}
