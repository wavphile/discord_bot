# v1.0.0 release readiness

**Status: not released.** This page tracks evidence and remaining work for the first stable release. Do not tag or announce `v1.0.0` until the M5 exit gate in [the project plan](project-plan.md#milestone-m5--deployment-and-release-hardening-v100) is satisfied.

## Release gate

| Requirement                                                   | Status                                                                                   | Evidence or next action                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean install, configuration, checks, and test-server startup | Implemented; continue using the [testing guide](testing.md)                              | CI checks formatting, types, tests, and build without Discord credentials. PR tryouts verify startup and command registration in the private server.                                                                       |
| Read-only inspection and permission calculations              | Basic smoke checks passed; `/server diff` and representative non-owner comparison remain | `/server inspect`, the owner permission case, and mock `/ask` passed in `#bots`. Check `/server diff` and a non-owner role/overwrite case when another test account is available; see [testing notes](testing.md).         |
| Reviewed change plans and recovery                            | Automated coverage complete; live preview and execution scenarios remain                 | Try `/plan topic` and `/plan permission`, then use a separate approver for `/plan apply`. Also test partial failure/restart, reversal, and the 10-channel exit scenario. Do not exercise writes on a production server.    |
| Message retrieval, summary, and retention                     | Automated coverage complete; live message scenarios remain                               | Use a disposable channel and non-sensitive text to check `/ask include_messages:true`, `/summarize`, event reconciliation, expiry, and purge. Review local SQLite content retention first.                                 |
| Hosted AI providers                                           | Adapter tests complete; live provider output remains unverified                          | The default is `mock`. A live OpenAI or Anthropic request requires a separately configured key and review of the [provider data-handling notes](ai-providers.md).                                                          |
| Read-only module example                                      | Implemented; direct command response remains optional follow-up                          | The `/server-info` module is documented in [the module guide](modules.md); its live reply has not been checked.                                                                                                            |
| Linux VM and physical 64-bit Raspberry Pi                     | **Required blocker**                                                                     | Run both deployments and record host, release SHA, server size, health, restart, and resource measurements in [the deployment guide](deployment.md). Native CI containers do not replace the physical-device measurements. |
| License and external contribution terms                       | **Owner decision pending**                                                               | The repository currently has no `LICENSE` file. Choose and record a license before inviting external contributions; this page does not choose one.                                                                         |

## Known operating limits

- One active bot instance uses one SQLite database. Do not run multiple writers against the same database.
- Snapshots include only channels the bot can view and are not complete server backups.
- Applying a multi-channel plan can partially succeed because Discord operations are not atomic. Review the per-item result and audit history.
- Message retrieval and message retention are separate. Retrieval is on demand and is not persisted; retention stores opted-in human-authored text in local SQLite until expiry, deletion, or purge.
- Hosted providers receive the bounded prompt evidence when selected. Review [provider configuration and data handling](ai-providers.md) before enabling one.
- Features outside the [supported-settings matrix](supported-settings.md), including bans, deletes, broad guild-setting edits, and cross-server rollout, remain out of scope.

## First-release notes draft

The proposed content for v1.0.0 is in [the release-notes draft](release-notes-v1.0.0-draft.md). It is not a release announcement. Complete the required hardware verification and remaining release checks before publishing it.
