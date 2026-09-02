#!/usr/bin/env bash
# Stop the echo endpoint scripts/start-echo-source.sh started on a given port.
#
# Mirror of scripts/stop-langflow-source.sh, and it takes the port for the same
# reason: the lane may run more than one endpoint side by side, and a stop that
# guesses is a stop that kills the one still in use.
#
# It waits for the process to be gone before saying so. "kill returned 0" only means
# the signal was delivered, and a stop that reports success while the port is still
# bound is worse than one that fails: the next start then collides with an endpoint
# nothing knows about, and /get answers from whichever process holds the port — so the
# collision reads as a fast, healthy start.
#
# Usage:
#   ./scripts/stop-echo-source.sh                 # port 8080
#   ECHO_PORT=8081 ./scripts/stop-echo-source.sh
set -euo pipefail

PORT="${ECHO_PORT:-8080}"
STATE_ROOT="${ECHO_STATE_ROOT:-/tmp}"
STATE_DIR="${ECHO_STATE_DIR:-${STATE_ROOT}/echo-source-${PORT}}"
PID_FILE="${STATE_DIR}/echo.pid"
TERM_TIMEOUT_S="${ECHO_STOP_TIMEOUT_S:-10}"

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
    echo "Echo endpoint on port ${PORT} stopped (PID ${PID}, after ${WAITED}s)."
    rm -f "${PID_FILE}"
    exit 0
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

# Escalating is right: the alternative is leaving the port bound, and the next start
# would then be refused — or, without that check, silently answered by this process.
echo "PID ${PID} did not exit in ${TERM_TIMEOUT_S}s; sending SIGKILL." >&2
kill -9 "${PID}" 2>/dev/null || true
sleep 1
if kill -0 "${PID}" 2>/dev/null; then
  echo "ERROR: PID ${PID} survived SIGKILL; port ${PORT} may still be bound." >&2
  echo "Leaving ${PID_FILE} in place so the next start refuses instead of colliding." >&2
  exit 1
fi

echo "Echo endpoint on port ${PORT} killed (PID ${PID})."
rm -f "${PID_FILE}"
