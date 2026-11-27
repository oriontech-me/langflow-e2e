#!/usr/bin/env bash
# Start a `langflow worker` beside the instance scripts/start-langflow-source.sh started
# on a given port, sharing its configuration directory and its database (#2574).
#
# The worker is the other half of the database-backed background backend
# (LANGFLOW_BACKGROUND_BACKEND=scaled, upstream #13508): the API only QUEUES a v2
# background run, and a worker lease-claims it off the shared job table and runs it.
# It needs the SAME database as the API, which is why it takes the API's port and
# derives the state directory the same way the source starter does, instead of being
# told a database URL: two processes pointed at two databases would each look healthy
# and no job would ever run.
#
# Self-contained on purpose: the VM lane pipes it to `bash -s` on the target, where no
# file of this repository exists (the same contract as every other starter here).
#
# Ready means REGISTERED: a worker writes a row into `worker_registry` (#15790) when it
# starts, and that row is what the queue's claimers are. A live process that never
# registers is not a worker yet, so the starter waits for the row, not for the PID.
#
# Usage:
#   LANGFLOW_PORT=7878 LANGFLOW_SRC_RUN_CMD="$VENV/bin/langflow run" ./scripts/start-langflow-worker.sh
#
# Environment:
#   LANGFLOW_PORT                  the API's port (required): finds its state directory
#   LANGFLOW_SRC_STATE_ROOT/_DIR   as scripts/start-langflow-source.sh reads them
#   LANGFLOW_SRC_WORKER_CMD        the command that runs a worker; default: the API's
#                                  LANGFLOW_SRC_RUN_CMD with its trailing ` run`
#                                  replaced by ` worker`
#   LANGFLOW_DATABASE_URL          as the source starter reads it (default: the SQLite
#                                  file in the state directory)
#   LANGFLOW_WORKER_READY_TIMEOUT_S  how long to wait for the registration (default 120;
#                                  measured boot on the QA VM: ~18 s)
set -euo pipefail

PORT="${LANGFLOW_PORT:-}"
[ -n "${PORT}" ] || { echo "ERROR: LANGFLOW_PORT is required: the worker shares that instance's database." >&2; exit 2; }
STATE_ROOT="${LANGFLOW_SRC_STATE_ROOT:-/tmp}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-${STATE_ROOT}/langflow-source-${PORT}}"
API_PID_FILE="${STATE_DIR}/langflow.pid"
PID_FILE="${STATE_DIR}/worker.pid"
LOG_FILE="${STATE_DIR}/worker.log"
READY_TIMEOUT_S="${LANGFLOW_WORKER_READY_TIMEOUT_S:-120}"
DATABASE_URL="${LANGFLOW_DATABASE_URL:-sqlite:///${STATE_DIR}/data/langflow.db}"

# The worker command: given, or derived from the API's run command.
WORKER_CMD="${LANGFLOW_SRC_WORKER_CMD:-}"
if [ -z "${WORKER_CMD}" ]; then
  RUN_CMD="${LANGFLOW_SRC_RUN_CMD:-}"
  case "${RUN_CMD}" in
    *" run") WORKER_CMD="${RUN_CMD% run} worker" ;;
    *)
      echo "ERROR: cannot derive the worker command from LANGFLOW_SRC_RUN_CMD='${RUN_CMD}' (it must end in ' run');" >&2
      echo "       set LANGFLOW_SRC_WORKER_CMD." >&2
      exit 2
      ;;
  esac
fi

# The API must be up first: it is what creates and migrates the database the worker
# claims from, and a worker on a database with no job table only logs errors.
if [ ! -f "${API_PID_FILE}" ] || ! kill -0 "$(cat "${API_PID_FILE}")" 2>/dev/null; then
  echo "ERROR: no instance of scripts/start-langflow-source.sh is running on port ${PORT} (${API_PID_FILE})." >&2
  echo "       Start it first, with LANGFLOW_BACKGROUND_BACKEND=scaled." >&2
  exit 2
