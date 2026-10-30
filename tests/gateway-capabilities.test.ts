import assert from "node:assert/strict";
import test from "node:test";
import { GatewayIntentBits, MessageFlags } from "discord.js";
import { booleanEnv } from "../src/config/boolean-env.js";
import { executeHealthCommand } from "../src/discord/commands/health.js";
import {
  createGatewayIntents,
  formatConfiguredGatewayCapabilities,
  isDisallowedGatewayIntentsError,
  unavailableGatewayCapabilityMessage,
  type GatewayCapabilities,
} from "../src/discord/gateway-capabilities.js";

const disabled: GatewayCapabilities = {
  guildMembers: false,
  messageContent: false,
};

test("optional intent environment flags default off and parse only explicit booleans", () => {
  assert.equal(booleanEnv.parse(undefined), false);
  assert.equal(booleanEnv.parse("false"), false);
  assert.equal(booleanEnv.parse("true"), true);
  assert.throws(() => booleanEnv.parse("yes"));
});

test("the default Gateway request contains only the non-privileged Guilds intent", () => {
  assert.deepEqual(createGatewayIntents(disabled), [GatewayIntentBits.Guilds]);
});

test("member and message capabilities opt in only to their respective intents", () => {
  assert.deepEqual(createGatewayIntents({ ...disabled, guildMembers: true }), [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  assert.deepEqual(
    createGatewayIntents({ ...disabled, messageContent: true }),
    [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  );
  assert.deepEqual(
    createGatewayIntents({ guildMembers: true, messageContent: true }),
    [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  );
});

test("unavailable capability explanations give the exact setting and portal path", () => {
  const members = unavailableGatewayCapabilityMessage("guildMembers", disabled);
  const content = unavailableGatewayCapabilityMessage(
    "messageContent",
    disabled,
  );

  assert.match(members ?? "", /DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true/);
  assert.match(members ?? "", /Server Members Intent/);
  assert.match(content ?? "", /DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true/);
  assert.match(content ?? "", /Message Content Intent/);
  assert.equal(
    unavailableGatewayCapabilityMessage("guildMembers", {
      ...disabled,
      guildMembers: true,
    }),
    undefined,
  );
});

test("health capability labels state whether optional intents are configured", () => {
  assert.equal(
    formatConfiguredGatewayCapabilities(disabled),
    "Server Members disabled; Message Content disabled",
  );
  assert.equal(
    formatConfiguredGatewayCapabilities({
      guildMembers: true,
      messageContent: true,
    }),
    "Server Members enabled; Message Content enabled",
  );
});

test("/health privately reports storage and configured optional intents", async () => {
  let reply: { content: string; flags: MessageFlags.Ephemeral } | undefined;
  const interaction = {
    reply: async (value: {
      content: string;
      flags: MessageFlags.Ephemeral;
    }) => {
      reply = value;
    },
  };

  await executeHealthCommand(interaction as never, 8, {
    ...disabled,
    messageContent: true,
  });

  assert.match(reply?.content ?? "", /schema v8/);
  assert.match(reply?.content ?? "", /Server Members disabled/);
  assert.match(reply?.content ?? "", /Message Content enabled/);
  assert.equal(reply?.flags, MessageFlags.Ephemeral);
});

test("disallowed privileged intents are recognized for actionable startup logs", () => {
  assert.equal(
    isDisallowedGatewayIntentsError(new Error("Used disallowed intents")),
    true,
  );
  assert.equal(
    isDisallowedGatewayIntentsError(new Error("Gateway close 4014")),
    true,
  );
  assert.equal(
    isDisallowedGatewayIntentsError(new Error("Invalid token")),
    false,
  );
  assert.equal(
    isDisallowedGatewayIntentsError("Used disallowed intents"),
    false,
  );
});
