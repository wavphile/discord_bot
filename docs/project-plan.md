# Discord administration and AI assistant — implementation plan

Prepared: 29 October 2026

## 1. Goal and working assumptions

Build a self-hosted Discord bot that inspects server configuration, explains permissions, safely applies batch changes, and answers questions using configurable AI providers. The same release must run on a rented Linux VM and a Raspberry Pi using 64-bit Linux.

Initial target: a small number of servers, one running bot instance, Discord slash commands as the interface, and hosted AI inference. Configuration analysis comes before message analysis. No dashboard, autonomous moderation, model training, or cross-server bulk rollout in the MVP.

GitHub account verified through the connected GitHub plugin: **wavphile**. Repository: [`wavphile/discord_bot`](https://github.com/wavphile/discord_bot), already created and public; this plan is its first tracked file. Keep credentials and operational data out of Git; decide whether to retain public visibility and record the license before accepting external contributions.

## 2. Technical decisions

| Concern | Initial decision |
| --- | --- |
| Language | TypeScript with strict checking |
| Runtime | A supported Node.js LTS release, pinned at implementation start |
| Discord | discord.js, version pinned through the lockfile |
| Persistence | SQLite, versioned migrations, single writer |
| Deployment | Docker Compose; Linux amd64 and arm64 images |
| AI | Provider interface; implement one hosted provider first, then a second adapter |
| Commands | Slash commands, private responses, buttons for review and approval |
| Background work | Durable jobs in SQLite; one executor initially |
| Testing | Unit tests for permission and planning logic; integration checks in a dedicated Discord test server |

Keep Discord transport, domain logic, AI integration, and storage separate. Feature modules register commands, required permissions, input schemas, planners, and executors. Modules live in the repository; arbitrary third-party code loading is outside initial scope.

Suggested layout:

```text
src/
  discord/           # Commands, interactions, response formatting
  core/              # Authorization, permissions, plans, jobs
  features/          # Inspection, batch editing, AI questions
  ai/                # Provider interface, adapters, context selection
  storage/           # Queries and migrations
  config/            # Validated environment and server configuration
tests/
docs/                # Architecture, operations, module guide
.github/             # Workflows, issue forms, PR template, ownership
Dockerfile
compose.yaml
.env.example
```

## 3. GitHub workflow and versioning

1. Use the existing `wavphile/discord_bot` repository. Add this plan as `docs/project-plan.md` in the initial commit, then initialize README, `.gitignore`, `.env.example`, and contribution documentation in focused follow-up commits.
2. Use `main` as the releasable branch. Create short-lived branches such as `feat/12-config-snapshots`, `fix/34-permission-check`, and `docs/56-pi-setup` from main.
3. Create GitHub milestones matching the releases below. Create one issue per backlog row, with its acceptance criteria copied into the issue body. GitHub assigns actual issue numbers; the IDs below are planning references.
4. Use labels: `feature`, `bug`, `docs`, `security`, `infra`, `blocked`, `priority:high`, `priority:normal`, and component labels such as `area:ai` and `area:batch`.
5. Track work in a GitHub Project with Backlog, Ready, In progress, In review, and Done. If Projects is unavailable, use milestones and issues with the same status labels.
6. Open a draft PR early. Link its issue with `Closes #<number>`. Describe the resulting behavior, validation, migration implications, and any recovery limitations.
7. Require formatting, type checking, tests, and build checks before merging. Protect main against force pushes and deletion. Require a reviewer when another collaborator is available; retain PRs and checks for solo work. Confirm ruleset support for the chosen repository visibility and GitHub plan during setup.
8. Squash merge completed PRs and delete their branches. Keep each PR focused on one issue or a tightly related group.
9. Tag releases using SemVer: `v0.1.0`, `v0.2.0`, etc. Document configuration and database changes in release notes. Treat version 0.x interfaces as evolving but document breaking changes explicitly.
10. Publish container images to GitHub Container Registry on release tags. Include both architectures, a version tag, commit SHA, and image digest. Production deployment uses a specific digest or release version.

GitHub Actions should use minimal token permissions, protected secrets, and pinned action revisions. Pull requests run validation without production credentials. Publishing is a separate release workflow. Enable dependency update PRs and available secret/dependency scanning. Never commit Discord tokens, AI keys, real message exports, databases, or `.env` files.

## 4. Step-by-step implementation backlog

Work in dependency order. Each numbered item is suitable for a GitHub issue and usually one PR.

### Milestone M0 — foundation (`v0.1.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 01 | Initialize repository and collaboration files | README, contribution guide, issue forms, PR template, milestone list, ownership, license decision recorded |
| 02 | Scaffold the TypeScript application | Reproducible install; validated configuration; formatting, type checking, tests, and build pass in Actions |
| 03 | Create Discord application and test server | Bot joins the test server; `/health` returns privately; required permissions and intent setup are documented |
| 04 | Add storage, migrations, and logging | Fresh database initializes; restart preserves server configuration; logs redact credentials and message bodies |
| 05 | Add authorization foundation | Guild-only administrative commands; explicit allowed roles/users; requester checks on every interaction; cross-server access denied |
| 06 | Package the service | Compose starts the bot, persists data, handles shutdown, and restarts after failure; no token stored in image |

Exit gate: clean checkout can be configured and run using the README; CI passes; test bot responds after restart.

### Milestone M1 — inspection and explanations (`v0.2.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 07 | [Define supported settings matrix](supported-settings.md) | Every field has API source, read/write support, required permissions, feature restrictions, and reversal support |
| 08 | [x] Implement configuration snapshots | `/server inspect` reads supported guild fields, roles, categories, channels, and overrides; snapshot has timestamp and schema version |
| 09 | [x] [Implement permission calculations](https://github.com/wavphile/discord_bot/issues/15) | `/permissions explain` shows why a member can view/send in a channel, including owner/admin cases, role aggregation, overwrites, and implicit restrictions |
| 10 | [x] [Add snapshot comparison](https://github.com/wavphile/discord_bot/issues/17) | `/server diff` identifies additions, removals, and changed supported fields between snapshots; inaccessible data is clearly marked |

M1-08 server acceptance passed on October 30, 2026: `/server inspect` returned a private summary and limited-visibility notice in `#bots`, and the SQLite database retained the captured snapshot after the command completed.

M1-09 acceptance passed on October 30, 2026: nine permission-calculation unit tests passed, and the `/permissions explain` command ran through `scripts/try-pr.ps1 -PullRequestNumber 16` in `#bots`. The server-owner case reported `View Channel`, `Send Messages`, and `Send Messages in Threads` as allowed, with the owner-bypass explanation; its results matched discord.js. Testing required a member-specific `View Channel` allow for the bot in `#bots` only.

M1-09 remaining Discord-side check: the non-owner role and overwrite comparison could not be run because a second test account is unavailable. Unit tests cover the owner, Administrator, role aggregation, overwrite precedence, and implicit restriction cases. Re-run the client comparison when another test account is available.

M1-10 implementation passed on October 30, 2026: 11 new snapshot-diff and storage tests passed; type checking, build, changed-file formatting, and the GitHub Actions `Validate` workflow passed. `scripts/try-pr.ps1 -PullRequestNumber 18` registered the development commands, and `/server inspect` captured another snapshot in `#bots`. The live `/server diff` response remains pending; follow the steps and status note in [testing.md](testing.md).

M1 exit gate: M1-09's owner case and unit checks passed. The representative non-owner role and overwrite comparison remains pending, as does the live `/server diff` response check. The remaining M1/M2 work can proceed while those checks are unavailable.

### Milestone M2 — reliable batch administration (`v0.3.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 11 | [x] [Build structured change plans](https://github.com/wavphile/discord_bot/issues/19) | Plans store server, requester, exact targets, old/new values, snapshot reference, expiry, and status; preview makes no edits |
| 12 | [x] [Implement first batch operations](https://github.com/wavphile/discord_bot/issues/21) | Support text-channel slow mode, channel topics, and selected role/channel permissions; selectors resolve to a fixed visible target list |
| 13 | [x] [Add approval and conflict checks](https://github.com/wavphile/discord_bot/issues/23) | Only authorized approvers can apply; recheck requester, bot capability, and current values immediately before each operation; changed targets conflict rather than being overwritten |
| 14 | [x] [Implement durable job execution](https://github.com/wavphile/discord_bot/issues/25) | Per-server serialization, rate-limit handling, bounded retries, cancellation between items, and per-item results; restart reconciles ambiguous operations before retry |
| 15 | [x] [Add recovery and audit records](https://github.com/wavphile/discord_bot/issues/27) | Record actor, approver, reason, plan and job IDs, before/after values, and outcome; supported reversal creates a new reviewed plan and detects subsequent edits |

Exit gate: preview and apply changes across at least 10 test channels; simulate an API failure and process restart; verify no duplicate or silently overwritten changes. Discord operations are not atomic, and the result must show partial completion explicitly.

M2-11 implementation passed on October 30, 2026: schema v3 stores bounded, ordered change plans atomically; validates text/voice overwrite targets and selected permission-bit changes; scopes optional snapshots to the same server; and returns expired pending plans as expired without writing during preview. The 28-test suite, type check, build, and changed-file formatting checks passed. The PR tryout confirmed `/health` reports schema v3 in `#bots`. The interactive plan-preview workflow was delivered in M2-12.

M2-12 Discord smoke test passed on October 30, 2026: `/plan slowmode` created a private `#bots` preview with current value 0, proposed value 5, a 30-minute expiry, and an explicit no-settings-changed notice. The result is recorded in [testing.md](testing.md). Live `/plan topic` and `/plan permission` checks remain pending.

M2-13/14 implementation passed on October 30, 2026: schema v5 persists approved execution jobs and ordered item state; apply rechecks the requester, bot permissions, target, and exact before-value before every write. Per-server work is serialized, transient failures have at most three write attempts and respect returned retry-after values, cancellation stops between items, and item outcomes are stored and shown privately. On restart, an interrupted item is reconciled against the before/after/current value before any retry. The 60-test suite covers persistence, serialization, bounded retries, partial failures, cancellation, and restart recovery; typecheck, build, formatting, CI, and the PR tryout health check passed. As recorded in [testing.md](testing.md), live `/plan apply` changes, second-account approval, and the 10-channel Discord exit-gate scenario remain unverified.

M2-15 implementation adds schema v6 with a transactional, append-only audit log for previews, decisions, job and item lifecycle, before/after values, actors, approvers, and reasons. The migration imports available v5 plan/job state as a marked historical baseline; the full event sequence did not exist in those databases. Audit records remain in SQLite indefinitely and are not automatically pruned. `/plan audit` privately shows a plan's history, with a cursor for older pages. `/plan reverse` creates an ordinary new plan only for successfully applied job items whose current Discord values still match the recorded applied values; the reversal must be submitted and independently approved like any other change. Automated suite results and remaining live-test gaps are recorded in [testing.md](testing.md). Live approval, application, and reversal remain pending until the test server has a separate approver and disposable changes can be applied safely.

### Milestone M3 — AI configuration assistant (`v0.4.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 16 | [x] [Implement provider interface](https://github.com/wavphile/discord_bot/issues/29) | Configurable endpoint, model, timeout, token budget, and per-server usage limits; one hosted provider works; mocked provider supports tests |
| 17 | [x] [Answer configuration questions](https://github.com/wavphile/discord_bot/issues/31) | `/ask` retrieves relevant authorized configuration and returns evidence with snapshot time; missing or stale data is disclosed |
| 18 | [x] [Convert AI suggestions into plans](https://github.com/wavphile/discord_bot/issues/33) | Model output is schema validated, targets are resolved by application code, and all writes use M2 approval/execution; unsupported actions are rejected |
| 19 | [x] [Harden AI boundaries](https://github.com/wavphile/discord_bot/issues/35) | Test injected instructions, fabricated IDs, cross-server requests, excessive context, provider failure, and unauthorized settings access |

Exit gate: answer “Why can member X see channel Y?” with verifiable evidence; propose a batch change; apply only after explicit approval. Ordinary questions never modify the server.

M3-16 adds a provider-neutral interface, deterministic mock, OpenAI Responses adapter, validated provider and quota settings, schema v7 daily usage accounting, and a per-server generation boundary that reserves budget and records actual usage without persisting prompts or responses. The default remains the mock. No Discord AI command is included yet; live OpenAI calls and provider-account data controls remain to be verified before a later command sends server data. See [AI provider configuration](ai-providers.md) and [testing.md](testing.md).

M3-16 validation passed on October 30, 2026: all 78 tests, type checking, production build, and GitHub Actions passed. The PR tryout registered the existing four guild commands and started the bot with SQLite schema v7. No AI command exists in this scope, so the OpenAI API was not called; live provider behavior and the account's data-control settings remain to be tested before a later feature sends server data.

M3-17 implementation passed on October 30, 2026: the 86-test suite, type checking, production build, changed-file formatting, GitHub Actions, and the PR tryout all passed. The tryout started the bot with schema v7 and registered five guild commands. The `/ask` live Discord smoke test was not run; it remains outstanding until a separately confirmed test can run in `#bots`. The default mock provider makes no hosted API call. See [testing.md](testing.md).

M3-18 implementation passed on October 30, 2026: all 96 tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR tryout passed. The tryout registered five guild commands, started with schema v7, and shut down cleanly. A useful `/plan suggest` interaction and hosted-provider output remain unverified; the configured mock returns prose and the command fails closed without saving a plan. See [testing.md](testing.md) for the test workflow and follow-up.

M3-19 automated hardening passed on October 30, 2026: all 105 tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR tryout passed. The tryout registered five guild commands and started the bot with schema v7. The adversarial tests cover injected user/server text, generated mention handling, fabricated target fields, cross-server channels/members/roles, selected-channel authorization, bounded requests/context, and provider failures without response-body disclosure. Live OpenAI and Discord slash-command behavior remain unverified under the mock-only test configuration; see [testing.md](testing.md).

### Milestone M4 — bounded message and member analysis (`v0.5.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 20 | [x] [Add privileged-intent capability checks](https://github.com/wavphile/discord_bot/issues/37) | Setup describes required intents; unavailable member/message capabilities return an actionable explanation |
| 21 | [x] [Add bounded member questions](https://github.com/wavphile/discord_bot/issues/39) | Explain roles and permissions for authorized targets; limit activity claims to observed, dated data; enforce server boundaries |
| 22 | [x] [Add opt-in message retrieval](https://github.com/wavphile/discord_bot/issues/41) | Admin config selects permitted channels, 1–7 day lookback, 1–50 message limit, and local provider; each query is explicit and checks current requester/bot channel and history access plus private-thread membership; raw message text is never persisted (durable retention and purge are M4-24) |
| 23 | [x] [Add source-linked summaries](https://github.com/wavphile/discord_bot/issues/43) | Summaries include message links and retrieval bounds; private responses do not reveal inaccessible content; source text cannot authorize tools |
| 24 | [x] [Add deletion and retention controls](https://github.com/wavphile/discord_bot/issues/45) | Raw-message persistence is off by default; configured retention runs automatically; purge handles stored content and derived indexes; deletion/edit events are reconciled where supported |

Exit gate: member without access to a restricted channel cannot obtain its content through answers, citations, cached context, or summaries. Document how external providers process submitted data before enabling this feature.

M4-20 adds strict opt-in flags for Server Members and Message Content intents, leaves both off by default, reports configured intent requests in `/health`, and provides actionable capability explanations for later member/message features. Disallowed-intent login failures receive a fixed Developer Portal hint without logging error text or credentials. Validation passed with 112 tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR #38 tryout. The tryout registered five guild commands and started the bot with schema v7 and both privileged intents disabled. The live `/health` output and enabling a privileged intent in the test application's Developer Portal remain unverified; see [testing.md](testing.md).

M4-21 extends `/ask` to accept a same-server member without a channel snapshot, supplying current roles, role permissions, join date when available, timeout state, and observation time. Channel-specific questions retain current requester access checks and snapshot bounds. Message/history questions in this path are declined before provider calls; member evidence is not persisted and is bounded to 32,000 characters. The 121-test suite, type checking, production build, changed-file formatting, GitHub Actions, and PR #40 startup tryout passed; the tryout registered five guild commands and started with SQLite schema v7 and both privileged intents disabled. A live `/server inspect` and channel `/ask` could not be submitted because the Discord `#bots` composer remained in an oversized-draft state. No Discord interaction or server change was made, so the live server snapshot, channel and member-only answers, and activity refusal still need testing; see [testing.md](testing.md).

M4-22 adds server-admin opt-in for bounded, on-demand message evidence through `/messages` and `/ask include_messages:true`. Retrieval is disabled by default, limited to an allowlist and 1–7 day / 1–50 message bounds, checks current requester and bot history permissions and private-thread membership, and stores no message text, prompts, or answers. Automated tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR #42 startup tryout passed; the tryout registered six guild commands and started with SQLite schema v7 while both privileged intents were disabled. Live `/health`, message retrieval, and hosted-provider behavior remain unverified in Discord; no messages were retrieved. Durable retention, deletion/edit reconciliation, and purge remain in M4-24. See [testing.md](testing.md).

M4-23 adds `/summarize` for the same bounded, admin-allowed message evidence. Summaries are ephemeral, link only to validated same-channel message IDs from the current request, recheck access and settings after generation, and persist no message text, prompts, summaries, or source lists. All 157 automated tests, type checking, production build, changed-file formatting, GitHub Actions, and the PR #44 tryout passed. The tryout registered seven guild commands, started with SQLite schema v7 and both privileged intents disabled, and logged `discord.ready`; the process was stopped cleanly. Live `/summarize` and hosted-provider output remain unverified. The confirmed `/server inspect` and channel `/ask` smoke checks both timed out with “The application did not respond”; no message-history response was returned and no server settings were changed. See [testing.md](testing.md).

M4-24 adds opt-in SQLite retention through separate `/messages config storage-enable` and `storage-disable` controls, a private confirmed `/messages purge`, schema v8, startup and hourly expiry sweeps, and message create/edit/delete/bulk-delete/channel/thread/guild reconciliation. Stored message content is never sent to an AI provider by this milestone. Automated tests cover retention defaults, intent/access/allowlist gates, original-timestamp expiry, shorter retention, downtime cleanup, scoped purge and deletion events, and log redaction. The test-server tryout still needs to confirm command registration/startup; live retention event reconciliation remains a documented follow-up because it requires opting a test channel into persistent message storage. See [testing.md](testing.md).

### Milestone M5 — deployment and release hardening (`v1.0.0`)

| ID | Task | Acceptance criteria |
| --- | --- | --- |
| 25 | Verify amd64 and arm64 deployments | Same release runs on a Linux VM and an actual 64-bit Raspberry Pi; record model, RAM, server size, and measured resource usage |
| 26 | Implement operational recovery | Health checks, graceful stop, database-safe backup, restore rehearsal, disk-space handling, and token rotation guide |
| 27 | Verify upgrade and downgrade procedure | Test migration from previous release; document that older images may require restoring a matching database backup |
| 28 | Document feature extension | Add an example read-only feature using the module interface; module author does not modify executor or provider internals |
| 29 | Validate second AI provider | Same question/plan contract works through a second adapter; failures and usage limits behave consistently |
| 30 | Publish first stable release | Release notes, supported-settings matrix, setup guide, operating limits, privacy/retention explanation, and known issues are complete |

Exit gate: all MVP scenarios pass on both hosting targets; restore succeeds; no unresolved high-impact authorization or batch-execution defects.

## 5. Important execution contracts

- A change plan is immutable after approval. Altering targets or values creates a new plan and requires approval again.
- Execution uses current requester authority and current bot permissions, not only the values observed during planning.
- Ordinary users cannot obtain administrative information merely because the bot can read it. Each data source has an explicit authorization policy.
- AI receives narrow, authorized context and a bounded tool interface. It never receives bot tokens or database credentials and never invokes arbitrary code.
- Use Discord snowflakes as strings and permission bitfields as BigInt-compatible values to avoid numeric precision loss.
- Snapshots support analysis and selected compensation; they are not complete server backups. Deleted messages and original object IDs cannot generally be restored.
- Persist job state before external writes. On an uncertain response, inspect actual Discord state before retrying. Begin with operations that set a desired value; defer destructive and non-idempotent actions.
- Initial deployments run one active executor. Scaling to multiple instances requires explicit ownership/locking and a storage redesign before enabling it.

## 6. Release validation checklist

- [ ] Settings and permission explanations match test-server behavior.
- [ ] Unauthorized requester, forged approval, expired plan, and wrong-server interactions fail safely.
- [ ] Preview performs no writes; changed settings trigger conflicts.
- [ ] Partial failure, rate limiting, restart, cancellation, and recovery produce truthful results.
- [ ] Message and configuration answers respect requesting-user access.
- [ ] Prompt injection cannot invoke unapproved changes or expose secrets.
- [ ] Missing intents and unavailable AI providers degrade cleanly.
- [ ] Database backup restores on a clean deployment.
- [ ] Both CPU architectures pass deployment smoke checks.
- [ ] A collaborator can install, contribute a module, and open a passing PR using documentation alone.

## 7. Timing and scope controls

Indicative effort for one experienced developer: M0–M3 in 4–6 developer-weeks; M4–M5 and operational polish bring the broader release to approximately 8–12 weeks total. Re-estimate after M1 and M2 using actual progress. Hardware testing, collaboration availability, and Discord intent review can affect elapsed time.

Defer dashboard, autonomous moderation, bulk bans/deletions, cross-server rollout, large historical message ingestion, vector databases, Kubernetes, and on-Pi model inference. Add these through separately scoped issues after the core is proven.

## 8. First implementation session

1. Confirm the existing repository owner/name, whether its current public visibility is acceptable, license, initial AI provider, and target Pi hardware.
2. Use `wavphile/discord_bot` as the canonical project repository and clone it into a dedicated project directory.
3. Commit this plan as the initial versioned project artifact; add repository foundation files in follow-up commits and open a draft PR for the first implementation work.
4. Create milestones M0–M5 and issues 01–30 from the tables above.
5. Implement issues 02–06 in dependency order and release `v0.1.0` after the M0 exit gate passes.

This document is a plan. The GitHub repository exists and is currently public; this plan commit starts its version history. No issues, releases, Discord application, or infrastructure have been created as part of preparing it.

## 9. Reference constraints

- [Discord permissions and role hierarchy](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)
- [Discord API rate limits](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)
- [Discord gateway and privileged intents](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)
- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy): API message content must not be used for AI training without express permission. Recheck current requirements during implementation and before release.

