# Trying the bot

Use a separate Discord application and a private test server for development. Keep the bot token in your local `.env` file; never add it to a pull request, issue, workflow, or chat. GitHub Actions checks the code without Discord credentials and does not deploy PR code to a live bot.

## One-time Discord setup

1. Create a development application in the [Discord Developer Portal](https://discord.com/developers/applications) and add its bot user.
2. Use the private development server `Keta’s Crackhouse`, which has no production data.
3. In the portal's installation settings, enable **Guild Install** and use the `bot` and `applications.commands` scopes. Install the app only into the test server. The bot account must join the server; grant it **View Channel** only in the channels to inspect. `/health` does not need bot permissions, but `/server inspect` needs the bot to access the server configuration.
4. Copy the bot token and application ID. In Discord, enable Developer Mode, then copy the test server ID and your user ID. Copy role IDs too if you want to authorize a test role.
5. In the repository root, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env`) and fill in `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_DEV_GUILD_ID`.
6. Set `DISCORD_ALLOWED_USER_IDS` to your user ID and optionally `DISCORD_ALLOWED_ROLE_IDS` to comma-separated test role IDs. At least one allowlisted user or role is required for ordinary commands; an empty allowlist denies them. Keep the allowlist narrow and do not add `@everyone`.
7. Set `DISCORD_APPROVER_USER_IDS` and/or `DISCORD_APPROVER_ROLE_IDS` to a separate approver user or role list. Only these users or roles can review, approve, or reject plans; approvers can use those approval subcommands without being on the ordinary command allowlist. The requester cannot approve their own plan. Leave both values empty to disable plan decisions.

Administrative interactions are accepted only in `DISCORD_DEV_GUILD_ID`. The bot checks the requester against the configured user and role IDs before dispatching any interaction. DMs and other servers are denied. Both privileged intents remain off by default. Only when a feature requires one, set its matching flag in `.env` and enable that intent under **Discord Developer Portal → your application → Bot → Privileged Gateway Intents**:

- `DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true` requests **Server Members Intent**.
- `DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true` requests **Message Content Intent**.

Restart the bot after changing either setting. `/health` reports which optional intents the local configuration requests. Discord describes [what each privileged intent provides](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents); enable only the capability a feature needs. If Discord rejects a requested intent at login, check the matching Developer Portal switch and access for the application. Features that need a disabled capability should explain the exact setting and portal switch, and must stop without trying the protected operation. Review permissions and data access for each new feature before trying it.

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

Keep the bot running, open the test server, and follow the pull request's **Try it** steps. Run `/health`; it should privately report that the bot is responding and SQLite schema v7 is ready. Run `/server inspect`; it should privately report a snapshot ID, capture time, role/category/channel/overwrite counts, and limited channel visibility. The command stores a configuration snapshot in SQLite. It does not change server settings and is not a complete server backup.

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

The helper requires a clean checkout, Node.js 24.15 or newer in the 24.x line, and at least one valid allowed test user or role ID in `.env`. It creates `.env` from the example and stops if you need to fill it in. It fetches the PR's current head into a local `try/pr-<number>` branch, installs locked dependencies, shows the application and test server IDs plus allowlist counts without displaying the token or IDs, and asks you to type `DEPLOY` before registering guild-scoped commands. It reads both privileged-intent flags from `.env`, defaults missing values to `false`, and shows their values before deployment. It sets and restores these process environment variables so inherited PowerShell values cannot change the tryout. It then starts the bot in the foreground. Try the commands listed in the PR's **Try it** section and press Ctrl+C when finished. The helper will not overwrite a pre-existing local branch with the same name.

### Try authorization

Use `/health` as an allowlisted user in the configured test server; it should respond privately with the bot, storage, and configured optional-intent status. By default, Server Members and Message Content should both be shown as disabled. Try again from a second test account that is not allowlisted; it should receive the generic private message `You are not authorized to use this bot here.` If you configured a test role instead, verify a member with that role is allowed and one without it is denied. Guild-scoped registration keeps the command out of other servers, and the runtime also rejects interactions whose guild ID differs from `DISCORD_DEV_GUILD_ID`.

### Privileged-intent capability check

As of October 30, 2026, unit tests verify that the bot requests only Guilds by default, opts into each privileged intent independently, and formats actionable messages for unavailable capabilities. The PR #38 tryout read both flags as false, registered five guild commands, and started the bot with SQLite schema v7. No `/health` interaction was submitted. The updated response and a connection with either privileged intent enabled have not been confirmed in Discord; enable an intent only when its dependent feature is being tested, and verify the matching Developer Portal switch first.

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

### Inspect audit history and prepare a reviewed reversal

Each saved plan has an audit history recording its reason, actor, approver, before/after values, and lifecycle outcomes. Provide a short operational reason when creating a topic, slowmode, or permission preview; approval, rejection, and cancellation also accept optional notes. Do not put tokens, passwords, or other secrets in reasons. Events are retained in the local SQLite database indefinitely; there is no automatic pruning. Append-only triggers prevent individual event edits or deletes, while deleting or replacing the database removes its audit history. Include the database in protected backups and handle it as operational data.

The original requester or a configured approver can inspect the plan privately:

```text
/plan audit plan_id:<full-plan-uuid>
/plan audit plan_id:<full-plan-uuid> before_event_id:<event-uuid-from-the-previous-page>
```

The first command returns the newest 50 events. If older events exist, the private response includes the `before_event_id` value for the next page.

After an execution job has finished, the original requester or a configured approver can prepare an inverse for the items that successfully applied:

```text
/plan reverse job_id:<full-job-uuid> reason:<why-the-change-is-being-reversed>
```

The command reads Discord again and creates no plan if any applied target is missing, unreadable, or no longer equals the value recorded by the job. A successful response is a new ordinary preview with its own plan ID. Submit it for independent approval using `/plan submit`; a configured approver must review and approve it, then separately run `/plan apply` if the proposed restoration is still wanted. Reversals are supported for the existing topic, slowmode, and selected role-overwrite plan items. No reversal command itself changes Discord settings.

Automated tests cover append-only audit persistence, audit metadata, exact reversal scope, and stale-value rejection. Live audit viewing can be checked against a plan created by `/plan slowmode`; the original preview-only smoke test did not exercise this new command. Live approval, application, and reversal remain pending because the test server does not currently have an available separate approver account. The M2 exit gate of applying a change across 10 disposable channels and verifying partial failure/restart behavior also remains pending.

The schema v6 migration seeds a clearly marked historical baseline from existing plans, approval metadata, jobs, and item state. Databases upgraded from schema v5 did not previously retain the full event timeline, so imported entries summarize only the state still available and do not reconstruct missing decisions, retries, or intermediate outcomes.

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

### Ask a configuration question

Ask about a text or announcement channel that you can currently view, or select one member without a channel:

```text
/server inspect
/ask question:"Why can this member view this channel?" channel:#bots member:@TestMember
/ask question:"What roles and permissions does this member have?" member:@TestMember
```

The command is allowlisted, guild-only, and replies ephemerally. A channel question requires the requester to have current View Channel access and uses only that selected channel's snapshot data plus the selected member's current role membership; unrelated channel settings and other members' overwrites are omitted. Snapshots older than 24 hours, missing snapshots, missing channel data, or role definitions absent from the snapshot require a new `/server inspect`. The response includes the snapshot ID and capture time, member-role read time, a limited-visibility notice, and a deterministic permission calculation.

A member-only question uses a fresh read of that same-server member's current roles, role permissions, join date when available, and timeout state, with an observation timestamp. It does not need a saved channel snapshot or enable a privileged Gateway intent. Message activity remains unavailable in this path; use the separately configured, explicit message-retrieval flow below. The model has no tools and cannot make server changes. Mock output is explicitly labeled as a test response.

### Opt in to bounded message retrieval

Message retrieval is off by default. In a private test server, a member with **Manage Server** can allow a text or announcement channel and set the request bounds. The optional Message Content Intent must be enabled both in `.env` and in the Developer Portal; the bot never enables it automatically. Restart the bot after changing the intent. Try a small bound with the local mock provider:

```text
/messages status
/messages config enable channel:#bots
/messages config limits max_age_days:1 max_messages:10
/messages config provider provider:mock
/ask question:"What topic came up recently?" channel:#bots include_messages:true
/messages config disable channel:#bots
```

The `/ask` requester and bot must both currently have **View Channel** and **Read Message History** in the selected channel. In a private thread, each must also either be a current thread member or have **Manage Threads**; when membership lookup is needed, Server Members Intent must be enabled too. If membership cannot be checked, the request stops. To allow a thread, first allow its parent text channel with `/messages config enable`. The command fetches only the configured maximum number of messages within the configured 1–7 day lookback, skips bot-authored messages, and replies privately with retrieval bounds and timestamps. A no-text or out-of-window result makes no provider request. The setting is rechecked immediately before history is fetched.

Message text is untrusted evidence. It cannot override the provider instructions or authorize tools, and the model has no tools. Retrieved messages, prompts, and answers are not stored in SQLite; the lookback is a per-request eligibility limit, not persistent retention or a purge schedule. With `provider:mock`, no hosted API call is made and the response is labeled as test output. The `openai` and `anthropic` options are available only when their respective keys are configured locally; selecting one sends the bounded message text and question to that provider for token counting and generation. Review [provider data handling](ai-providers.md) and any required server notice before enabling a hosted provider.

As of October 30, 2026, 141 automated tests cover configuration defaults and permissions, channel and message bounds, private-thread membership, current requester and bot history access, opt-in rechecks, prompt-injection framing, provider availability, and storage boundaries. PR #42's startup tryout fetched the PR branch, installed the locked dependencies, registered six guild commands, and started the bot with SQLite schema v7 and both privileged-intent flags false; the bot logged `discord.ready`. No slash command was submitted and no message content was retrieved. Live `/health`, message retrieval, and a real hosted-provider response remain unverified in Discord. Use the private test server and only a fresh, specifically confirmed Discord interaction for those checks.

The default `AI_PROVIDER=mock` produces deterministic local output and makes no network request. To receive a model answer, set `AI_PROVIDER=openai` with `OPENAI_API_KEY`, or `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, in the ignored `.env`; provider base URLs and model settings are documented in [AI provider configuration](ai-providers.md). Keep keys out of Git, logs, Discord, and Codex. See [provider data handling](ai-providers.md) before sending server configuration to a hosted service.

### Summarize bounded channel messages

After a server administrator enables message retrieval, allows the source channel, and selects an available provider, run `/summarize channel:#bots`. The bot checks current requester and bot access to the channel and message history, including current private-thread membership when applicable. It fetches only the configured message count and lookback, skips bot-authored messages, and replies ephemerally with a concise summary, validated links to supporting messages, retrieval timestamps, and the configured bounds. The provider's source IDs must match messages fetched for this request; the command rechecks access and settings after generation before returning the result. `AI_PROVIDER=mock` returns a clearly labeled nonfactual test summary with sample text and source links. No message content, summary, or prompt is persisted.

As of October 30, 2026, 157 automated tests pass, covering valid and fabricated citations, untrusted message text, private-thread membership, channel allowlists, requester and bot history permissions, permissions revoked during generation, intent availability, mock output, and response limits. PR #44 passed type checking, production build, changed-file formatting, GitHub Actions, and the startup tryout. The tryout registered seven guild commands, started with SQLite schema v7 and both privileged-intent flags disabled, and logged `discord.ready`; the process was stopped cleanly. Live `/summarize` and hosted-provider output remain unverified. During the Discord smoke check, `/server inspect` and `/ask question:"What is the saved topic and slowmode for this channel?" channel:#bots` both timed out with “The application did not respond.” Retry after investigating the running bot process. No message-history response was returned and no server settings were changed.

`AI_REQUEST_TIMEOUT_MS` bounds each provider request. `AI_MAX_INPUT_TOKENS` caps input after the provider's input-token count endpoint checks the same developer/user messages; `AI_MAX_OUTPUT_TOKENS` bounds generated tokens. The bot reserves the maximum input plus output budget for the request, then records actual input and output usage after a complete response. Reservations prevent concurrent requests from exceeding `AI_DAILY_TOKEN_BUDGET_PER_GUILD`; the daily bucket resets at 00:00 UTC for each guild. Timeouts, interrupted requests, invalid responses, and unexpected provider failures keep reservations until the lease expires because generation may have been charged; known configuration, rejected-request, and rate-limit errors release them. Daily aggregate usage is pruned after 90 days on a subsequent reservation. The ledger stores only guild/day token totals and temporary reservation metadata, never prompts or generated text.

When the OpenAI adapter is selected, developer instructions and user input are sent to the configured endpoint for token counting and generation. Generation requests use the Responses API with `store: false`; this is not a zero-retention guarantee for all provider data. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and your organization's requirements before enabling a feature that sends server configuration. See [OpenAI text generation](https://developers.openai.com/api/docs/guides/text) and [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting) for the endpoints used by the adapter.

When the Anthropic adapter is selected, the exact system instructions and user input go to `/v1/messages/count_tokens` and `/v1/messages`. Generation is limited to text and does not enable tools. Anthropic documents default commercial API retention and training controls in its [data retention terms](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) and [model-training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training); review those terms and applicable account settings before sending server data. A live Anthropic call still needs to be tested with an authorized local key.

As of October 30, 2026, M3-17 automated validation passed: 86 tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR tryout. The tryout registered five guild commands and started the bot with SQLite schema v7. The live Discord `/ask` smoke test in `#bots` remains pending. Run `/server inspect`, then `/ask question:"What is the saved topic and slowmode for this channel?" channel:#bots`; with `AI_PROVIDER=mock`, expect a private, clearly labeled test response with snapshot provenance and no hosted API call. Also try a member-specific permission question with an appropriate test member. The M3-17 code is merged, but these interactive behaviors and a real OpenAI response have not been verified in Discord.

M4-21 adds the member-only question path. Unit tests verify same-server roles and permissions, dated membership evidence, activity refusal before provider calls, and cross-server rejection. The live member-profile and channel-specific `/ask` responses remain unverified in Discord; no activity data should be expected until a later message-retrieval feature has an approved scope and a dated source.

As of October 30, 2026, the M4-21 automated suite passes with 121 tests, type checking, production build, and changed-file formatting. The PR tryout fetched PR #40, registered five guild commands, and started the bot with SQLite schema v7 and both privileged-intent flags disabled. The bot appeared online in the test server. The authorized `/server inspect` and channel-specific `/ask question:"What is the saved topic and slowmode for this channel?" channel:#bots` commands were not submitted: the Discord UI automation could not reliably focus the `#bots` composer, which showed an oversized unsent draft. No Discord interaction or server change was made. Live server inspection, channel and member-only answers, and activity refusal therefore remain unverified. With `AI_PROVIDER=mock`, any live `/ask` response is labeled test output and is not factual model content; continue with the PR's **Try it** steps when the composer is usable.

### Turn a configuration suggestion into a plan

With a provider that returns structured proposals, use `/plan suggest` and explicitly select the channels the proposal may target:

```text
/plan suggest request:"Set a five second slowmode for bot testing." channels:#bots reason:"Limit rapid test messages"
/plan suggest request:"Prevent Helpers from sending messages here." channels:#bots role:@Helpers reason:"Keep the channel read-only"
```

The requester must currently be able to view every selected channel. The bot fetches those channels and the optional custom role from the current server, supplies only their selected configuration facts, and resolves model-returned target indexes back to those fetched objects. The provider cannot choose arbitrary channel or role IDs. Suggestions are limited to existing topic, slowmode, and selected role-permission changes; invalid JSON, extra fields, unsupported actions, duplicate settings, stale target state, or unsupported channel/role combinations create no plan. The bot fetches current values again after generation and declines to save if they changed while the provider was working.

A valid response creates only the usual private plan preview. This command never submits, approves, or applies it. To proceed, the requester uses `/plan submit`; a different configured approver reviews and approves it; an approver explicitly starts `/plan apply`. The original natural-language request and model response are not saved by the bot. An optional `reason` is saved in the plan audit history; do not put secrets there. A configured hosted provider receives the bounded request and selected channel facts, so review [AI provider data handling](ai-providers.md) first. `AI_PROVIDER=mock` returns sample prose rather than the required structured proposal; the command fails closed and saves no plan.

Live Discord `/plan suggest` and hosted-provider generation have not been exercised. The local mock-only test configuration can verify that unsupported output creates no plan, but cannot validate a useful AI proposal. Keep this as a release follow-up until a separately confirmed `#bots` interaction and a configured-provider test are available.

### AI boundary adversarial checks

The automated suite exercises injected instructions in questions and saved channel topics, and checks that generated `@everyone` text is escaped with mentions disabled. Structured plan suggestions reject fabricated channel-ID fields, unsupported output properties, foreign channel/role references, invalid indexes, and invalid setting values before plan persistence. Both AI commands deny channel access before provider calls; `/ask` also rejects channels and members from another server. Tests verify the ten-channel and token-count limits stop generation, while safe provider errors do not include provider response bodies in Discord replies or warning logs. As of October 30, 2026, all 105 automated tests, type checking, production build, changed-file formatting checks, and GitHub Actions pass. The final PR tryout registered five guild commands and started the bot with SQLite schema v7. No Discord slash command was submitted, and these checks use fake providers rather than a real OpenAI request.

### Retained message storage and purge

Persistence is separate from `/messages config enable`: retrieval alone never saves message text. A server administrator must explicitly opt each text or announcement channel into storage and choose its 1–7 day retention period. The bot needs **Manage Server**, current **View Channel** and **Read Message History** access, and the Message Content Intent enabled both in `.env` and in the Discord Developer Portal. When Message Content is requested, the bot also requests the non-privileged Guild Messages intent for message lifecycle events.

Use only a private test channel with test content:

```text
/messages status
/messages config storage-enable channel:#bots retention_days:1
```

Only new, human-authored messages received after the opt-in are retained; there is no history backfill. Threads inherit their opted-in text/announcement parent. DMs, bot and webhook messages, slash-command prompts, provider replies, and summaries are excluded. Edits replace retained text but keep the original expiry deadline. Each channel has its own retention period; shortening it takes effect in the next expiry sweep, while increasing it applies only to messages captured afterward. The command also runs a sweep after changing settings. Expired rows are purged at startup and hourly. Single/bulk message deletion, channel/thread deletion or access revocation, and guild removal clear their corresponding rows where Discord sends the event.

```text
/messages config storage-disable channel:#bots
/messages purge channel:#bots confirm:true
/messages purge confirm:true
```

`storage-disable` immediately deletes retained rows for that channel and its threads; omitting the channel disables storage for the full server and deletes all of its rows. `/messages purge` requires `confirm:true`, Manage Server, and a private confirmation result that reports counts only. Repeating a purge is safe and returns zero after the rows are gone. The content is stored in the local SQLite database as plain text until deletion or expiry; protect the database and its backups accordingly. Retained content is not currently read by `/ask` or `/summarize` and is not submitted to an AI provider by this milestone.

The automated suite exercises the schema migration, disabled-by-default state, allowlist and intent gates, edits, deletion events, expiry after downtime, shorter retention, guild-scoped purge, and log redaction. On October 30, 2026, all 171 automated tests, type checking, production build, changed-file formatting, `git diff --check`, and GitHub Actions passed. The PR #46 tryout fetched the current head, installed locked dependencies, registered all seven guild commands, started with SQLite schema v8, logged `discord.ready`, and stopped cleanly. In Keta’s Crackhouse `#bots`, `/server inspect` returned a configuration snapshot (11 roles, 3 categories, 16 channels, and 53 permission overwrites; 15 returned channels were not viewable by the bot). The approved `/ask` smoke test returned a private message explicitly labelled as mock-provider output and stated that no hosted provider was contacted. Neither command changes server settings. The live retention opt-in, message event reconciliation, and purge were not exercised: use a disposable channel and non-sensitive test text for those checks because opted-in content is stored as plain text in local SQLite until deletion or expiry. Disabling the Message Content Intent stops new captures; the bot continues scheduled expiry while that capability is unavailable. Re-enable the intent only when needed, and review the channel allowlist with `/messages status`.

### M5-29 second AI provider

The Anthropic adapter uses the same `AiProvider` contract as the mock and OpenAI adapters. Automated tests verify that token counting and generation send the same system/user content, aggregate Anthropic input/output usage, reject incomplete or malformed responses, map provider errors without exposing response bodies, and keep the provider unavailable when its API key is absent. Fake-provider command tests exercise both bounded summaries and structured plan previews through the Anthropic contract. The provider choice is included in deployed `/messages config provider` options only when `ANTHROPIC_API_KEY` is configured. No live Anthropic request or hosted `/ask`, `/summarize`, or `/plan suggest` result is produced by the isolated test suite; follow [AI provider configuration](ai-providers.md) and review its data-handling notes before configuring a key.

On October 30, 2026, all 196 automated test cases passed, along with type checking, the production build, and changed-file formatting. The restricted local test runner could not spawn its worker (`spawn EPERM`), so the compiled test files were run sequentially; GitHub Actions will run the normal test command.

### Read-only feature module example

`/server-info` is the M5-28 example module. In Keta’s Crackhouse, it should privately show the current server name, creation time, and ID; it makes no additional API request and changes no state. To try it, check out the PR, run `scripts/try-pr.ps1 -PullRequestNumber <PR-number>`, and use `/server-info` in `#bots` while the bot is running. The startup tryout can verify deployment registration and `discord.ready`; a live `/server-info` reply still needs to be tested in Discord if it is not exercised during the PR cycle. See [the module guide](modules.md) for the module contract and safety boundaries.