fi
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "ERROR: a worker started by this script is already running beside port ${PORT} (PID $(cat "${PID_FILE}"))." >&2
  echo "       Stop it first: LANGFLOW_PORT=${PORT} ./scripts/stop-langflow-worker.sh" >&2
  exit 2
fi

# When the launch happened, in UTC, so a row a PREVIOUS worker left behind is never
# read as this one's registration.
LAUNCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%S)"

# A simple background command, for the reason the source starter gives at length: with
# `( cd X && cmd ) &`, $! is a subshell and the stop script would orphan the worker.
#
# The identity block mirrors scripts/start-langflow-source.sh's, with its defaults: a
# worker runs the same startup as the API, superuser setup included, and refuses to
# start without credentials (measured on the lane's first live run: "Username and
# password must be set"). The API gets them inline from its starter, so a worker
# launched beside it inherits none of them.
cd "${STATE_DIR}"
LANGFLOW_AUTO_LOGIN=true \
LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-true}" \
LANGFLOW_BACKGROUND_BACKEND=scaled \
LANGFLOW_CONFIG_DIR="${STATE_DIR}/data" \
LANGFLOW_DATABASE_URL="${DATABASE_URL}" \
  ${WORKER_CMD} < /dev/null >> "${LOG_FILE}" 2>&1 &
WORKER_PID=$!
echo "${WORKER_PID}" > "${PID_FILE}"
echo "Starting a Langflow worker beside port ${PORT} (PID ${WORKER_PID}, logs: ${LOG_FILE})..."

# Whether a worker registered since the launch. SQLite only: that is the database every
# lane here uses. Any other URL is not checked, and the starter says so.
registered() {
  case "${DATABASE_URL}" in
    sqlite:///*) ;;
    *) return 2 ;;
  esac
  python3 - "${DATABASE_URL#sqlite:///}" "${LAUNCHED_AT}" <<'PY'
import sqlite3, sys
from datetime import datetime, timezone, timedelta
path, launched = sys.argv[1], datetime.fromisoformat(sys.argv[2]).replace(tzinfo=timezone.utc)
try:
    rows = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2).execute(
        "SELECT started_at FROM worker_registry"
    ).fetchall()
except sqlite3.Error:
    sys.exit(1)
for (started,) in rows:
    try:
        t = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
    except ValueError:
        continue
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    if t >= launched - timedelta(seconds=2):
        sys.exit(0)
sys.exit(1)
PY
}

ELAPSED=0
while [ "${ELAPSED}" -lt "${READY_TIMEOUT_S}" ]; do
  if ! kill -0 "${WORKER_PID}" 2>/dev/null; then
    echo "ERROR: the worker exited after ${ELAPSED}s without registering (PID ${WORKER_PID}). Last log lines:" >&2
    tail -n 20 "${LOG_FILE}" >&2 || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  rc=0
  registered || rc=$?
  if [ "${rc}" = "0" ]; then
    echo "Langflow worker ready after ${ELAPSED}s (PID ${WORKER_PID}, registered in worker_registry)."
    exit 0
  fi
  if [ "${rc}" = "2" ] && [ "${ELAPSED}" -ge 5 ]; then
    echo "NOTE: ${DATABASE_URL%%:*} database: the registration is not checked; the worker is alive after ${ELAPSED}s (PID ${WORKER_PID})."
    exit 0
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

echo "ERROR: the worker did not register in ${READY_TIMEOUT_S}s. Last log lines:" >&2
tail -n 20 "${LOG_FILE}" >&2 || true
kill "${WORKER_PID}" 2>/dev/null || true
sleep 2
kill -9 "${WORKER_PID}" 2>/dev/null || true
kill -0 "${WORKER_PID}" 2>/dev/null || rm -f "${PID_FILE}"
exit 1
