#!/usr/bin/env bash
# Start a Langflow OSS instance FROM A LOCAL SOURCE CLONE.
#
# Third sibling of scripts/start-langflow-docker.sh and scripts/start-langflow-pip.sh,
# and the only one usable on the QA VMs: github.ibm.com has no Actions runners, and
# neither Docker nor Podman installs on those machines (the `universe` repository is
# blocked by policy). A container-based lane has no substrate there, and pip installs
# a published artifact rather than the clone under test — so the scheduled suite gets
# its instance from source or not at all.
#
# The environment block below is deliberately IDENTICAL to the pip script's. A spec
# must not be able to tell which starter brought its instance up; the moment the two
# diverge, a VM-only failure becomes indistinguishable from a product regression, and
# the whole point of running both lanes side by side is lost.
#
# Three things this script does that its siblings do not:
#
#   1. It keys EVERY piece of per-instance state on the port. The pip script writes a
#      fixed /tmp/langflow-e2e.pid and lets Langflow pick its default database, which
#      is correct for one local instance and fatal for a sharded lane: the second
#      start overwrites the first's PID file — so the stop script kills the wrong
#      process, or none — and both instances share one SQLite file. Here the PID
#      file, the log and the database live under a per-port state directory.
#   2. It does not touch the clone. A source checkout on a shared VM is also somebody's
#      working tree, and a lane that silently moves HEAD makes every later run
#      unattributable: the report names a commit the tree no longer has. Checking out
#      a ref is opt-in through LANGFLOW_SRC_REF, and it is the caller's decision.
#   3. It never names a machine. The bind address, the port and the repository path
#      are all parameters, which is what allows this file to live in a public
#      repository while the topology that fills them in lives on the destination's
#      wiki.
#
# Usage:
#   ./scripts/start-langflow-source.sh                      # clone at $LANGFLOW_SRC_REPO, port 7860
#   LANGFLOW_PORT=7861 ./scripts/start-langflow-source.sh    # a second instance, side by side
#   LANGFLOW_SRC_REF=v1.12.0 ./scripts/start-langflow-source.sh   # opt in to moving the clone
#   LANGFLOW_SRC_REPO=/srv/langflow ./scripts/start-langflow-source.sh
set -euo pipefail

REPO="${LANGFLOW_SRC_REPO:-$HOME/langflow-project/langflow}"
PORT="${LANGFLOW_PORT:-7860}"
BIND_HOST="${LANGFLOW_BIND_HOST:-0.0.0.0}"
# Where the health check looks. Split from BIND_HOST because the two answer
# different questions: what the server listens on, and what this script can reach.
HEALTH_HOST="${LANGFLOW_HEALTH_HOST:-localhost}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-/tmp/langflow-source-${PORT}}"
PID_FILE="${STATE_DIR}/langflow.pid"
LOG_FILE="${STATE_DIR}/langflow.log"
# Source starts are far slower than pip's 120 s: the first dependency sync on a cold
# cache compiles wheels. A deadline shorter than that reads as "Langflow is broken"
# when the truth is "the machine is still building".
START_TIMEOUT_S="${LANGFLOW_START_TIMEOUT_S:-300}"
# Kept a variable so the unit tests can exercise the timeout branch without sitting
# through it; five seconds is the interval every sibling script polls at.
POLL_INTERVAL_S="${LANGFLOW_POLL_INTERVAL_S:-5}"
KEEP_STATE="${LANGFLOW_SRC_KEEP_STATE:-0}"

if [ ! -d "${REPO}" ]; then
  echo "ERROR: Langflow source clone not found at ${REPO}" >&2
  echo "Clone langflow-ai/langflow there, or set LANGFLOW_SRC_REPO." >&2
  exit 2
fi

# Opt-in, and never a silent one: moving a shared clone is announced.
if [ -n "${LANGFLOW_SRC_REF:-}" ]; then
  echo "Checking out ${LANGFLOW_SRC_REF} in ${REPO}..."
  git -C "${REPO}" checkout --quiet "${LANGFLOW_SRC_REF}"
fi

SRC_SHA="$(git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Langflow source: ${REPO} @ ${SRC_SHA}"

