#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="terminalbench"

colima start "$PROFILE" \
  --activate=false \
  --ssh-config=false \
  --runtime docker \
  --vm-type vz \
  --vz-rosetta \
  --cpus 4 \
  --memory 8 \
  --disk 60 \
  --mount "$ROOT:w" \
  --network-mode shared \
  --port-forwarder none

export DOCKER_HOST="unix://$HOME/.colima/$PROFILE/docker.sock"
docker info >/dev/null
printf 'TerminalBench Docker sandbox ready: %s\n' "$DOCKER_HOST"
