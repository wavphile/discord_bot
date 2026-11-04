import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
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
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
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
  audioProcess?: ChildProcessByStdio<null, Readable, Readable>;
  client: Client;
  database: DatabaseSync;
};

const queues = new Map<string, GuildQueue>();
const responseChannelSetting = "music.response_channel";
const maximumQueueSize = 50;

export function stopMusicPlayback(): void {
  for (const queue of queues.values()) {
    queue.tracks.length = 0;
    queue.audioProcess?.kill();
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
    if (!isYouTubeVideoUrl(url)) {
      await interaction.reply({
        content:
          "Provide a direct YouTube video URL. Playlists and search terms are not supported.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let video: YouTubeVideoInfo;
    try {
      video = await getYouTubeVideoInfo(url);
    } catch (error) {
      await interaction.editReply(
        error instanceof Error
          ? error.message
          : "Could not read this YouTube video.",
      );
      return;
    }
    if (video.isLive || video.duration <= 0 || video.duration > 14_400) {
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
      url,
      title: video.title,
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
    delete queue.current;
    queue.audioProcess?.kill();
    delete queue.audioProcess;
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
  delete queue.current;
  queue.tracks.length = 0;
  queue.audioProcess?.kill();
  delete queue.audioProcess;
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
  try {
    const audioProcess = spawn(
      "yt-dlp",
      [
        ...commonYoutubeDlArgs,
        "--format",
        "bestaudio[acodec=opus]",
        "--output",
        "-",
        "--",
        track.url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    queue.audioProcess = audioProcess;
    audioProcess.stderr.resume();
    audioProcess.once("error", () => {
      if (queue.audioProcess === audioProcess) {
        delete queue.audioProcess;
        queue.player.stop(true);
        void announce(
          queue.client,
          queue.database,
          guildId,
          queue.textChannelId,
          "Could not start yt-dlp. Install yt-dlp with YouTube JavaScript support and make sure it is on PATH.",
        );
      }
    });
    audioProcess.once("close", (code) => {
      if (queue.audioProcess === audioProcess) delete queue.audioProcess;
      if (code !== 0 && queue.player.state.status !== AudioPlayerStatus.Idle) {
        queue.player.stop(true);
        void announce(
          queue.client,
          queue.database,
          guildId,
          queue.textChannelId,
          `Could not play **${track.title}**. YouTube could not provide an Opus audio stream.`,
        );
      }
    });
    queue.player.play(
      createAudioResource(audioProcess.stdout, {
        inputType: StreamType.WebmOpus,
      }),
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

type YouTubeVideoInfo = Readonly<{
  title: string;
  duration: number;
  isLive: boolean;
}>;

const commonYoutubeDlArgs = [
  "--no-config",
  "--no-warnings",
  "--quiet",
  "--no-progress",
  "--socket-timeout",
  "20",
  "--retries",
  "1",
  "--extractor-retries",
  "1",
  "--js-runtimes",
  "node",
  "--no-playlist",
] as const;

export function isYouTubeVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      ((hostname === "youtube.com" || hostname.endsWith(".youtube.com")) &&
        url.pathname === "/watch" &&
        Boolean(url.searchParams.get("v"))) ||
      ((hostname === "youtu.be" || hostname.endsWith(".youtu.be")) &&
        url.pathname.length > 1)
    );
  } catch {
    return false;
  }
}

function getYouTubeVideoInfo(url: string): Promise<YouTubeVideoInfo> {
  return new Promise((resolve, reject) => {
    const infoProcess = spawn(
      "yt-dlp",
      [
        ...commonYoutubeDlArgs,
        "--format",
        "bestaudio[acodec=opus]",
        "--dump-single-json",
        "--",
        url,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let output = "";
    const timeout = setTimeout(() => {
      infoProcess.kill();
      reject(new Error("YouTube video lookup timed out. Please try again."));
    }, 60_000);
    infoProcess.stdout.setEncoding("utf8");
    infoProcess.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) {
        infoProcess.kill();
        clearTimeout(timeout);
        reject(new Error("YouTube returned too much video metadata."));
      }
    });
    infoProcess.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        error.message.includes("ENOENT")
          ? new Error(
              "yt-dlp is required for YouTube playback. Install yt-dlp with YouTube JavaScript support and make sure it is on PATH.",
            )
          : new Error("Could not start YouTube video lookup."),
      );
    });
    infoProcess.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            "Could not read this YouTube video. Check the URL and try another video.",
          ),
        );
        return;
      }
      try {
        const metadata = JSON.parse(output) as {
          title?: unknown;
          duration?: unknown;
          is_live?: unknown;
        };
        if (
          typeof metadata.title !== "string" ||
          typeof metadata.duration !== "number"
        ) {
          throw new Error("Video metadata is incomplete.");
        }
        resolve({
          title: metadata.title,
          duration: metadata.duration,
          isLive: metadata.is_live === true,
        });
      } catch {
        reject(new Error("Could not read this YouTube video's metadata."));
      }
    });
  });
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
