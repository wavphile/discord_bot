import type { DatabaseSync } from "node:sqlite";
import {
  defaultMessageRetrievalSettings,
  isMessageRetrievalSettings,
  type MessageProviderId,
  type MessageRetrievalSettings,
} from "../features/message-retrieval.js";
import { getGuildSetting, setGuildSetting } from "./guild-settings.js";

const settingKey = "message_retrieval";

export function getMessageRetrievalSettings(
  database: DatabaseSync,
  guildId: string,
  defaultProvider: MessageProviderId,
): MessageRetrievalSettings {
  const value = getGuildSetting(database, guildId, settingKey);
  if (value === undefined)
    return defaultMessageRetrievalSettings(defaultProvider);
  if (!isMessageRetrievalSettings(value)) {
    return defaultMessageRetrievalSettings(defaultProvider);
  }
  return {
    enabled: value.enabled,
    channelIds: [...value.channelIds],
    maxAgeDays: value.maxAgeDays,
    maxMessages: value.maxMessages,
    provider: value.provider,
  };
}

export function setMessageRetrievalSettings(
  database: DatabaseSync,
  guildId: string,
  settings: MessageRetrievalSettings,
): void {
  if (!isMessageRetrievalSettings(settings)) {
    throw new TypeError("message retrieval settings are invalid");
  }
  setGuildSetting(database, guildId, settingKey, {
    enabled: settings.enabled,
    channelIds: [...settings.channelIds],
    maxAgeDays: settings.maxAgeDays,
    maxMessages: settings.maxMessages,
    provider: settings.provider,
  });
}