# uv is Langflow's own toolchain, so it is the default; the venv path exists because
# a machine that cannot install uv can still run the lane. Both are overridable in
# one variable each, so a clone whose build differs does not need this file edited.
if [ -n "${LANGFLOW_SRC_RUN_CMD:-}" ]; then
  SYNC_CMD="${LANGFLOW_SRC_SYNC_CMD:-}"
  RUN_CMD="${LANGFLOW_SRC_RUN_CMD}"
elif command -v uv > /dev/null 2>&1; then
  # --frozen keeps the lockfile as committed. Without it a sync may rewrite
  # uv.lock in the clone, which is the same silent mutation point 2 above refuses.
  SYNC_CMD="${LANGFLOW_SRC_SYNC_CMD:-uv sync --frozen}"
  RUN_CMD="uv run langflow run"
else
  VENV="${LANGFLOW_SRC_VENV:-${STATE_DIR}/venv}"
  SYNC_CMD="${LANGFLOW_SRC_SYNC_CMD:-python3 -m venv ${VENV} && ${VENV}/bin/pip install --quiet -e ${REPO}}"
  RUN_CMD="${VENV}/bin/langflow run"
fi

mkdir -p "${STATE_DIR}"
if [ "${KEEP_STATE}" != "1" ]; then
  # A run inherits no flows, no users and no credentials from the last one. On a
  # long-lived VM that is not hygiene theatre: leftover state is exactly how a
  # green run stops proving anything, because the flow it needed was already there.
  rm -rf "${STATE_DIR}/data"
fi
mkdir -p "${STATE_DIR}/data"

if [ -n "${SYNC_CMD}" ]; then
  echo "Syncing dependencies (${SYNC_CMD})..."
  ( cd "${REPO}" && eval "${SYNC_CMD}" )
fi

echo "Starting Langflow on ${BIND_HOST}:${PORT} (logs: ${LOG_FILE})..."
# The flags below carry the same reasoning as scripts/start-langflow-pip.sh — read
# that file's comments for the why of each. Repeated here rather than sourced because
# a starter that hides its environment behind an include is a starter nobody audits.
#   LANGFLOW_DEACTIVATE_TRACING  local spend is out of scope for token history (#1300, #1183)
#   LANGFLOW_A2A_ENABLED         product default is OFF, and a disabled server passes every A2A spec while testing nothing (#1240, #1195)
#   LANGFLOW_SSRF_ALLOWED_HOSTS  private ranges only, loopback deliberately OUT (security/ssrf-url-validation.spec.ts asserts the refusal)
#   --workers 1                  Langflow defaults to (2*cpu)+1, each holding full in-memory state (#773) — and on this lane N shards multiply it
( cd "${REPO}" && \
  LANGFLOW_AUTO_LOGIN=true \
  LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  LANGFLOW_DEACTIVATE_TRACING=true \
  LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
  LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16}" \
  LANGFLOW_CONFIG_DIR="${STATE_DIR}/data" \
  LANGFLOW_DATABASE_URL="${LANGFLOW_DATABASE_URL:-sqlite:///${STATE_DIR}/data/langflow.db}" \
  ${RUN_CMD} --host "${BIND_HOST}" --port "${PORT}" --no-open-browser \
    --workers "${LANGFLOW_WORKERS:-1}" >> "${LOG_FILE}" 2>&1 ) &
echo $! > "${PID_FILE}"

echo "Waiting for Langflow to be ready (up to ${START_TIMEOUT_S}s)..."
ELAPSED=0
while [ "${ELAPSED}" -lt "${START_TIMEOUT_S}" ]; do
  if curl -sf "http://${HEALTH_HOST}:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after ${ELAPSED}s (PID: $(cat "${PID_FILE}"), port ${PORT})"
    exit 0
  fi
  sleep "${POLL_INTERVAL_S}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_S))
  echo "  Waiting... (${ELAPSED}s)"
done

echo "ERROR: Langflow did not become ready in ${START_TIMEOUT_S}s. Last log lines:" >&2
tail -n 20 "${LOG_FILE}" >&2 || true
kill "$(cat "${PID_FILE}")" 2>/dev/null || true
rm -f "${PID_FILE}"
exit 1
