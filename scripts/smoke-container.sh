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

printf 'PASS: Docker image architecture=linux/%s\n' "$actual_image_arch"
