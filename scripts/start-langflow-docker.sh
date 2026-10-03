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
# Knobs a lane sets and a developer normally does not (#2085). Every default below is
# what this script did before they existed, so local use is unchanged:
#   LANGFLOW_CONTAINER_NAME   default langflow-e2e-runner. A sharded caller gives each
#                             port its own name, because starting removes the old one.
#   LANGFLOW_BIND_HOST        unset publishes on every interface, as before; set it
#                             (e.g. 127.0.0.1) on a machine others can reach.
#   LANGFLOW_READY_TIMEOUT_S  default 120. A caller with its own, longer budget raises
#                             it, or this loop fails a cold start first.
#   LANGFLOW_HOSTS_FILE       unset leaves /etc/hosts to docker, as before. A path is
#                             mounted read-only as the container's /etc/hosts (#2159).
#                             On a host booted with ipv6.disable=1, docker writes no
#                             `::1 localhost` line and drops an IPv6 --add-host, so
#                             `localhost` resolves to 127.0.0.1 alone in the container.
#                             A caller that needs the resolution a host with IPv6 gives
#                             passes a file that has the line. It must be a regular
#                             file that exists; anything else is refused here rather
#                             than started blind. This cannot see what a snap docker
#                             cannot read (/tmp, say), so keep it under $HOME.
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

CONTAINER_NAME="${LANGFLOW_CONTAINER_NAME:-langflow-e2e-runner}"
PORT="${LANGFLOW_PORT:-7860}"
READY_TIMEOUT_S="${LANGFLOW_READY_TIMEOUT_S:-120}"
# A leading zero is refused, not stripped: bash reads it as octal, so `08` aborted
# after the container was already running and `030` silently became 24 s.
case "${READY_TIMEOUT_S}" in
  '' | *[!0-9]* | 0*) echo "LANGFLOW_READY_TIMEOUT_S must be a positive integer of seconds with no leading zero, got: '${READY_TIMEOUT_S}'" >&2; exit 1 ;;
esac

# The readiness probe must ask the address the port is published on: bound to one
# non-loopback address, `localhost` is refused and a healthy container would time
# out. A wildcard bind, or none, still answers on localhost. IPv6 takes brackets in
# both the publish spec and the URL; a value given with them is accepted as well.
BIND_HOST="${LANGFLOW_BIND_HOST:-}"
BIND_HOST="${BIND_HOST#[}"
BIND_HOST="${BIND_HOST%]}"
case "${BIND_HOST}" in
  *:*) BIND_ADDR="[${BIND_HOST}]" ;;
  *) BIND_ADDR="${BIND_HOST}" ;;
esac
# The container listens on the SAME port it is published on, not on the image's 7860.
# Langflow calls itself at the address the tests use: the A2A node fetches its own card
# and the Streamable HTTP MCP test registers this instance's own endpoint, both at
# localhost:<port>. Remapped (7881->7860), that address does not exist inside the
# container and the call fails without a word; this is what the Actions service
# container never hit, because it serves on 7860 and is addressed on 7860 (#2159).
# The default port is unchanged: 7860:7860, as before.
PUBLISH="${PORT}:${PORT}"
PROBE_HOST="localhost"
if [ -n "${BIND_HOST}" ]; then
  PUBLISH="${BIND_ADDR}:${PUBLISH}"
  case "${BIND_HOST}" in
    0.0.0.0 | ::) ;;
    *) PROBE_HOST="${BIND_ADDR}" ;;
  esac
fi

HOSTS_MOUNT=()
if [ -n "${LANGFLOW_HOSTS_FILE:-}" ]; then
  if [ ! -f "${LANGFLOW_HOSTS_FILE}" ] || [ ! -r "${LANGFLOW_HOSTS_FILE}" ]; then
    echo "LANGFLOW_HOSTS_FILE is set but not a readable file: '${LANGFLOW_HOSTS_FILE}'" >&2
    exit 1
  fi
  HOSTS_MOUNT=(-v "${LANGFLOW_HOSTS_FILE}:/etc/hosts:ro")
fi

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

