# Deployment verification

This guide verifies a release of the bot in Docker Compose on a Linux amd64 VM and a 64-bit Raspberry Pi. Use the same Git tag or commit on both machines. CI builds and runs the production image on native amd64 and arm64 Linux runners; it does not replace testing on the target hardware.

## Prepare the host

On both machines, record the operating system and CPU architecture:

```sh
uname -a
uname -m
getconf LONG_BIT
free -h
```

On the Raspberry Pi, also record the model:

```sh
cat /proc/device-tree/model
```

Confirm that the Pi reports a 64-bit userspace (`getconf LONG_BIT` is `64`) and `uname -m` reports `aarch64`. The CI image check uses Docker's `arm64` name and Node.js's `arm64` name; an amd64 host reports Node.js architecture `x64`.

## Build and smoke-test the release image

Check out the same release tag or commit on both hosts:

```sh
git clone https://github.com/wavphile/discord_bot.git
cd discord_bot
git checkout <release-tag-or-commit>
git rev-parse HEAD
```

Create `.env` from the template, then add the development bot token, application ID, test-server ID, and allowed test user or role. Keep the file private and do not copy production credentials to a test machine.

```sh
cp .env.example .env
```

Run the smoke script for the host architecture. It builds the production image, checks Docker's image architecture and Node.js runtime architecture, and verifies that the process runs as a non-root user with writable persistent data and no copied `.env` files.

```sh
# On an amd64 VM:
sh scripts/smoke-container.sh amd64

# On a 64-bit ARM Raspberry Pi:
sh scripts/smoke-container.sh arm64
```

Start the already-built image and check the logs:

```sh
docker compose up -d --no-build
docker compose logs --tail=100 bot
```

Wait for `docker compose ps` to report the service as healthy. The image health check stays private to the container and requires both a connected Discord client and a responsive SQLite database. For backup, restore, disk-space, and token-rotation procedures, see [operations.md](operations.md).

In the test server, run `/health` and record whether the bot responds and reports its SQLite schema version. Check that it remains connected after a restart:

```sh
docker compose restart bot
docker compose logs --tail=100 bot
```

Stop the service after the smoke test:

```sh
docker compose down
```

The `bot-data` volume remains after `docker compose down`; do not add `--volumes` unless the test database should be deleted. The database can contain opted-in message text for up to the configured retention period.

## Record operating measurements

Capture the same values on both hosts. Record the release SHA, host details, approximate Discord server member count, `/health` result, and test date. Observe one idle period and a bounded normal-use period, then record the highest CPU and memory values shown by `docker stats`:

```sh
container_id=$(docker compose ps -q bot)
docker stats --no-stream "$container_id"
```

For a short sample, refresh the display while the bot is idle and while performing normal test-server interactions:

```sh
watch -n 10 "docker stats --no-stream $(docker compose ps -q bot)"
```

Use the same observation duration and representative workload on both hosts. Do not enable message retention just to create load; use only a disposable channel and non-sensitive content if exercising that feature.

| Field                                                   | Linux VM | Raspberry Pi |
| ------------------------------------------------------- | -------- | ------------ |
| Test date and release SHA/tag                           |          |              |
| OS and kernel                                           |          |              |
| CPU architecture and model                              |          |              |
| RAM                                                     |          |              |
| Discord server member count                             |          |              |
| `/health` result and schema version                     |          |              |
| Container startup/restart result                        |          |              |
| Idle CPU and memory, with duration                      |          |              |
| Highest observed CPU and memory, with workload/duration |          |              |
| Notes or errors                                         |          |              |

M5-25 is complete only after this table is filled with results from an amd64 Linux VM and an actual 64-bit Raspberry Pi. A successful cross-build or emulated image does not count as a physical-device result.
