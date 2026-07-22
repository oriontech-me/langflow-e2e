#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-docker.sh [image_tag]
# Example: ./scripts/start-langflow-docker.sh latest
#          ./scripts/start-langflow-docker.sh 1.3.0

set -euo pipefail

IMAGE_TAG="${1:-${LANGFLOW_IMAGE_TAG:-latest}}"
IMAGE="langflowai/langflow:${IMAGE_TAG}"
CONTAINER_NAME="langflow-e2e-runner"
PORT="${LANGFLOW_PORT:-7860}"

echo "Starting Langflow: ${IMAGE} on port ${PORT}..."

# Remove any previous container
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:7860" \
  -e LANGFLOW_AUTO_LOGIN=true \
  -e LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  -e LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  -e LANGFLOW_DEACTIVATE_TRACING=true \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}" \
  -e LANGFLOW_WORKERS="${LANGFLOW_WORKERS:-1}" \
  "${IMAGE}"

# LANGFLOW_WORKERS defaults to 1 here on purpose. Langflow's own default is
# (2 * cpu_count) + 1 gunicorn workers, each inheriting the full in-memory
# state (graphs, model catalog, chroma). On a small local Docker Desktop VM
# (commonly ~4 GB with no per-container limit), several heavy workers — each
# growing unbounded across requests with no recycling — exhaust the VM and the
# kernel SIGKILLs a worker mid-build, surfacing as ERR_EMPTY_RESPONSE / a
# node run that never completes (observed running the knowledge/agent specs
# locally; see #773). One worker is plenty locally, where the heavy specs run
# --workers=1 anyway. Override for a beefier box: LANGFLOW_WORKERS=4 ./scripts/...

echo "Waiting for Langflow to be ready (up to 120s)..."
for i in $(seq 1 24); do
  if curl -sf "http://localhost:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after $((i * 5))s"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
docker logs "${CONTAINER_NAME}"
exit 1
