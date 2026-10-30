import {
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type ThreadChannel,
} from "discord.js";
import {
  unavailableGatewayCapabilityMessage,
  type GatewayCapabilities,
} from "./gateway-capabilities.js";

export function isThreadType(type: ChannelType): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

export function isSupportedMessageChannel(
  channel: GuildBasedChannel | null,
): channel is GuildTextBasedChannel {
  if (!channel) return false;
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    isThreadType(channel.type)
  );
}

export function isSupportedMessageChannelOption(channel: {
  type: ChannelType;
}): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    isThreadType(channel.type)
  );
}

export async function getMessageChannelAccessError(
  channel: GuildTextBasedChannel,
  requester: GuildMember,
  botMember: GuildMember,
  capabilities: GatewayCapabilities,
): Promise<string | null> {
  const requesterPermissions = channel.permissionsFor(requester);
  if (
    !requesterPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !requesterPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return "You need current View Channel and Read Message History access to the selected channel or thread.";
  }
  const botPermissions = channel.permissionsFor(botMember);
  if (
    !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return "The bot needs current View Channel and Read Message History access to retrieve messages from that channel or thread.";
  }

  if (channel.type !== ChannelType.PrivateThread) return null;
  const requesterCanManage = requesterPermissions.has(
    PermissionFlagsBits.ManageThreads,
  );
  const botCanManage = botPermissions.has(PermissionFlagsBits.ManageThreads);
  if (!requesterCanManage || !botCanManage) {
    if (!capabilities.guildMembers) {
      return (
        unavailableGatewayCapabilityMessage("guildMembers", capabilities) ??
        "The bot cannot verify private-thread membership."
      );
    }
    const thread = channel as ThreadChannel;
    try {
      if (!requesterCanManage) {
        await thread.members.fetch({ member: requester.id, force: true });
      }
      if (!botCanManage) {
        await thread.members.fetch({ member: botMember.id, force: true });
      }
    } catch {
      return "Current membership in the selected private thread could not be verified for both you and the bot.";
    }
  }
  return null;
}
