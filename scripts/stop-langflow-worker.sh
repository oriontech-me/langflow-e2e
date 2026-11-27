#!/usr/bin/env bash
# Stop the worker scripts/start-langflow-worker.sh started beside a given port (#2574).
#
# Same contract as scripts/stop-langflow-source.sh: it takes the port, waits for the
# process to be gone before saying so, escalates to SIGKILL, and keeps the PID file
# when even that fails, so the next start refuses instead of running two workers on
# one queue. Nothing to stop is not an error.
#
# Usage:
#   LANGFLOW_PORT=7878 ./scripts/stop-langflow-worker.sh
set -euo pipefail

PORT="${LANGFLOW_PORT:-7860}"
STATE_ROOT="${LANGFLOW_SRC_STATE_ROOT:-/tmp}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-${STATE_ROOT}/langflow-source-${PORT}}"
PID_FILE="${STATE_DIR}/worker.pid"
TERM_TIMEOUT_S="${LANGFLOW_WORKER_STOP_TIMEOUT_S:-30}"

if [ ! -f "${PID_FILE}" ]; then
  echo "No worker PID file beside port ${PORT} (${PID_FILE})."
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "Worker ${PID} already gone; clearing the PID file beside port ${PORT}."
  rm -f "${PID_FILE}"
  exit 0
fi

kill "${PID}" 2>/dev/null || true
WAITED=0
while [ "${WAITED}" -lt "${TERM_TIMEOUT_S}" ]; do
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "Worker beside port ${PORT} stopped (PID ${PID}, after ${WAITED}s)."
    rm -f "${PID_FILE}"
    exit 0
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

echo "Worker ${PID} did not exit in ${TERM_TIMEOUT_S}s; sending SIGKILL." >&2
kill -9 "${PID}" 2>/dev/null || true
sleep 1
if kill -0 "${PID}" 2>/dev/null; then
  echo "ERROR: worker ${PID} survived SIGKILL." >&2
  echo "Leaving ${PID_FILE} in place so the next start refuses instead of running two workers." >&2
  exit 1
fi

echo "Worker beside port ${PORT} killed (PID ${PID})."
rm -f "${PID_FILE}"
