# Feature modules

This guide describes how to add an in-repository, read-only Discord command without changing the central interaction dispatcher or any AI provider or plan executor. Modules are trusted application code, not runtime-loaded third-party plugins.

## Module contract

`ReadOnlyFeatureModule` in `src/discord/modules/types.ts` has two parts:

- `command`: a Discord `SlashCommandBuilder` that defines the command name, description, and any options.
- `execute`: an async handler that receives the authorized `ChatInputCommandInteraction` and returns a private reply.

The bot checks every interaction against the configured test server and user/role allowlist before it reaches a handler. That check applies to modules automatically. A module that reads member, channel, or message data must still check the requester's current access to each selected object and explain any required bot permissions. Do not widen or bypass the shared authorization policy.

The interface is intentionally narrow: it gives a read-only module no database handle, AI provider, or plan-job executor. A feature that changes Discord settings must use the reviewed plan and approval flow instead of adding direct writes to a read-only module.

## Example

`src/discord/modules/server-info.ts` implements `/server-info`. It reads only the guild object already attached to the interaction and replies ephemerally with the guild name, creation time, and server ID. It makes no additional Discord request, uses no AI provider, and changes no state. `allowedMentions: { parse: [] }` prevents a server name from pinging users or roles.

Create a module with this shape:

```ts
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { ReadOnlyFeatureModule } from "./types.js";

const command = new SlashCommandBuilder()
  .setName("my-read-only-command")
  .setDescription("Describe the read-only result.");

async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: "A short, verified result.",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export const myModule = { command, execute } satisfies ReadOnlyFeatureModule;
```

If the command accepts options, define their types and required state in the builder. Treat option values and Discord-returned text as untrusted input. Validate values at the feature boundary before using them, constrain targets to the current guild, and keep replies private when they contain administrative information. Disable mention parsing when returning text that came from users, channels, roles, or the server itself.

## Register and dispatch

1. Add the module to `featureModules` in `src/discord/modules/index.ts`.
2. Add focused unit tests for registry inclusion, validation and authorization boundaries, and response behavior.
3. The module command is automatically included in `src/discord/commands/index.ts`, which is the source used by `npm run deploy:commands`.
4. `src/bot.ts` routes commands not handled by existing built-in commands through `executeFeatureModule`. Do not add a new `else if` branch there for each module.
5. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run format:check`. Then follow the PR's **Try it** steps in [testing.md](testing.md).

The shared interaction authorizer runs before module dispatch. Do not duplicate or weaken that check. If your feature needs a permission beyond the configured requester allowlist, perform a fresh, feature-specific check before accessing that data. For any write behavior, use the existing change-plan flow; a module should not call Discord mutation methods directly.
