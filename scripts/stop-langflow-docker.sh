#!/usr/bin/env bash
# Usage: ./scripts/stop-langflow-docker.sh
# LANGFLOW_CONTAINER_NAME stops the container start-langflow-docker.sh was given
# under that name (#2085); the default is the name it uses when none is given.
set -euo pipefail
CONTAINER_NAME="${LANGFLOW_CONTAINER_NAME:-langflow-e2e-runner}"
echo "Stopping Langflow container ${CONTAINER_NAME}..."
docker rm -f "${CONTAINER_NAME}" 2>/dev/null && echo "Container stopped." || echo "No container to stop."