# LANGFLOW_DEACTIVATE_TRACING=true below is a DECISION, not an oversight: a local
# instance writes no traces, so the token recorder (scripts/watch-tokens.mjs) cannot
# see developer spend at all. Local spend is out of scope for
# reports/token-history.jsonl — flipping this would produce traces nobody can
# attribute, because the CI secret and a developer's .env share one account balance
# and the key separation that would tell them apart is unimplemented (#1300, #1183).
# The consequence: that file is CI spend and is never total account spend. The
# reasoning is in reports/README.md; do not change this flag without updating it.
# It is a DEFAULT since #2085, not a constant: a lane records its own spend and runs
# with tracing on (run-e2e.sh, daily-stable.yml — #1714), and says so explicitly.
#
# LANGFLOW_WORKER_TIMEOUT and LANGFLOW_SQLITE_PRAGMAS are passed by NAME, with no
# value: docker forwards a variable named that way only when it is set, so a
# developer's instance keeps the product defaults and a lane that sets them gets them.
# run-e2e.sh is explicit that the worker timeout is not a starter default (#1048), and
# the pragmas replace the product dict wholesale (#1717) — neither belongs here as one.
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PUBLISH}" \
  ${HOSTS_MOUNT[@]+"${HOSTS_MOUNT[@]}"} \
  -e LANGFLOW_PORT="${PORT}" \
  -e LANGFLOW_AUTO_LOGIN=true \
  -e LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  -e LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  -e LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-true}" \
  -e LANGFLOW_WORKER_TIMEOUT \
  -e LANGFLOW_SQLITE_PRAGMAS \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}" \
  -e LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
  -e LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16}" \
  -e LANGFLOW_KB_ALLOWED_FOLDER_ROOTS="${LANGFLOW_KB_ALLOWED_FOLDER_ROOTS:-~/.cache/langflow}" \
  -e LANGFLOW_WORKERS="${LANGFLOW_WORKERS:-1}" \
  "${IMAGE}"

# LANGFLOW_A2A_ENABLED defaults to true here for the same reason
# LANGFLOW_ALLOW_CUSTOM_COMPONENTS does: the product default is OFF and the
# surface disappears silently. A2A's router is ALWAYS mounted and a per-request
# guard 404s every /api/v1/a2a/* route when the flag is off, so a disabled
# server is indistinguishable from an unmounted one — a spec written against it
# passes while testing nothing (#1240; surface scoped in #1195). Set
# LANGFLOW_A2A_ENABLED=false to reproduce the disabled state on purpose.

# LANGFLOW_SSRF_ALLOWED_HOSTS carries the SAME value all four CI lanes set
# (pr-validation, daily-stable, nightly, manual — the daily/nightly/manual also
# allow the `ollama` service name). Without it a local instance behaves
# differently from every lane: Langflow's SSRF guard blocks private addresses, so
# a self-hosted go-httpbin (ECHO_BASE_URL) or a private-network service is
# refused locally while working in CI. The divergence is silent — the spec that
# needs it skips, or fails on a message that names no cause — which is the same
# trap LANGFLOW_ALLOW_CUSTOM_COMPONENTS (#668) and LANGFLOW_A2A_ENABLED (#1240)
# were set here to avoid. Loopback is deliberately NOT allow-listed: several
# specs use an SSRF-blocked loopback fetch as a deterministic error generator
# (core-functionality/llm-agents/agent-tool-error-handling.spec.ts), and
# security/ssrf-url-validation.spec.ts asserts that refusal. Override to
# reproduce another configuration: LANGFLOW_SSRF_ALLOWED_HOSTS="" ./scripts/...

# LANGFLOW_KB_ALLOWED_FOLDER_ROOTS is the knowledge-base `folder` connector's
# operator allow-list: empty by default, and empty refuses every walk. It is set to
# the image's config directory — where POST /api/v1/files/upload/{flow_id} stores an
# upload — so core-functionality/memory/memory-base-ingestion.spec.ts can ingest a
# folder it owns, exactly as every CI lane allows (#2043). The `~` stays literal on
# purpose (double quotes stop bash expanding it): it is the CONTAINER's home the
# server must expand, not this host's.

# LANGFLOW_WORKERS defaults to 1 here on purpose. Langflow's own default is
# (2 * cpu_count) + 1 gunicorn workers, each inheriting the full in-memory
# state (graphs, model catalog, chroma). On a small local Docker Desktop VM
# (commonly ~4 GB with no per-container limit), several heavy workers — each
# growing unbounded across requests with no recycling — exhaust the VM and the
# kernel SIGKILLs a worker mid-build, surfacing as ERR_EMPTY_RESPONSE / a
# node run that never completes (observed running the knowledge/agent specs
# locally; see #773). One worker is plenty locally, where the heavy specs run
# --workers=1 anyway. Override for a beefier box: LANGFLOW_WORKERS=4 ./scripts/...

echo "Waiting for Langflow to be ready (up to ${READY_TIMEOUT_S}s)..."
for i in $(seq 1 $(((READY_TIMEOUT_S + 4) / 5))); do
  if curl -sf "http://${PROBE_HOST}:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after $((i * 5))s"
    # Report the build that actually came up. The image tag alone does not say
    # it — `latest` moves, and a spec doc's `Last validated` field records this
    # version, not the tag.
    VERSION="$(curl -sf "http://${PROBE_HOST}:${PORT}/api/v1/version" 2>/dev/null || true)"
    [ -n "${VERSION}" ] && echo "Running: ${VERSION}"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
docker logs "${CONTAINER_NAME}"
exit 1
