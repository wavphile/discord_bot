# Trying the bot

Use a separate Discord application and a private test server for development. Keep the bot token in your local `.env` file; never add it to a pull request, issue, workflow, or chat. GitHub Actions checks the code without Discord credentials and does not deploy PR code to a live bot.

## One-time Discord setup

1. Create a development application in the [Discord Developer Portal](https://discord.com/developers/applications) and add its bot user.
2. Create a private test server that has no real members or production data.
3. In the portal's installation settings, enable **Guild Install** and use the `bot` and `applications.commands` scopes. Start with no bot permissions; `/health` does not need to read or change server data. Install the app only into the test server.
4. Copy the bot token and application ID. In Discord, enable Developer Mode, then copy the test server ID and your user ID. Copy role IDs too if you want to authorize a test role.
5. In the repository root, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env`) and fill in `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_DEV_GUILD_ID`.
6. Set `DISCORD_ALLOWED_USER_IDS` to your user ID and optionally `DISCORD_ALLOWED_ROLE_IDS` to comma-separated test role IDs. At least one allowlisted user or role is required; an empty allowlist denies every command. Keep the allowlist narrow and do not add `@everyone`.

Administrative interactions are accepted only in `DISCORD_DEV_GUILD_ID`. The bot checks the requester against the configured user and role IDs before dispatching any interaction. DMs and other servers are denied. Do not enable privileged intents until a feature needs them. Review the permissions and data access for each new feature before trying it.

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

Keep the bot running, open the test server, and follow the pull request's **Try it** steps. Run `/health`; it should privately report that the bot is responding and SQLite schema v2 is ready. Run `/server inspect`; it should privately report a snapshot ID, capture time, role/category/channel/overwrite counts, and limited channel visibility. The command stores a configuration snapshot in SQLite. It does not change server settings and is not a complete server backup. Press Ctrl+C to stop the local bot.

### Windows PowerShell helper

After `scripts/try-pr.ps1` is available in your checkout, run this from the repository:

```powershell
.\scripts\try-pr.ps1 -PullRequestNumber 6
```

If PowerShell blocks local scripts, run it in a one-off PowerShell process:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\try-pr.ps1 -PullRequestNumber 6
```

The helper requires a clean checkout, Node.js 24.15 or newer in the 24.x line, and at least one valid allowed test user or role ID in `.env`. It creates `.env` from the example and stops if you need to fill it in. It fetches the PR's current head into a local `try/pr-<number>` branch, installs locked dependencies, shows the application and test server IDs plus allowlist counts without displaying the token or IDs, and asks you to type `DEPLOY` before registering guild-scoped commands. It then starts the bot in the foreground. Try `/health` and press Ctrl+C when finished. The helper will not overwrite a pre-existing local branch with the same name.

### Try authorization

Use `/health` as an allowlisted user in the configured test server; it should respond privately with the bot and storage status. Try again from a second test account that is not allowlisted; it should receive the generic private message `You are not authorized to use this bot here.` If you configured a test role instead, verify a member with that role is allowed and one without it is denied. Guild-scoped registration keeps the command out of other servers, and the runtime also rejects interactions whose guild ID differs from `DISCORD_DEV_GUILD_ID`.

To return to the main branch afterward:

```powershell
git switch main
git pull --ff-only
```

The PR's guild-scoped command registration updates commands in the configured test server immediately. It does not change commands in other servers. `.env` is ignored by Git and is preserved when switching commits.

### Try the storage migration and restart persistence

The storage foundation has no configuration-writing Discord command yet. You can exercise the same SQLite store with the local tryout command, using your test server ID and a harmless marker:

```sh
npm run storage:tryout -- write <test-server-id>
npm run storage:tryout -- verify <test-server-id>
```

The first command writes a marker and exits; the second opens the database in a new process and confirms the value survived. For Docker Compose, use the container lifecycle and persistence workflow below. The marker is stored under `storage_tryout_marker` for that test server. `/health` also reports the active SQLite schema version.

To return to the merged version afterward:

```sh
git switch main
git pull --ff-only
npm ci
npm run deploy:commands
npm run dev
```

### Try the Docker Compose service

Run these commands in PowerShell from the repository after `.env` is configured:

```powershell
docker compose up --build -d
docker compose logs --tail 20 bot
```

Run `/health` in the private test server and confirm the bot responds. Check that the image does not contain dotenv files, and write a harmless SQLite marker:

```powershell
docker compose run --rm --entrypoint sh bot -c 'test ! -e /app/.env && test ! -e /app/.env.example && echo "PASS: no dotenv files in the image"'
docker compose exec bot node dist/storage/tryout.js write 11111111111111111
```

Stop Compose and recreate the service without removing its named volume. Then verify the marker survived:

```powershell
docker compose stop bot
docker compose logs --tail 20 bot
docker compose down
docker compose up --build -d
docker compose exec bot node dist/storage/tryout.js verify 11111111111111111
```

The shutdown logs should include `process.shutdown` with `SIGTERM`. To verify the restart policy after a process failure, kill the container init process; the service should return to `Up` automatically:

```powershell
docker compose exec --user 0 bot sh -c "kill -KILL 1"
Start-Sleep -Seconds 5
docker compose ps
docker compose logs --tail 20 bot
```

The failure command intentionally stops the container once. Do not use `docker compose down --volumes` during this check; it deletes the persistent database.

## Automated pull request checks

Every pull request and push to `main` runs the same local checks with `npm run check`. The workflow uses the committed lockfile and Node.js version from `.nvmrc`; it has read-only repository access and no bot or AI secrets.

The workflow covers formatting, TypeScript type checking, compilation, Compose configuration, and production image building. It also checks that the image contains no dotenv files. Feature-specific automated tests will be added with the behavior they exercise. A pull request should state what can be tried, how to trigger it, the expected result, and any required setup or permissions.
