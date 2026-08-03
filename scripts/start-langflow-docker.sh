#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-docker.sh [version]
#
# Image selection:
#   (no argument)   langflowai/langflow-nightly:latest — the reference image this
#                   suite validates against (CONTRIBUTING.md, daily-stable.yml and
#                   nightly.yml all run on it).
#   <version>       langflowai/langflow:<version> — a published build.
#                   Example: ./scripts/start-langflow-docker.sh 1.5.1
#   LANGFLOW_IMAGE  An exact image reference, which wins over both. Example:
#                   LANGFLOW_IMAGE=langflowai/langflow:latest ./scripts/start-langflow-docker.sh
#
# Nightly and released builds live in DIFFERENT Docker repositories
# (langflowai/langflow-nightly vs langflowai/langflow), and the nightly repo keeps
# only recent dev tags — which is why a version argument resolves against the
# release repo. Until #1076 the repository was hardcoded to langflowai/langflow, so
# no argument could reach the nightly and the documented "nightly by default" was
# false; the workaround was a hand-rolled `docker run` that duplicated the env
# block below, losing the LANGFLOW_WORKERS rationale with it.

set -euo pipefail

IMAGE_TAG="${1:-${LANGFLOW_IMAGE_TAG:-}}"

if [ -n "${LANGFLOW_IMAGE:-}" ]; then
  IMAGE="${LANGFLOW_IMAGE}"
elif [ -n "${IMAGE_TAG}" ]; then
  IMAGE="${LANGFLOW_IMAGE_REPO:-langflowai/langflow}:${IMAGE_TAG}"
else
  IMAGE="${LANGFLOW_IMAGE_REPO:-langflowai/langflow-nightly}:latest"
fi

CONTAINER_NAME="langflow-e2e-runner"
PORT="${LANGFLOW_PORT:-7860}"

echo "Starting Langflow: ${IMAGE} on port ${PORT}..."

# `latest` is a moving tag, so a local copy pulled days ago is silently stale —
# and testing today's build is the entire point of defaulting to the nightly.
# Refresh it here. Pinned versions are immutable, so they are left alone.
# A failed refresh must not cost you a working instance: with a local copy we warn
# and start it, naming the risk, rather than aborting an offline or low-disk box
# (the pull is a new step — the script never used to fail this way). With nothing
# local there is nothing to fall back to, so that path exits.
case "${IMAGE}" in
*:latest)
  echo "Refreshing ${IMAGE} (moving tag)..."
  if ! docker pull "${IMAGE}"; then
    if docker image inspect "${IMAGE}" > /dev/null 2>&1; then
      echo "WARNING: could not refresh ${IMAGE} — starting the LOCAL copy, which may be stale."
      echo "         Confirm the version reported below before trusting a run against it."
    else
      echo "ERROR: could not pull ${IMAGE}, and no local copy exists to fall back to."
      exit 1
    fi
  fi
  ;;
esac

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
  -e LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
  -e LANGFLOW_WORKERS="${LANGFLOW_WORKERS:-1}" \
  "${IMAGE}"

# LANGFLOW_A2A_ENABLED defaults to true here for the same reason
# LANGFLOW_ALLOW_CUSTOM_COMPONENTS does: the product default is OFF and the
# surface disappears silently. A2A's router is ALWAYS mounted and a per-request
# guard 404s every /api/v1/a2a/* route when the flag is off, so a disabled
# server is indistinguishable from an unmounted one — a spec written against it
# passes while testing nothing (#1240; surface scoped in #1195). Set
# LANGFLOW_A2A_ENABLED=false to reproduce the disabled state on purpose.

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
    # Report the build that actually came up. The image tag alone does not say
    # it — `latest` moves, and a spec doc's `Last validated` field records this
    # version, not the tag.
    VERSION="$(curl -sf "http://localhost:${PORT}/api/v1/version" 2>/dev/null || true)"
    [ -n "${VERSION}" ] && echo "Running: ${VERSION}"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
docker logs "${CONTAINER_NAME}"
exit 1
