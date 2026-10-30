import type { ChatInputCommandInteraction } from "discord.js";
import { serverInfoModule } from "./server-info.js";
import type { ReadOnlyFeatureModule } from "./types.js";

export const featureModules: readonly ReadOnlyFeatureModule[] = [
  serverInfoModule,
];

export const featureModuleCommands = featureModules.map(
  (module) => module.command,
);

export async function executeFeatureModule(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const module = featureModules.find(
    (candidate) => candidate.command.name === interaction.commandName,
  );
  if (!module) return false;

  await module.execute(interaction);
  return true;
}
