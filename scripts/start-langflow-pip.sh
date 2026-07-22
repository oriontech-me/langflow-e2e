#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-pip.sh [branch_or_version]
# Example: ./scripts/start-langflow-pip.sh main
#          ./scripts/start-langflow-pip.sh 1.3.0
#          ./scripts/start-langflow-pip.sh git+https://github.com/langflow-ai/langflow.git@feat/my-feature

set -euo pipefail

TARGET="${1:-${LANGFLOW_VERSION:-langflow}}"
PORT="${LANGFLOW_PORT:-7860}"
PID_FILE="/tmp/langflow-e2e.pid"

echo "Installing Langflow: ${TARGET}..."
if [[ "${TARGET}" == git+* ]] || [[ "${TARGET}" == *"github.com"* ]]; then
  pip install "${TARGET}" --quiet
elif [[ "${TARGET}" =~ ^[0-9] ]]; then
  pip install "langflow==${TARGET}" --quiet
else
  pip install langflow --quiet
fi

echo "Starting Langflow on port ${PORT}..."
LANGFLOW_AUTO_LOGIN=true \
LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
LANGFLOW_DEACTIVATE_TRACING=true \
  langflow run --host 0.0.0.0 --port "${PORT}" --no-open-browser \
    --workers "${LANGFLOW_WORKERS:-1}" &
# --workers defaults to 1: Langflow's own default is (2*cpu)+1 workers, each
# holding the full in-memory state, which exhausts memory on a constrained dev
# box and gets a worker SIGKILLed mid-build (ERR_EMPTY_RESPONSE / node run never
# completes — see #773). Override with LANGFLOW_WORKERS on a beefier machine.
echo $! > "${PID_FILE}"

echo "Waiting for Langflow to be ready (up to 120s)..."
for i in $(seq 1 24); do
  if curl -sf "http://localhost:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after $((i * 5))s (PID: $(cat ${PID_FILE}))"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
kill "$(cat ${PID_FILE})" 2>/dev/null || true
exit 1
