#!/usr/bin/env bash
# Usage: ./scripts/stop-langflow-docker.sh
# LANGFLOW_CONTAINER_NAME stops the container start-langflow-docker.sh was given
# under that name (#2085); the default is the name it uses when none is given.
set -euo pipefail
CONTAINER_NAME="${LANGFLOW_CONTAINER_NAME:-langflow-e2e-runner}"
echo "Stopping Langflow container ${CONTAINER_NAME}..."

# What is printed comes from asking first, never from the exit status of `rm -f`:
# on docker 29 `rm -f` of a container that does not exist exits 0 and says
# nothing, so "Container stopped." was printed for a container that was never
# there and "No container to stop." could not appear at all (#2090).
# An inspect that fails for any other reason (daemon down, permission denied) is
# not an absent container, so it is named and fails rather than reading as one.
if ! inspect_err="$(docker container inspect "${CONTAINER_NAME}" 2>&1 > /dev/null)"; then
  if printf '%s' "${inspect_err}" | grep -qi "no such"; then
    echo "No container to stop."
    exit 0
  fi
  echo "Could not check for container ${CONTAINER_NAME}: ${inspect_err}" >&2
  exit 1
fi
docker rm -f "${CONTAINER_NAME}" > /dev/null
echo "Container stopped."
