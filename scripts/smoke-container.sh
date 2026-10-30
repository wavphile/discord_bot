#!/bin/sh
set -eu

expected_image_arch=${1:?Usage: smoke-container.sh <amd64|arm64>}
case "$expected_image_arch" in
  amd64) expected_node_arch=x64 ;;
  arm64) expected_node_arch=arm64 ;;
  *)
    printf 'Unsupported image architecture: %s\n' "$expected_image_arch" >&2
    exit 2
    ;;
esac

docker compose config --quiet
image_name=$(docker compose config --images | sed -n '1p')
if [ -z "$image_name" ]; then
  echo 'Docker Compose did not report a bot image name.' >&2
  exit 1
fi

docker compose build bot

actual_image_arch=$(docker image inspect --format '{{.Architecture}}' "$image_name")
if [ "$actual_image_arch" != "$expected_image_arch" ]; then
  printf 'Expected a linux/%s image, found linux/%s.\n' "$expected_image_arch" "$actual_image_arch" >&2
  exit 1
fi

docker compose run --rm --no-deps \
  --env "EXPECTED_NODE_ARCH=$expected_node_arch" \
  --entrypoint sh bot -ec '
    test "$(id -u)" -ne 0
    test -w /app/data
    test -f /app/dist/bot.js
    test ! -e /app/.env
    test ! -e /app/.env.example
    node -e "if (process.arch !== process.env.EXPECTED_NODE_ARCH) process.exit(1); console.log(\"PASS: Node architecture=\" + process.arch)"
  '

docker run --rm \
  --volume "$PWD/scripts/smoke-storage-container.mjs:/tmp/smoke-storage-container.mjs:ro" \
  --entrypoint node "$image_name" /tmp/smoke-storage-container.mjs

health_container="discord-bot-health-smoke-$(date +%s)-$$"
cleanup_health_container() {
  docker rm --force "$health_container" >/dev/null 2>&1 || true
}
trap cleanup_health_container EXIT HUP INT TERM

docker run --detach --name "$health_container" \
  --health-start-period=1s \
  --health-interval=1s \
  --health-timeout=3s \
  --health-retries=3 \
  --entrypoint node "$image_name" --input-type=module -e '
    import { createReadinessServer } from "/app/dist/health/readiness.js";
    const server = createReadinessServer({
      discordReady: () => true,
      databaseReady: () => true,
    });
    await server.listen();
    setTimeout(() => void server.close(), 30000);
  '

health_status=""
for attempt in $(seq 1 15); do
  health_status=$(docker inspect --format '{{.State.Health.Status}}' "$health_container")
  if [ "$health_status" = healthy ]; then
    break
  fi
  if [ "$health_status" = unhealthy ]; then
    docker inspect --format '{{json .State.Health.Log}}' "$health_container" >&2
    exit 1
  fi
  sleep 1
done

if [ "$health_status" != healthy ]; then
  docker inspect --format '{{json .State.Health.Log}}' "$health_container" >&2
  echo 'The image readiness health check did not become healthy.' >&2
  exit 1
fi
cleanup_health_container
trap - EXIT HUP INT TERM

printf 'PASS: Docker image architecture=linux/%s\n' "$actual_image_arch"
printf 'PASS: Docker image SQLite backup and restore\n'
printf 'PASS: Docker image readiness health check\n'
