# v1.0.0 release notes — draft

**Not released.** This draft is for review; it does not create or announce a `v1.0.0` tag. Release publication waits for the required Linux VM and physical 64-bit Raspberry Pi verification in [the release-readiness checklist](release-readiness.md).

## Planned capabilities

- Inspect supported server configuration and snapshots, explain channel permissions, and compare saved snapshots.
- Preview bounded channel and permission changes, submit them for independent approval, apply them through a durable job, review the audit trail, and prepare guarded reversals.
- Answer configuration questions and produce structured change suggestions using the provider interface. The default `mock` provider is local test output; OpenAI and Anthropic require local credentials and explicit configuration.
- Retrieve recent messages only for an explicitly enabled channel and request, produce private source-linked summaries, and optionally retain opted-in messages locally with expiry and purge controls.
- Run with Docker Compose, expose private readiness checks, back up and restore SQLite data, and migrate the database through versioned schema changes.
- Extend the bot with documented in-repository feature modules.

## Known limitations and required follow-up

- `v1.0.0` remains gated on actual Linux VM and 64-bit Raspberry Pi runs with resource measurements.
- Several Discord-side approval, application, reversal, multi-channel, message-retention, and hosted-provider scenarios still need controlled live tests. See [testing.md](testing.md) and [release-readiness.md](release-readiness.md).
- The repository owner has not selected a license. The project does not invite external contributions until that decision is recorded.
- Snapshots are visibility-limited analysis data and are not complete server backups. Multi-target Discord changes are not atomic.

Before publication, replace this draft marker with the release date and exact release commit, verify every listed claim against the final tag, and link the published container digest if one is produced.
