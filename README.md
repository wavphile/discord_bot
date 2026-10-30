# Discord server assistant

A self-hosted Discord bot for server configuration inspection, permission explanations, reviewed batch changes, and bounded AI assistance. See [the implementation plan](docs/project-plan.md) for scope, milestones, safety requirements, and release gates, and the [supported settings matrix](docs/supported-settings.md) for the initial API boundary.

## Development setup

Requirements: Node.js 24.15 or newer in the 24.x line and an application created in the Discord Developer Portal. The bot requests only the Guilds intent by default; configuration inspection does not require privileged intents. Optional member and message capabilities stay disabled unless a feature requires them and you explicitly opt in with `DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true` or `DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true`. Enable the matching privileged intent on the application's **Bot → Privileged Gateway Intents** page before restarting. The bot must be a member of the test server and have **View Channel** in channels it should inspect.

To try a pull request against a safe Discord test server, follow [the testing guide](docs/testing.md). Pull requests include a runnable tryout section, and GitHub Actions checks formatting, types, and the production build without Discord credentials.

1. Copy `.env.example` to `.env` and set the bot token, application ID, development server ID, and at least one allowed test user or role ID. Keep `.env` private.
2. Install dependencies with `npm ci`.
3. Register the development command with `npm run deploy:commands`.
4. Start the bot with `npm run dev` and try `/health`, `/server inspect`, and `/permissions explain` in the development server.

`/permissions explain` privately checks **View Channel**, **Send Messages**, and the separate **Send Messages in Threads** permission for a selected member in a text or announcement channel. It is read-only. See [permission calculation details and limitations](docs/permissions.md).

`/ask` accepts a channel, a member, or both. A member-only question uses a fresh role and permission read without requiring a saved channel snapshot. The bot does not collect message activity; questions about message history are declined until a dated activity source exists.

Build the production JavaScript with `npm run build`; run it with `npm start`.

## Docker Compose

After creating `.env`, build and start the bot with `docker compose up --build -d`. To register or update the development slash command, run `npm run deploy:commands` in a Node.js environment with the same `.env` values. View service output with `docker compose logs -f bot` and stop it with `docker compose down`.

The bot creates a versioned SQLite database at `DATABASE_PATH` (default `./data/discord-bot.sqlite`). Docker Compose stores it in the persistent `bot-data` volume. The current schema stores per-guild JSON settings and configuration snapshots; it does not store Discord message content or member lists. Do not add real tokens, AI keys, server exports, or database files to Git.

`docker compose down` keeps the `bot-data` volume. Use `docker compose down --volumes` only when you intend to delete the stored database.
