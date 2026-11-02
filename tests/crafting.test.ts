import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Events, type Client, type Message } from "discord.js";
import test from "node:test";
import {
  extractCraftingQuery,
  findCraftingRecipe,
  getCraftingSettings,
  parseWowheadRecipeLink,
  setCraftingSettings,
  addCrafter,
  removeCrafter,
  verifyWowheadRecipe,
} from "../src/storage/crafting.js";
import { openDatabase } from "../src/storage/database.js";
import { registerCraftingMessageEvents } from "../src/discord/crafting-messages.js";
import {
  canChangeCrafterListing,
  craftingCommand,
  formatCrafterReply,
} from "../src/discord/commands/crafting.js";

const guildId = "123456789012345678";
const recipeUrl = "https://www.wowhead.com/wotlk/item=12345/arcane-barrier";
const recipe = parseWowheadRecipeLink(recipeUrl, "wotlk");
if (!recipe) throw new Error("Test recipe URL was not parsed.");

test("Wowhead recipe links require HTTPS, the configured site, game, and entity URL", () => {
  assert.equal(parseWowheadRecipeLink(recipeUrl, "wotlk")?.entityId, "12345");
  assert.equal(
    parseWowheadRecipeLink("https://www.wowhead.com/item=12345", "retail")
      ?.entityType,
    "item",
  );
  assert.equal(parseWowheadRecipeLink(recipeUrl, "classic"), undefined);
  assert.equal(
    parseWowheadRecipeLink("http://www.wowhead.com/wotlk/item=12345", "wotlk"),
    undefined,
  );
  assert.equal(
    parseWowheadRecipeLink("https://notwowhead.com/wotlk/item=12345", "wotlk"),
    undefined,
  );
  assert.equal(
    parseWowheadRecipeLink(
      "https://www.wowhead.com/wotlk/guide=12345",
      "wotlk",
    ),
    undefined,
  );
});

test("plain text crafting queries are narrowly recognized and parsed", () => {
  assert.equal(
    extractCraftingQuery("who can craft Arcane Barrier?"),
    "Arcane Barrier",
  );
  assert.equal(extractCraftingQuery(`Who crafts ${recipeUrl}?`), recipeUrl);
  assert.equal(
    extractCraftingQuery("<@123456789012345678> who can make Arcane Barrier"),
    "Arcane Barrier",
  );
  assert.equal(extractCraftingQuery("I can craft Arcane Barrier"), undefined);
  assert.equal(
    extractCraftingQuery(`who can craft ${"x".repeat(201)}`),
    undefined,
  );
});

test("Wowhead verification reads a page title and rejects missing pages", async () => {
  const ok = await verifyWowheadRecipe(
    recipe,
    async () =>
      new Response(
        '<meta property="og:title" content="Arcane Barrier - Item - Wowhead">',
        {
          status: 200,
        },
      ),
  );
  assert.deepEqual(ok, { name: "Arcane Barrier" });

  const missing = await verifyWowheadRecipe(
    recipe,
    async () => new Response("not found", { status: 404 }),
  );
  assert.equal(missing, undefined);

  const htmlError = await verifyWowheadRecipe(
    recipe,
    async () => new Response("<title>Page not found</title>", { status: 200 }),
  );
  assert.equal(htmlError, undefined);
});

test("Wowhead verification follows only redirects that stay on the same page", async () => {
  const requested: string[] = [];
  const verified = await verifyWowheadRecipe(recipe, async (input) => {
    requested.push(String(input));
    if (requested.length === 1) {
      return new Response(null, {
        status: 301,
        headers: {
          location: `${recipeUrl}/arcane-barrier`,
        },
      });
    }
    return new Response('<meta content="Arcane Barrier" property="og:title">');
  });
  assert.deepEqual(verified, { name: "Arcane Barrier" });
  assert.equal(requested.length, 2);

  const externalRedirect = await verifyWowheadRecipe(
    recipe,
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/item=12345" },
      }),
  );
  assert.equal(externalRedirect, undefined);
});

test("crafter replies escape page text and allow only registered-user mentions", () => {
  const reply = formatCrafterReply(
    "Sword [@everyone]",
    [{ userId: "444444444444444444" }],
    recipeUrl,
  );
  assert.match(reply.content, /@​everyone/);
  assert.deepEqual(reply.allowedMentions, {
    parse: [],
    users: ["444444444444444444"],
  });
});

