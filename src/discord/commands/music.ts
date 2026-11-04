import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import * as play from "play-dl";
import {
  getGuildSetting,
  setGuildSetting,
} from "../../storage/guild-settings.js";

type Track = Readonly<{ url: string; title: string; requestedBy: string }>;
type GuildQueue = {
  tracks: Track[];
  current?: Track;
  player: AudioPlayer;
  connection?: VoiceConnection;
  textChannelId: string;
  starting: boolean;
  generation: number;
  client: Client;
  database: DatabaseSync;
};

const queues = new Map<string, GuildQueue>();
const responseChannelSetting = "music.response_channel";
const maximumQueueSize = 50;

export function stopMusicPlayback(): void {
  for (const queue of queues.values()) {
    queue.generation += 1;
    queue.tracks.length = 0;
    queue.player.stop(true);
    queue.connection?.destroy();
  }
  queues.clear();
}

export const musicCommand = new SlashCommandBuilder()
  .setName("music")
  .setDescription("Play YouTube videos in your voice channel.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("play")
      .setDescription("Queue a YouTube video.")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("YouTube video URL.")
          .setMaxLength(500)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("skip").setDescription("Skip the current video."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stop")
      .setDescription("Stop playback and clear the queue."),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("queue").setDescription("Show the current music queue."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("leave")
      .setDescription("Stop playback and leave voice."),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("channel")
      .setDescription("Choose where music activity is announced.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set the channel for music responses.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Text channel for music responses.")
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("show")
          .setDescription("Show the music response channel."),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Clear the music response channel."),
      ),
  );

export async function executeMusicCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  database: DatabaseSync,
): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    await interaction.reply({
      content: "Use this command in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (group === "channel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Manage Server permission is required to change this setting.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === "set") {
      const channel = interaction.options.getChannel(
        "channel",
        true,
      ) as GuildBasedChannel;
      if (!channel.isTextBased() || !("send" in channel)) {
        await interaction.reply({
          content: "Choose a text channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const permissions = channel.permissionsFor(me);
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions.has(PermissionFlagsBits.SendMessages)
      ) {
        await interaction.reply({
          content: "The bot needs View Channel and Send Messages access there.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      setGuildSetting(database, guildId, responseChannelSetting, channel.id);
      await interaction.reply({
        content: `Music responses will be posted in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === "clear") {
      setGuildSetting(database, guildId, responseChannelSetting, null);
      await interaction.reply({
        content:
          "Music responses will appear in the channel where each command is used.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channelId = getGuildSetting(
      database,
      guildId,
      responseChannelSetting,
    );
    await interaction.reply({
      content:
        typeof channelId === "string"
          ? `Music responses are posted in <#${channelId}>.`
          : "No response channel is set; music updates appear in the command channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const queue = queues.get(guildId);
  if (subcommand === "play") {
    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: "Join a voice channel before queueing a video.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const url = interaction.options.getString("url", true).trim();
    if (play.yt_validate(url) !== "video") {
      await interaction.reply({
        content:
          "Provide a direct YouTube video URL. Playlists and search terms are not supported.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const details = await play.video_basic_info(url);
    const video = details.video_details;
    if (
      video.live ||
      video.durationInSec <= 0 ||
      video.durationInSec > 14_400
    ) {
      await interaction.editReply(
        "This video is live, unavailable, or longer than the 4-hour limit.",
      );
      return;
    }
    if (queue && queue.tracks.length >= maximumQueueSize) {
      await interaction.editReply(
        `The queue is full (maximum ${maximumQueueSize} videos).`,
      );
      return;
    }
    const track: Track = {
      url: video.url,
      title: video.title ?? "YouTube video",
      requestedBy: interaction.user.id,
    };
    const guildQueue =
      queue ??
      createQueue(
        guildId,
        voiceChannel.id,
        interaction.channelId ?? voiceChannel.id,
        client,
        database,
      );
    if (
      guildQueue.connection &&
      guildQueue.connection.joinConfig.channelId !== voiceChannel.id
    ) {
      await interaction.editReply(
        "The bot is already playing in another voice channel.",
      );
      return;
    }
    if (!queue) queues.set(guildId, guildQueue);
    if (!guildQueue.connection) {
      const botMember = guild.members.me ?? (await guild.members.fetchMe());
      const permissions = voiceChannel.permissionsFor(botMember);
      if (
        !permissions?.has(PermissionFlagsBits.Connect) ||
        !permissions.has(PermissionFlagsBits.Speak)
      ) {
        queues.delete(guildId);
        await interaction.editReply(
          "The bot needs Connect and Speak permissions in your voice channel.",
        );
        return;
      }
      guildQueue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      guildQueue.connection.subscribe(guildQueue.player);
      try {
        await entersState(
          guildQueue.connection,
          VoiceConnectionStatus.Ready,
          20_000,
        );
      } catch {
        guildQueue.connection.destroy();
        queues.delete(guildId);
        await interaction.editReply(
          "The bot could not connect to your voice channel.",
        );
        return;
      }
    }
    guildQueue.tracks.push(track);
    guildQueue.textChannelId =
      interaction.channelId ?? guildQueue.textChannelId;
    if (guildQueue.player.state.status === AudioPlayerStatus.Idle)
      void startNext(guildId);
    const position = guildQueue.tracks.length;
    await interaction.editReply(
      `Queued **${track.title}**${position > 1 ? ` at position ${position}` : ""}.`,
    );
    await announce(
      client,
      database,
      guildId,
      guildQueue.textChannelId,
      `Queued **${track.title}** — requested by <@${track.requestedBy}>.`,
    );
    return;
  }

  if (!queue || !queue.connection) {
    await interaction.reply({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "queue") {
    const listing = [
      ...(queue.current ? [`▶️ **Now playing:** ${queue.current.title}`] : []),
      ...queue.tracks
        .slice(0, 10)
        .map(
          (track, index) =>
            `${index + 1}. **${track.title}** — <@${track.requestedBy}>`,
        ),
    ];
    await interaction.reply({
      content: listing.length ? listing.join("\n") : "The queue is empty.",
      flags: MessageFlags.Ephemeral,
    });
    if (listing.length > 0) {
      await announce(
        client,
        database,
        guildId,
        queue.textChannelId,
        listing.join("\n"),
      );
    }
    return;
  }
  if (subcommand === "skip") {
    queue.generation += 1;
    delete queue.current;
    queue.player.stop(true);
    await interaction.reply({
      content: "Skipped the current video.",
      flags: MessageFlags.Ephemeral,
    });
    await announce(
      client,
      database,
      guildId,
      queue.textChannelId,
      `⏭️ <@${interaction.user.id}> skipped the current video.`,
    );
    return;
  }
  queue.generation += 1;
  delete queue.current;
  queue.tracks.length = 0;
  queue.player.stop(true);
  if (subcommand === "leave") {
    queue.connection.destroy();
    queues.delete(guildId);
  }
  await interaction.reply({
    content:
      subcommand === "leave"
        ? "Stopped playback and left the voice channel."
        : "Stopped playback and cleared the queue.",
    flags: MessageFlags.Ephemeral,
  });
  await announce(
    client,
    database,
    guildId,
    queue.textChannelId,
    subcommand === "leave"
      ? "⏹️ Playback stopped; I left the voice channel."
      : "⏹️ Playback stopped and the queue was cleared.",
  );
}

function createQueue(
  guildId: string,
  _voiceChannelId: string,
  textChannelId: string,
  client: Client,
  database: DatabaseSync,
): GuildQueue {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  player.on(AudioPlayerStatus.Idle, () => {
    const queue = queues.get(guildId);
    if (queue) delete queue.current;
    if (queue && !queue.starting) void startNext(guildId);
  });
  player.on("error", (error) => {
    const queue = queues.get(guildId);
    if (queue)
      void announce(
        queue.client,
        queue.database,
        guildId,
        queue.textChannelId,
        `Could not play the current video: ${error.message}`,
      );
  });
  return {
    tracks: [],
    player,
    textChannelId,
    starting: false,
    generation: 0,
    client,
    database,
  };
}

async function startNext(guildId: string): Promise<void> {
  const queue = queues.get(guildId);
  const track = queue?.tracks.shift();
  if (!queue || !track || queue.starting) return;
  queue.starting = true;
  queue.current = track;
  const generation = queue.generation;
  try {
    const stream = await play.stream(track.url, { quality: 2 });
    if (generation !== queue.generation) return;
    queue.player.play(
      createAudioResource(stream.stream, { inputType: stream.type }),
    );
    await announce(
      queue.client,
      queue.database,
      guildId,
      queue.textChannelId,
      `▶️ Now playing **${track.title}** — requested by <@${track.requestedBy}>.`,
    );
  } catch (error) {
    await announce(
      queue.client,
      queue.database,
      guildId,
      queue.textChannelId,
      `Could not play **${track.title}**: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    queue.starting = false;
    if (
      queue.player.state.status === AudioPlayerStatus.Idle &&
      queue.tracks.length > 0
    ) {
      void startNext(guildId);
    }
  }
}

async function announce(
  client: Client | undefined,
  database: DatabaseSync | undefined,
  guildId: string,
  fallbackChannelId: string,
  content: string,
): Promise<void> {
  if (!client || !database) return;
  const selected = getGuildSetting(database, guildId, responseChannelSetting);
  const channelId = typeof selected === "string" ? selected : fallbackChannelId;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased() && "send" in channel) {
    await (channel as GuildTextBasedChannel)
      .send({ content, allowedMentions: { parse: [] } })
      .catch(() => undefined);
  }
}
