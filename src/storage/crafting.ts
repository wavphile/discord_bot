import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const wowheadGameVersions = [
  "forever",
  "classic",
  "tbc",
  "wotlk",
  "cata",
  "mop",
  "retail",
] as const;

export type WowheadGameVersion = (typeof wowheadGameVersions)[number];

export type CraftingSettings = Readonly<{
  guildId: string;
  gameVersion: WowheadGameVersion;
  crafterRoleId: string;
  queryChannelId: string;
}>;

export type WowheadRecipe = Readonly<{
  gameVersion: WowheadGameVersion;
  entityType: "item" | "recipe" | "spell";
  entityId: string;
  name: string;
  url: string;
}>;

export type Crafter = Readonly<{ userId: string }>;

export type CraftingRecipe = WowheadRecipe &
  Readonly<{ recipeId: string; crafters: readonly Crafter[] }>;

type SettingsRow = Readonly<{
  guild_id: string;
  game_version: string;
  crafter_role_id: string;
  query_channel_id: string;
}>;

type RecipeRow = Readonly<{
  recipe_id: string;
  wowhead_entity_type: WowheadRecipe["entityType"];
  wowhead_entity_id: string;
  recipe_name: string;
  wowhead_url: string;
}>;

type CrafterRow = Readonly<{ user_id: string }>;

export function isWowheadGameVersion(
  value: string,
): value is WowheadGameVersion {
  return (wowheadGameVersions as readonly string[]).includes(value);
}

export function getCraftingSettings(
  database: DatabaseSync,
  guildId: string,
): CraftingSettings | undefined {
  const row = database
    .prepare(
      `SELECT guild_id, game_version, crafter_role_id, query_channel_id
       FROM crafting_settings WHERE guild_id = ?`,
    )
    .get(guildId) as SettingsRow | undefined;
  if (!row || !isWowheadGameVersion(row.game_version)) return undefined;
  return {
    guildId: row.guild_id,
    gameVersion: row.game_version,
    crafterRoleId: row.crafter_role_id,
    queryChannelId: row.query_channel_id,
  };
}

export function setCraftingSettings(
  database: DatabaseSync,
  settings: CraftingSettings,
): void {
  database
    .prepare(
      `INSERT INTO crafting_settings
         (guild_id, game_version, crafter_role_id, query_channel_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         game_version = excluded.game_version,
         crafter_role_id = excluded.crafter_role_id,
         query_channel_id = excluded.query_channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      settings.guildId,
      settings.gameVersion,
      settings.crafterRoleId,
      settings.queryChannelId,
      new Date().toISOString(),
    );
}

export function addCrafter(
  database: DatabaseSync,
  guildId: string,
  recipe: WowheadRecipe,
  crafterId: string,
  addedBy: string,
): "added" | "already_registered" {
  let recipeId = (
    database
      .prepare(
        `SELECT recipe_id FROM crafting_recipes
         WHERE guild_id = ? AND game_version = ? AND wowhead_entity_type = ?
           AND wowhead_entity_id = ?`,
      )
      .get(guildId, recipe.gameVersion, recipe.entityType, recipe.entityId) as
      { recipe_id: string } | undefined
  )?.recipe_id;

  if (!recipeId) {
    recipeId = randomUUID();
    database
      .prepare(
        `INSERT INTO crafting_recipes
          (recipe_id, guild_id, game_version, wowhead_entity_type,
           wowhead_entity_id, recipe_name, wowhead_url, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recipeId,
        guildId,
        recipe.gameVersion,
        recipe.entityType,
        recipe.entityId,
        recipe.name,
        recipe.url,
        addedBy,
        new Date().toISOString(),
      );
  }

  const result = database
    .prepare(
      `INSERT INTO crafting_crafters (recipe_id, user_id, added_by, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(recipe_id, user_id) DO NOTHING`,
    )
    .run(recipeId, crafterId, addedBy, new Date().toISOString());
  return result.changes === 1 ? "added" : "already_registered";
}

export function removeCrafter(
  database: DatabaseSync,
  guildId: string,
  recipe: WowheadRecipe,
  crafterId: string,
): boolean {
  const result = database
    .prepare(
      `DELETE FROM crafting_crafters
       WHERE recipe_id = (
         SELECT recipe_id FROM crafting_recipes
         WHERE guild_id = ? AND game_version = ? AND wowhead_entity_type = ?
           AND wowhead_entity_id = ?
       ) AND user_id = ?`,
    )
    .run(
      guildId,
      recipe.gameVersion,
      recipe.entityType,
      recipe.entityId,
      crafterId,
    );
  return result.changes === 1;
}

