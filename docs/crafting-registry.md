# Guild crafter registry

The crafter registry tracks guild members against Wowhead recipe, item, or spell pages. Each guild configures one Wowhead game database, one role that may maintain listings, and one text channel for questions. The bot keeps Discord user IDs and resolves them to current mentions when it answers.

Supported Wowhead databases are WoW Forever, Classic Era, The Burning Crusade, Wrath of the Lich King, Cataclysm, Mists of Pandaria, and Retail. Wowhead's URL path must match the selected database (for example, `/wotlk/item=19019`). A page is checked against Wowhead when a crafter listing is added or removed. A failed or unavailable Wowhead page is not stored.

## Setup

Enable **Message Content Intent** for the application in **Discord Developer Portal → Bot → Privileged Gateway Intents**, set `DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true` in the bot's `.env`, and restart it. Discord requires this privileged intent for the bot to read normal message text. The default remains disabled. The bot also needs View Channel and Send Messages in the question channel.

In the server, a member with **Manage Server** runs:

```text
/crafting setup game:wotlk crafter_role:@Crafter query_channel:#crafting
/crafting settings
```

Replace the example game, role, and channel with the guild's choices. Running setup again replaces those settings; it does not delete existing registrations.

## Maintain listings

Members with the selected crafter role can add or remove guild members. Use the matching Wowhead page for the configured database:

```text
/crafting add recipe:https://www.wowhead.com/wotlk/item=19019 crafter:@Member
/crafting remove recipe:https://www.wowhead.com/wotlk/item=19019 crafter:@Member
```

The bot checks that the Wowhead page exists and saves its display name, canonical link, game database, recipe/entity ID, and crafter's Discord user ID. Duplicate registrations are ignored. The listing is guild-scoped. Removing the final crafter keeps the recipe page in the registry so later questions can report that nobody is listed.

## Ask in the configured channel

Any guild member can ask in the configured question channel using regular text:

```text
Who can craft Lionheart Helm?
Who can craft https://www.wowhead.com/wotlk/item=12779
```

The bot only responds to explicit “who can craft/make” or “who crafts” questions. It matches item names exactly without regard to letter case, or matches a Wowhead page by its entity type and ID. Other messages and questions in other channels receive no bot response. Returned crafter mentions use Discord IDs, and mention parsing stays disabled for all other user or page text.

The bot does not search all of Wowhead for an unregistered name. A crafter must first add that page to the guild registry. The game database is a per-guild setting rather than a per-user choice.
