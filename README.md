# Discord server assistant

A self-hosted Discord bot for server configuration inspection, permission explanations, reviewed batch changes, and bounded AI assistance. See [the implementation plan](docs/project-plan.md) for scope, milestones, safety requirements, and release gates, and the [supported settings matrix](docs/supported-settings.md) for the initial API boundary.

## Development setup

Requirements: Node.js 24.15 or newer in the 24.x line and an application created in the Discord Developer Portal. The bot requests only the Guilds intent by default; configuration inspection does not require privileged intents. Optional member and message capabilities stay disabled unless a feature requires them and you explicitly opt in with `DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true` or `DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true`. Enable the matching privileged intent on the application's **Bot → Privileged Gateway Intents** page before restarting. The bot must be a member of the test server and have **View Channel** in channels it should inspect.

To try a pull request against a safe Discord test server, follow [the testing guide](docs/testing.md). Pull requests include a runnable tryout section, and GitHub Actions checks formatting, types, and the production build without Discord credentials.

For the in-repository read-only command-module contract and a complete example, see [the feature module guide](docs/modules.md).

1. Copy `.env.example` to `.env` and set the bot token, application ID, development server ID, and at least one allowed test user or role ID. Keep `.env` private.
2. Install dependencies with `npm ci`.
3. Register the development command with `npm run deploy:commands`.
4. Start the bot with `npm run dev` and try `/health`, `/server inspect`, and `/permissions explain` in the development server.

`/permissions explain` privately checks **View Channel**, **Send Messages**, and the separate **Send Messages in Threads** permission for a selected member in a text or announcement channel. It is read-only. See [permission calculation details and limitations](docs/permissions.md).

`/ask` accepts a channel, a member, or both. A member-only question uses a fresh role and permission read without requiring a saved channel snapshot. Recent-message questions require an explicit server-admin opt-in for each source channel, Message Content Intent, current requester and bot history access, and `/ask include_messages:true`. `/summarize channel:#bots` uses the same opt-in, limits, and access checks, then returns a private summary with validated links to its supporting messages. Retrieval is limited to 1–7 days and 1–50 messages per request; message text is fetched on demand and is not stored by the bot. With the default mock provider, it is not sent to a hosted service and summaries are labeled as test output. Review [provider data handling](docs/ai-providers.md) before selecting a hosted provider, and follow [the testing guide](docs/testing.md) for setup and permission details.

Build the production JavaScript with `npm run build`; run it with `npm start`.

## Docker Compose

After creating `.env`, build and start the bot with `docker compose up --build -d`. To register or update the development slash command, run `npm run deploy:commands` in a Node.js environment with the same `.env` values. View service output with `docker compose logs -f bot` and stop it with `docker compose down`.

The bot creates a versioned SQLite database at `DATABASE_PATH` (default `./data/discord-bot.sqlite`). Docker Compose stores it in the persistent `bot-data` volume. The database stores per-guild JSON settings and configuration snapshots. Human-authored message text is stored only when a server administrator explicitly enables retention for a channel, for the configured 1–7 day period; see the [retention guide](docs/testing.md#retained-message-storage-and-purge). Do not add real tokens, AI keys, server exports, or database files to Git.

`docker compose down` keeps the `bot-data` volume. Use `docker compose down --volumes` only when you intend to delete the stored database.

For an amd64 Linux VM or a 64-bit Raspberry Pi, use the same tagged source revision on both hosts and follow the [deployment verification guide](docs/deployment.md). CI builds and smoke-tests Linux images on native amd64 and arm64 runners; physical VM and Raspberry Pi measurements are still required before the M5 release gate can pass.
