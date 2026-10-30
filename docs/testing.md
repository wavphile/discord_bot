# Trying the bot

Use a separate Discord application and a private test server for development. Keep the bot token in your local `.env` file; never add it to a pull request, issue, workflow, or chat. GitHub Actions checks the code without Discord credentials and does not deploy PR code to a live bot.

## One-time Discord setup

1. Create a development application in the [Discord Developer Portal](https://discord.com/developers/applications) and add its bot user.
2. Create a private test server that has no real members or production data.
3. In the portal's installation settings, enable **Guild Install** and use the `bot` and `applications.commands` scopes. Install the app only into the test server. The bot account must join the server; grant it **View Channel** only in the channels to inspect. `/health` does not need bot permissions, but `/server inspect` needs the bot to access the server configuration.
4. Copy the bot token and application ID. In Discord, enable Developer Mode, then copy the test server ID and your user ID. Copy role IDs too if you want to authorize a test role.
5. In the repository root, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env`) and fill in `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_DEV_GUILD_ID`.
6. Set `DISCORD_ALLOWED_USER_IDS` to your user ID and optionally `DISCORD_ALLOWED_ROLE_IDS` to comma-separated test role IDs. At least one allowlisted user or role is required for ordinary commands; an empty allowlist denies them. Keep the allowlist narrow and do not add `@everyone`.
7. Set `DISCORD_APPROVER_USER_IDS` and/or `DISCORD_APPROVER_ROLE_IDS` to a separate approver user or role list. Only these users or roles can review, approve, or reject plans; approvers can use those approval subcommands without being on the ordinary command allowlist. The requester cannot approve their own plan. Leave both values empty to disable plan decisions.

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

Keep the bot running, open the test server, and follow the pull request's **Try it** steps. Run `/health`; it should privately report that the bot is responding and SQLite schema v5 is ready. Run `/server inspect`; it should privately report a snapshot ID, capture time, role/category/channel/overwrite counts, and limited channel visibility. The command stores a configuration snapshot in SQLite. It does not change server settings and is not a complete server backup.

Run `/server inspect` a second time, then `/server diff`. The private comparison should show the two capture times and any differences in supported server settings, roles, returned channels, and channel permission overwrites. The comparison always warns that channel visibility is limited: a channel returned in only one snapshot may have been added or deleted, or may have become visible or inaccessible to the bot. Its presence alone does not establish which. Details for a channel that was unviewable in either snapshot are omitted. With fewer than two snapshots, `/server diff` asks you to capture another one.

As of October 30, 2026, the PR tryout registered the command and `/server inspect` captured a second snapshot, but a live `/server diff` response has not been confirmed. Run it manually after starting this PR or a version containing the change; the corresponding unit tests and GitHub Actions checks pass.

Run `/permissions explain` with a test member and a text or announcement channel. Its private response should show **View Channel**, **Send Messages**, and **Send Messages in Threads** separately, with the role and channel-overwrite rules behind each result. It is read-only. The command checks the selected member's current roles and channel overwrites; thread membership is outside this check. See [permission calculation details](permissions.md). If only the server owner account is available, the owner-bypass case can be tried; role and overwrite combinations remain covered by unit tests until another test member is available.

Press Ctrl+C to stop the local bot.

### Windows PowerShell helper

After `scripts/try-pr.ps1` is available in your checkout, run this from the repository:

```powershell
.\scripts\try-pr.ps1 -PullRequestNumber 6
```

If PowerShell blocks local scripts, run it in a one-off PowerShell process:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\try-pr.ps1 -PullRequestNumber 6
```

The helper requires a clean checkout, Node.js 24.15 or newer in the 24.x line, and at least one valid allowed test user or role ID in `.env`. It creates `.env` from the example and stops if you need to fill it in. It fetches the PR's current head into a local `try/pr-<number>` branch, installs locked dependencies, shows the application and test server IDs plus allowlist counts without displaying the token or IDs, and asks you to type `DEPLOY` before registering guild-scoped commands. It then starts the bot in the foreground. Try the commands listed in the PR's **Try it** section and press Ctrl+C when finished. The helper will not overwrite a pre-existing local branch with the same name.

### Try authorization

Use `/health` as an allowlisted user in the configured test server; it should respond privately with the bot and storage status. Try again from a second test account that is not allowlisted; it should receive the generic private message `You are not authorized to use this bot here.` If you configured a test role instead, verify a member with that role is allowed and one without it is denied. Guild-scoped registration keeps the command out of other servers, and the runtime also rejects interactions whose guild ID differs from `DISCORD_DEV_GUILD_ID`.

To return to the main branch afterward:

```powershell
git switch main
git pull --ff-only
```

The PR's guild-scoped command registration updates commands in the configured test server immediately. It does not change commands in other servers. `.env` is ignored by Git and is preserved when switching commits.

### Try safe change-plan previews

The `/plan` preview commands save an exact, short-lived preview in SQLite and reply privately. They read the selected channels' current values and do not modify Discord settings. Plans expire after 30 minutes. The preview displays a full plan UUID for the later approval workflow.

Try each command in the private test server:

```text
/plan topic channels:#bots value:"A temporary preview topic"
/plan slowmode channels:#bots seconds:5
/plan permission channels:#bots role:@TestRole permission:view_channel state:allow
```

Replace `#bots` with a comma-separated list of channel mentions or IDs. For the role example, choose an existing custom unmanaged role; `@everyone` and managed roles are rejected. Permission choices are `view_channel`, `send_messages`, and `read_message_history` on ordinary text channels, plus `view_channel`, `connect`, and `speak` on voice channels. Use `state:inherit` to preview clearing only the selected permission bit. Use `value:CLEAR` to preview removing a topic.

Each response should be ephemeral and identify every channel and role by name and ID, show the before/after values, state the expiry, and explicitly say no Discord changes were applied. A target already at the requested value is omitted from the plan and listed as a no-op; if all targets are no-ops, no plan is saved. The selected channel list is resolved once, capped at 25, and cannot expand after saving. Invalid, inaccessible, cross-server, or unsupported targets reject the whole request before a plan is stored.

### Request and review plan approval

The original requester can submit a current preview for approval. Only the separate approver allowlist can inspect its private details and approve or reject it:

```text
/plan submit plan_id:<full-plan-uuid>
/plan review plan_id:<full-plan-uuid>
/plan approve plan_id:<full-plan-uuid>
/plan reject plan_id:<full-plan-uuid>
```

Approval runs a fresh, read-only check of the requester's current authorization, the bot's channel permissions and role hierarchy, and every planned value. If any target cannot be read or written, or its current value differs from the preview, the whole plan becomes conflicted. The requester cannot approve their own plan. Approval records a decision but does not itself change Discord settings. A configured approver must separately start an execution job.

As of October 30, 2026, a second test account is unavailable. Unit and storage tests cover separate authorization, self-approval rejection, expiry, transitions, and conflicts. Live approval by another account remains pending.

### Run an approved plan as a durable job

Only a configured approver can start a job for a current approved plan:

```text
/plan apply plan_id:<full-plan-uuid>
/plan status job_id:<full-job-uuid>
/plan cancel job_id:<full-job-uuid>
```

The job and its ordered items are committed to SQLite before any Discord write. The bot processes one job at a time per server; other servers can progress independently. It rechecks the requester, bot permissions, channel/role target, and exact `before` value immediately before each item. The Discord.js REST layer handles Discord rate limits. Transient failures are retried at most three application attempts, and any returned `Retry-After` duration is respected. Each job status response lists the state and last error for every item.

Cancellation takes effect between items. An in-flight Discord request is allowed to finish; already-applied items remain visible as partial progress. If the process stops while an item is marked `applying`, startup reads the live setting before doing anything else: the saved `after` value is recorded as applied, the original `before` value is safe to retry within the remaining attempt limit, and any third value becomes a conflict. If Discord cannot be read, the job stays `reconciliation_required` and blocks later jobs for that server; restore access and restart the bot to retry reconciliation. This value-based recovery cannot distinguish an apply followed by an administrator reverting the value to the original state.

Live tests that write settings are pending. Use disposable test channels and an approver account separate from the requester. Do not try `/plan apply` in the private server until you are ready for the approved setting changes to be applied. The automated runner tests cover serialized jobs, bounded transient retries, partial failures, cancellation, and restart reconciliation; the 10-channel Discord exit-gate test remains unverified.

As of October 30, 2026, a live test-server smoke test passed for `/plan slowmode channels:#bots seconds:5`: the private preview resolved `#bots`, showed slowmode `0` before and `5` after, saved a preview expiring in 30 minutes, and confirmed no Discord changes were applied. Live smoke tests for `/plan topic` and `/plan permission` are still pending; their automated checks pass, but they should be tried in Discord before a later release that depends on them. The permission test requires a custom unmanaged role.

The permission preview preserves all existing overwrite bits while changing only the selected bit. The commands do not require permission to write to Discord because they perform no Discord writes. `npm test` covers selector parsing/resolution, visibility/type checks, no-op filtering, bit preservation, all-or-nothing planning, and private preview behavior.

### Try the storage migration and restart persistence

The bot now has a configuration-writing `/plan apply` command, guarded by the separate approver allowlist and exact-value preflight. For storage-only persistence checks, you can also use the local tryout command with your test server ID and a harmless marker:

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

The workflow covers formatting, TypeScript type checking, permission-calculation unit tests, compilation, Compose configuration, and production image building. It also checks that the image contains no dotenv files. A pull request should state what can be tried, how to trigger it, the expected result, and any required setup or permissions.
