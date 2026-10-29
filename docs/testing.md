# Trying the bot

Use a separate Discord application and a private test server for development. Keep the bot token in your local `.env` file; never add it to a pull request, issue, workflow, or chat. GitHub Actions checks the code without Discord credentials and does not deploy PR code to a live bot.

## One-time Discord setup

1. Create a development application in the [Discord Developer Portal](https://discord.com/developers/applications) and add its bot user.
2. Create a private test server that has no real members or production data.
3. In the portal's installation settings, enable **Guild Install** and use the `bot` and `applications.commands` scopes. Start with no bot permissions; `/health` does not need to read or change server data. Install the app only into the test server.
4. Copy the bot token and application ID. In Discord, enable Developer Mode, then copy the test server ID.
5. In the repository root, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` in macOS/Linux) and fill in `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_DEV_GUILD_ID`.

Do not enable privileged intents until a feature needs them. Review the permissions and data access for each new feature before trying it.

## Try a pull request

Clone the repository once, or use your existing checkout:

```sh
git clone https://github.com/wavphile/discord_bot.git
cd discord_bot
```

For a pull request, substitute its number for `<PR-number>`:

```sh
git fetch origin pull/<PR-number>/head
git switch --detach FETCH_HEAD
npm ci
npm run deploy:commands
npm run dev
```

Keep the bot running, open the test server, and follow the pull request's **Try it** steps. Run `/health`; it should privately report that the bot is responding and SQLite schema v1 is ready. Press Ctrl+C to stop the local bot.

The PR's guild-scoped command registration updates commands in the configured test server immediately. It does not change commands in other servers. `.env` is ignored by Git and is preserved when switching commits.

### Try the storage migration and restart persistence

The storage foundation has no configuration-writing Discord command yet. You can exercise the same SQLite store with the local tryout command, using your test server ID and a harmless marker:

```sh
npm run storage:tryout -- write <test-server-id>
npm run storage:tryout -- verify <test-server-id>
```

The first command writes a marker and exits; the second opens the database in a new process and confirms the value survived. For Docker Compose, run `docker compose exec bot node dist/storage/tryout.js write <test-server-id>`, restart with `docker compose restart bot`, then run `docker compose exec bot node dist/storage/tryout.js verify <test-server-id>`. The marker is stored under `storage_tryout_marker` for that test server. `/health` also reports the active SQLite schema version.

To return to the merged version afterward:

```sh
git switch main
git pull --ff-only
npm ci
npm run deploy:commands
npm run dev
```

## Automated pull request checks

Every pull request and push to `main` runs the same local checks with `npm run check`. The workflow uses the committed lockfile and Node.js version from `.nvmrc`; it has read-only repository access and no bot or AI secrets.

The current checks cover formatting, TypeScript type checking, and compilation. Feature-specific automated tests will be added with the behavior they exercise. A pull request should state what can be tried, how to trigger it, the expected result, and any required setup or permissions.
