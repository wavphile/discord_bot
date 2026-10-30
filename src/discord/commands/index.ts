import { healthCommand } from "./health.js";
import { planCommand } from "./plan.js";
import { permissionsCommand } from "./permissions.js";
import { serverCommand } from "./server.js";

export const commands = [
  healthCommand,
  permissionsCommand,
  serverCommand,
  planCommand,
];
