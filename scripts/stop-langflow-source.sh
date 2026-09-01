#!/usr/bin/env bash
# Stop the instance scripts/start-langflow-source.sh started on a given port.
#
# Takes the port rather than assuming one, because the source lane runs several
# instances side by side and a stop that guesses is a stop that kills a shard still
# running. Same reason the PID file is per-port there.
#
# Usage:
#   ./scripts/stop-langflow-source.sh                 # port 7860
#   LANGFLOW_PORT=7861 ./scripts/stop-langflow-source.sh
set -euo pipefail

PORT="${LANGFLOW_PORT:-7860}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-/tmp/langflow-source-${PORT}}"
PID_FILE="${STATE_DIR}/langflow.pid"

if [ ! -f "${PID_FILE}" ]; then
  echo "No PID file for port ${PORT} (${PID_FILE})."
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if kill "${PID}" 2>/dev/null; then
  echo "Langflow on port ${PORT} stopped (PID ${PID})."
else
  echo "Process ${PID} already gone."
fi
rm -f "${PID_FILE}"
