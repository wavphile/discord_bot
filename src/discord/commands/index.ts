import { healthCommand } from "./health.js";
import { askCommand } from "./ask.js";
import { planCommand } from "./plan.js";
import { permissionsCommand } from "./permissions.js";
import { serverCommand } from "./server.js";
import { messagesCommand } from "./messages.js";
import { summarizeCommand } from "./summarize.js";
import { featureModuleCommands } from "../modules/index.js";

export const commands = [
  healthCommand,
  askCommand,
  permissionsCommand,
  serverCommand,
  messagesCommand,
  summarizeCommand,
  planCommand,
  ...featureModuleCommands,
];
