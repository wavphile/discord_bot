import { healthCommand } from "./health.js";
import { askCommand } from "./ask.js";
import { planCommand } from "./plan.js";
import { permissionsCommand } from "./permissions.js";
import { serverCommand } from "./server.js";
import { createMessagesCommand } from "./messages.js";
import { summarizeCommand } from "./summarize.js";
import { featureModuleCommands } from "../modules/index.js";
import type { MessageProviderId } from "../../features/message-retrieval.js";

export function createCommands(
  configuredMessageProviders: readonly MessageProviderId[] = [
    "mock",
    "openai",
    "anthropic",
  ],
) {
  return [
    healthCommand,
    askCommand,
    permissionsCommand,
    serverCommand,
    createMessagesCommand(configuredMessageProviders),
    summarizeCommand,
    planCommand,
    ...featureModuleCommands,
  ];
}

export const commands = createCommands();