test("members can manage their own listings while the configured role manages others", () => {
  const actorId = "444444444444444444";
  const otherId = "555555555555555555";
  const roleId = "222222222222222222";
  const member = { roles: [roleId] } as unknown as Parameters<
    typeof canChangeCrafterListing
  >[0];

  assert.equal(canChangeCrafterListing(member, roleId, actorId, actorId), true);
  assert.equal(canChangeCrafterListing(member, roleId, actorId, otherId), true);
  const memberWithoutRole = { roles: [] } as unknown as Parameters<
    typeof canChangeCrafterListing
  >[0];
  assert.equal(
    canChangeCrafterListing(memberWithoutRole, roleId, actorId, actorId),
    true,
  );
  assert.equal(
    canChangeCrafterListing(memberWithoutRole, roleId, actorId, otherId),
    false,
  );
});

test("the crafter argument is optional for self-service add and remove", () => {
  const subcommands = craftingCommand.toJSON().options as unknown as Array<{
    name: string;
    options?: Array<{ name: string; required?: boolean }>;
  }>;
  for (const name of ["add", "remove"]) {
    const subcommand = subcommands.find((option) => option.name === name);
    const crafter = subcommand?.options?.find(
      (option) => option.name === "crafter",
    );
    assert.ok(crafter);
    assert.equal(crafter.required, false);
  }
});

test("the crafter registry stores setup, recipe pages, and unique Discord users", () => {
  const database = openDatabase(":memory:");
  try {
    setCraftingSettings(database, {
      guildId,
      gameVersion: "wotlk",
      crafterRoleId: "222222222222222222",
      queryChannelId: "333333333333333333",
    });
    assert.deepEqual(getCraftingSettings(database, guildId), {
      guildId,
      gameVersion: "wotlk",
      crafterRoleId: "222222222222222222",
      queryChannelId: "333333333333333333",
    });
    assert.equal(
      addCrafter(
        database,
        guildId,
        { ...recipe, name: "Arcane Barrier" },
        "444444444444444444",
        "555555555555555555",
      ),
      "added",
    );
    assert.equal(
      addCrafter(
        database,
        guildId,
        { ...recipe, name: "Arcane Barrier" },
        "444444444444444444",
        "555555555555555555",
      ),
      "already_registered",
    );
    assert.deepEqual(
      findCraftingRecipe(database, guildId, "wotlk", "arcane barrier")
        ?.crafters,
      [{ userId: "444444444444444444" }],
    );
    assert.equal(
      findCraftingRecipe(database, guildId, "wotlk", recipeUrl)?.name,
      "Arcane Barrier",
    );
    assert.equal(
      removeCrafter(database, guildId, recipe, "444444444444444444"),
      true,
    );
    assert.deepEqual(
      findCraftingRecipe(database, guildId, "wotlk", "Arcane Barrier")
        ?.crafters,
      [],
    );
  } finally {
    database.close();
  }
});

test("plain text replies only in the configured guild channel and tags registered users", async () => {
  const database = openDatabase(":memory:");
  const client = new EventEmitter() as Client;
  const replies: Array<{
    channelId: string;
    content: string;
    allowedMentions?: unknown;
  }> = [];
  try {
    setCraftingSettings(database, {
      guildId,
      gameVersion: "wotlk",
      crafterRoleId: "222222222222222222",
      queryChannelId: "333333333333333333",
    });
    addCrafter(
      database,
      guildId,
      { ...recipe, name: "Arcane Barrier" },
      "444444444444444444",
      "555555555555555555",
    );
    const stop = registerCraftingMessageEvents(client, database, true, guildId);
    const listener = client.listeners(Events.MessageCreate)[0] as unknown as (
      message: Message,
    ) => Promise<void>;
    const emitMessage = async (overrides: {
      guildId?: string;
      channelId?: string;
      authorBot?: boolean;
    }) => {
      const message = {
        author: { bot: overrides.authorBot ?? false },
        guildId: overrides.guildId ?? guildId,
        channelId: overrides.channelId ?? "333333333333333333",
        content: "who can craft Arcane Barrier?",
        reply: async (value: {
          content: string;
          allowedMentions?: unknown;
        }) => {
          replies.push({ channelId: message.channelId, ...value });
        },
        ...overrides,
      } as unknown as Message;
      await listener(message);
    };
    await emitMessage({});
    await emitMessage({ channelId: "999999999999999999" });
    await emitMessage({ guildId: "888888888888888888" });
    await emitMessage({ authorBot: true });
    stop();

    assert.equal(replies.length, 1);
    assert.match(replies[0]?.content ?? "", /<@444444444444444444>/);
    assert.deepEqual(replies[0]?.allowedMentions, {
      parse: [],
      users: ["444444444444444444"],
    });
  } finally {
    database.close();
  }
});
