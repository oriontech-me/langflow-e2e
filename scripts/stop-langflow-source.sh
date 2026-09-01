#!/usr/bin/env bash
# Stop the instance scripts/start-langflow-source.sh started on a given port.
#
# Takes the port rather than assuming one, because the source lane runs several
# instances side by side and a stop that guesses is a stop that kills a shard still
# running. Same reason the PID file is per-port there.
#
# It waits for the process to actually be gone before saying so. "kill returned 0"
# only means the signal was delivered; a stop that reports success while the port is
# still bound is worse than one that fails, because the next start then collides with
# an instance nothing knows about — and /health_check answers from whichever process
# holds the port, so that collision reads as a fast, healthy start.
#
# Usage:
#   ./scripts/stop-langflow-source.sh                 # port 7860
#   LANGFLOW_PORT=7861 ./scripts/stop-langflow-source.sh
set -euo pipefail

PORT="${LANGFLOW_PORT:-7860}"
STATE_ROOT="${LANGFLOW_SRC_STATE_ROOT:-/tmp}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-${STATE_ROOT}/langflow-source-${PORT}}"
PID_FILE="${STATE_DIR}/langflow.pid"
# How long to wait for a graceful exit before escalating.
TERM_TIMEOUT_S="${LANGFLOW_STOP_TIMEOUT_S:-15}"

if [ ! -f "${PID_FILE}" ]; then
  echo "No PID file for port ${PORT} (${PID_FILE})."
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "Process ${PID} already gone; clearing the PID file for port ${PORT}."
  rm -f "${PID_FILE}"
  exit 0
fi

kill "${PID}" 2>/dev/null || true
WAITED=0
while [ "${WAITED}" -lt "${TERM_TIMEOUT_S}" ]; do
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "Langflow on port ${PORT} stopped (PID ${PID}, after ${WAITED}s)."
    rm -f "${PID_FILE}"
    exit 0
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

# SIGTERM was ignored or the shutdown hung. Escalating is right: the alternative is
# leaving the port bound, and the next start would then be refused (or, without the
# start script's port check, silently answered by this very process).
echo "PID ${PID} did not exit in ${TERM_TIMEOUT_S}s; sending SIGKILL." >&2
kill -9 "${PID}" 2>/dev/null || true
sleep 1
if kill -0 "${PID}" 2>/dev/null; then
  echo "ERROR: PID ${PID} survived SIGKILL; port ${PORT} may still be bound." >&2
  echo "Leaving ${PID_FILE} in place so the next start refuses instead of colliding." >&2
  exit 1
fi

echo "Langflow on port ${PORT} killed (PID ${PID})."
rm -f "${PID_FILE}"