export function findCraftingRecipe(
  database: DatabaseSync,
  guildId: string,
  gameVersion: WowheadGameVersion,
  query: string,
): CraftingRecipe | undefined {
  const linked = parseWowheadRecipeLink(query, gameVersion);
  const row = linked
    ? (database
        .prepare(
          `SELECT recipe_id, wowhead_entity_type, wowhead_entity_id,
                  recipe_name, wowhead_url
           FROM crafting_recipes
           WHERE guild_id = ? AND game_version = ? AND wowhead_entity_type = ?
             AND wowhead_entity_id = ?`,
        )
        .get(guildId, gameVersion, linked.entityType, linked.entityId) as
        RecipeRow | undefined)
    : (database
        .prepare(
          `SELECT recipe_id, wowhead_entity_type, wowhead_entity_id,
                  recipe_name, wowhead_url
           FROM crafting_recipes
           WHERE guild_id = ? AND game_version = ?
             AND recipe_name = ? COLLATE NOCASE
           ORDER BY recipe_name COLLATE NOCASE LIMIT 1`,
        )
        .get(guildId, gameVersion, query.trim()) as RecipeRow | undefined);
  if (!row) return undefined;

  const crafters = database
    .prepare(
      `SELECT user_id FROM crafting_crafters WHERE recipe_id = ? ORDER BY added_at`,
    )
    .all(row.recipe_id) as CrafterRow[];
  return {
    gameVersion,
    entityType: row.wowhead_entity_type,
    entityId: row.wowhead_entity_id,
    name: row.recipe_name,
    url: row.wowhead_url,
    recipeId: row.recipe_id,
    crafters: crafters.map(({ user_id }) => ({ userId: user_id })),
  };
}

export function parseWowheadRecipeLink(
  input: string,
  gameVersion: WowheadGameVersion,
): WowheadRecipe | undefined {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/^<|>$/g, ""));
  } catch {
    return undefined;
  }
  if (
    !["wowhead.com", "www.wowhead.com"].includes(url.hostname.toLowerCase()) ||
    url.protocol !== "https:"
  ) {
    return undefined;
  }

  const path = url.pathname.replace(/\/$/, "");
  const versionSegment = gameVersion === "retail" ? "" : `/${gameVersion}`;
  if (!path.startsWith(`${versionSegment}/`)) return undefined;
  const entityMatch = path
    .slice(versionSegment.length + 1)
    .match(/^(item|recipe|spell)=(\d+)(?:\/[^/]*)?$/);
  if (!entityMatch) return undefined;

  const entityType = entityMatch[1] as WowheadRecipe["entityType"];
  const entityId = entityMatch[2];
  return {
    gameVersion,
    entityType,
    entityId: entityId!,
    name: "",
    url: `https://www.wowhead.com/${gameVersion === "retail" ? "" : `${gameVersion}/`}${entityType}=${entityId}`,
  };
}

export function extractCraftingQuery(content: string): string | undefined {
  const query = content
    .replace(/<@!?\d+>/g, " ")
    .trim()
    .match(
      /^(?:who\s+(?:can\s+)?(?:craft|make)|who\s+crafts)\s+(.+?)[?!.,]*$/i,
    )?.[1]
    ?.trim()
    .replace(/^<(.+)>$/, "$1");
  if (!query || query.length > 200) return undefined;
  return query;
}

export type RecipeVerifier = (
  recipe: WowheadRecipe,
  signal: AbortSignal,
) => Promise<Readonly<{ name: string }> | undefined>;

export async function verifyWowheadRecipe(
  recipe: WowheadRecipe,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ name: string }> | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    let currentUrl = new URL(recipe.url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetcher(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent":
            "DiscordServerAssistant/1.0 (Wowhead recipe verification)",
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) return undefined;
      const nextUrl = new URL(location, currentUrl);
      const expectedPath = `/${recipe.gameVersion === "retail" ? "" : `${recipe.gameVersion}/`}${recipe.entityType}=${recipe.entityId}`;
      if (
        nextUrl.protocol !== "https:" ||
        !["wowhead.com", "www.wowhead.com"].includes(nextUrl.hostname) ||
        !nextUrl.pathname.startsWith(expectedPath)
      ) {
        return undefined;
      }
      currentUrl = nextUrl;
    }
    if (!response) return undefined;
    if (!response.ok) return undefined;
    const html = await response.text();
    const name = getWowheadTitle(html);
    if (!name) return undefined;
    return { name };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function getWowheadTitle(html: string): string | undefined {
  let title: string | undefined;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property =
      getHtmlAttribute(tag, "property") ?? getHtmlAttribute(tag, "name");
    if (property?.toLowerCase() !== "og:title") continue;
    title = getHtmlAttribute(tag, "content");
    if (title) break;
  }
  title ??= html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (!title) return undefined;
  const name = decodeHtmlEntities(title)
    .replace(/\s*[-|]\s*(?:item|recipe|spell|wowhead).*$/i, "")
    .trim();
  if (!name || /page not found|404|error/i.test(name)) return undefined;
  return name.slice(0, 200);
}

function getHtmlAttribute(tag: string, attribute: string): string | undefined {
  return tag.match(
    new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, "i"),
  )?.[1];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
