#!/usr/bin/env bash
# Stop the Ollama scripts/start-ollama-source.sh started on a given port.
#
# Mirror of scripts/stop-echo-source.sh, and it takes the port for the same reason:
# the lane may run more than one instance side by side, and a stop that guesses is a
# stop that kills the one still in use.
#
# It waits for the process to be gone before saying so. "kill returned 0" only means
# the signal was delivered, and a stop that reports success while the port is still
# bound is worse than one that fails: the next start then collides with a server
# nothing knows about, and /api/tags answers from whichever process holds the port —
# so the collision reads as a fast, healthy start, with that server's model list.
#
# Usage:
#   ./scripts/stop-ollama-source.sh                    # port 11434
#   OLLAMA_PORT=11435 ./scripts/stop-ollama-source.sh
set -euo pipefail

PORT="${OLLAMA_PORT:-11434}"
STATE_ROOT="${OLLAMA_STATE_ROOT:-/tmp}"
STATE_DIR="${OLLAMA_STATE_DIR:-${STATE_ROOT}/ollama-source-${PORT}}"
PID_FILE="${STATE_DIR}/ollama.pid"
TERM_TIMEOUT_S="${OLLAMA_STOP_TIMEOUT_S:-10}"

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
    echo "Ollama on port ${PORT} stopped (PID ${PID}, after ${WAITED}s)."
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

echo "Ollama on port ${PORT} killed (PID ${PID})."
rm -f "${PID_FILE}"
