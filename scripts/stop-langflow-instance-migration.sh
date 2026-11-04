#!/usr/bin/env bash
# Usage: ./scripts/stop-langflow-instance-migration.sh
#
# Removes the @instance-migration lane (#2347): its three containers and their network.
# Only the lane's own names, from scripts/lib/instance-migration-lane.sh — never the
# shared `langflow-e2e-runner` or any other session's container.
#
# Each removal is reported by what `docker container inspect` said before it, because
# `docker rm -f` exits 0 for a container that is not there (#2090): "removed" and
# "was not running" are different facts, and only the inspect can tell them apart.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/instance-migration-lane.sh
. "${HERE}/lib/instance-migration-lane.sh"

for name in "${IM_SOURCE_CONTAINER}" "${IM_PG_CONTAINER}" "${IM_S3_CONTAINER}"; do
  if docker container inspect "${name}" > /dev/null 2>&1; then
    docker rm -f "${name}" > /dev/null
    echo "removed ${name}"
  else
    echo "${name}: no such container"
  fi
done

if docker network inspect "${IM_NETWORK}" > /dev/null 2>&1; then
  docker network rm "${IM_NETWORK}" > /dev/null
  echo "removed network ${IM_NETWORK}"
fi
