import assert from "node:assert/strict";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import test from "node:test";
import { commands } from "../src/discord/commands/index.js";
import {
  executeFeatureModule,
  featureModules,
} from "../src/discord/modules/index.js";
import { serverInfoModule } from "../src/discord/modules/server-info.js";

test("feature module commands are included in the deployable registry", () => {
  const names = commands.map((command) => command.name);
  assert.ok(names.includes("server-info"));
  assert.equal(new Set(names).size, names.length);
  assert.equal(featureModules.length, 1);
  assert.equal(featureModules[0]?.command.name, "server-info");
});

test("the read-only example replies privately without allowing mentions", async () => {
  const replies: Array<{
    content: string;
    flags: MessageFlags;
    allowedMentions?: { parse?: string[] };
  }> = [];
  const interaction = {
    commandName: "server-info",
    guild: {
      name: "Keta's Crackhouse @everyone",
      id: "123456789012345678",
      createdTimestamp: Date.UTC(2020, 0, 1),
    },
    reply: async (response: (typeof replies)[number]) => {
      replies.push(response);
    },
  } as unknown as ChatInputCommandInteraction;

  await serverInfoModule.execute(interaction);

  assert.equal(replies.length, 1);
  assert.match(
    replies[0]?.content ?? "",
    /Server: Keta's Crackhouse @everyone/,
  );
  assert.match(replies[0]?.content ?? "", /Server ID: 123456789012345678/);
  assert.equal(replies[0]?.flags, MessageFlags.Ephemeral);
  assert.deepEqual(replies[0]?.allowedMentions, { parse: [] });
});

test("the module dispatcher handles only registered feature commands", async () => {
  const replies: unknown[] = [];
  const interaction = {
    commandName: "server-info",
    guild: {
      name: "Example",
      id: "123456789012345678",
      createdTimestamp: Date.UTC(2020, 0, 1),
    },
    reply: async (response: unknown) => {
      replies.push(response);
    },
  } as unknown as ChatInputCommandInteraction;

  assert.equal(await executeFeatureModule(interaction), true);
  assert.equal(replies.length, 1);
  assert.equal(
    await executeFeatureModule({
      ...interaction,
      commandName: "unknown",
    } as ChatInputCommandInteraction),
    false,
  );
});
