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
# the whole point of running both lanes side by side is lost. That parity is asserted
# against start-langflow-pip.sh itself in start-langflow-source.test.mjs, not against
# a hardcoded copy of it, so a variable added there cannot go missing here silently.
#
# Four things this script does that its siblings do not:
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
#      a ref is opt-in through LANGFLOW_SRC_REF, and it is the caller's decision. The
#      frontend build is refused for the same reason rather than run automatically —
#      it writes into the clone (npm modules, then the served asset directory).
#   3. It never names a machine. The bind address, the port and the repository path
#      are all parameters, which is what allows this file to live in a public
#      repository while the topology that fills them in lives on the destination's
#      wiki.
#   4. It refuses to report a readiness it has not established. Three checks stand
#      between "started" and "ready", and each of them exists because its absence
#      produces a GREEN run against the wrong instance — the worst outcome available
#      to a scheduled lane, and one no spec can detect from the inside:
#        - the port must be free BEFORE launch. /health_check answers from whatever
#          holds the port, so a bind failure against a leftover instance otherwise
#          reads as an instant, healthy start.
#        - the process must still be alive on every poll. A backend that died on
#          startup is not slow, and waiting out the deadline mis-reports it as one.
#        - the frontend assets must exist. They are gitignored upstream, so a fresh
#          clone has none, and the backend still answers /health_check 200 while
#          serving no UI at all — every Playwright spec then dies at page load.
#
# Usage:
#   ./scripts/start-langflow-source.sh                      # clone at $LANGFLOW_SRC_REPO, port 7860
#   LANGFLOW_PORT=7861 ./scripts/start-langflow-source.sh   # a second instance, side by side
#   LANGFLOW_SRC_REF=v1.12.0 ./scripts/start-langflow-source.sh   # opt in to moving the clone
#   LANGFLOW_SRC_REPO=/srv/langflow ./scripts/start-langflow-source.sh
#   LANGFLOW_BIND_HOST=0.0.0.0 ./scripts/start-langflow-source.sh # opt in to a reachable bind
#   LANGFLOW_SRC_KEEP_STATE=1 ./scripts/start-langflow-source.sh  # keep the previous run's database and log
set -euo pipefail

REPO="${LANGFLOW_SRC_REPO:-$HOME/langflow-project/langflow}"
PORT="${LANGFLOW_PORT:-7860}"
# Loopback by default, unlike the pip starter's 0.0.0.0. That script targets a
# developer's own box; this one targets a SHARED VM, where the same flags publish an
# auto-login instance with a known superuser to everything that can route there.
# A lane driving the browser from the same machine needs nothing more than loopback.
BIND_HOST="${LANGFLOW_BIND_HOST:-127.0.0.1}"
# Where the health check looks. Split from BIND_HOST because the two answer
# different questions: what the server listens on, and what this script can reach.
HEALTH_HOST="${LANGFLOW_HEALTH_HOST:-localhost}"
# Split into root + leaf so the leaf can be asserted to carry the port. The whole
# path stays overridable; what must not be overridable-by-accident is the fact that
# two ports get two directories.
STATE_ROOT="${LANGFLOW_SRC_STATE_ROOT:-/tmp}"
STATE_DIR="${LANGFLOW_SRC_STATE_DIR:-${STATE_ROOT}/langflow-source-${PORT}}"
PID_FILE="${STATE_DIR}/langflow.pid"
LOG_FILE="${STATE_DIR}/langflow.log"
# The directory the backend serves the UI from. Overridable because a gate keyed on
# an upstream path is a gate that goes stale — but stale here means a loud refusal
# on a good clone, never a silent pass on a broken one.
FRONTEND_DIR="${LANGFLOW_SRC_FRONTEND_DIR:-${REPO}/src/backend/base/langflow/frontend}"
# Source starts are far slower than pip's 120 s: the first dependency sync on a cold
# cache compiles wheels. A deadline shorter than that reads as "Langflow is broken"
# when the truth is "the machine is still building".
START_TIMEOUT_S="${LANGFLOW_START_TIMEOUT_S:-300}"
# Kept a variable so the unit tests can exercise the timeout branch without sitting
# through it; five seconds is the interval every sibling script polls at.
POLL_INTERVAL_S="${LANGFLOW_POLL_INTERVAL_S:-5}"
KEEP_STATE="${LANGFLOW_SRC_KEEP_STATE:-0}"
# How long a graceful exit may take on the failure path below. Same variable the
# stop script reads, so the two cannot disagree about what "gave it a chance" means.
STOP_TIMEOUT_S="${LANGFLOW_STOP_TIMEOUT_S:-15}"

# Checked in two steps rather than one `-lt`: a non-numeric value makes `[ -lt ]`
# return 2, which inside `if` is indistinguishable from "false", so the bad value
# would flow through to `sleep` and abort with bash's message instead of this one.
poll_interval_invalid() {
  echo "ERROR: LANGFLOW_POLL_INTERVAL_S must be a positive integer (got '${POLL_INTERVAL_S}')." >&2
  echo "Zero never advances the deadline, so the wait below would never end." >&2
  exit 2
}
case "${POLL_INTERVAL_S}" in
  '' | *[!0-9]*) poll_interval_invalid ;;
esac
if [ "${POLL_INTERVAL_S}" -lt 1 ]; then poll_interval_invalid; fi

if [ ! -d "${REPO}" ]; then
  echo "ERROR: Langflow source clone not found at ${REPO}" >&2
  echo "Clone langflow-ai/langflow there, or set LANGFLOW_SRC_REPO." >&2
  exit 2
fi

# --- Refuse to start on top of something already running ------------------------
# Both halves matter, and they catch different instances. The PID file catches one
# this script started and nobody stopped; the health probe catches everything else —
# another user's process, a shard pointed at the wrong port, or the orphan of a stop
# that failed. Without the second, a failed bind is invisible: the health loop below
# would be answered by the OTHER instance and report READY within a second, and the
# lane would run against the previous build and its database, green.
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "ERROR: an instance started by this script is still running on port ${PORT} (PID $(cat "${PID_FILE}"))." >&2
  echo "Stop it first: LANGFLOW_PORT=${PORT} ./scripts/stop-langflow-source.sh" >&2
  exit 2
fi
if curl -sf "http://${HEALTH_HOST}:${PORT}/health_check" > /dev/null 2>&1; then
  echo "ERROR: something already answers /health_check on ${HEALTH_HOST}:${PORT}." >&2
  echo "Refusing to start: this script cannot tell that instance from the one it would" >&2
  echo "launch, so a failed bind would be reported as a healthy start and the run would" >&2
  echo "silently exercise the wrong build. Free the port, or pick another with LANGFLOW_PORT." >&2
  exit 2
fi

# Opt-in, and never a silent one: moving a shared clone is announced.
if [ -n "${LANGFLOW_SRC_REF:-}" ]; then
  echo "Checking out ${LANGFLOW_SRC_REF} in ${REPO}..."
  git -C "${REPO}" checkout --quiet "${LANGFLOW_SRC_REF}"
  echo "NOTE: the frontend assets are NOT rebuilt by this script. If ${LANGFLOW_SRC_REF}"
  echo "      changes the UI, rebuild them (see the frontend check below) or the run"
  echo "      exercises the previous build's interface against the new backend."
fi

SRC_SHA="$(git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Langflow source: ${REPO} @ ${SRC_SHA}"

# uv is Langflow's own toolchain and the ONLY one that can build this clone: the root
# package's dependencies (langflow-base, lfx and every lfx-* bundle) resolve through
# [tool.uv.sources] workspace = true, which no other installer reads. `pip install -e`
# on the repo root does not fail loudly — it goes to PyPI for those names and installs
# PUBLISHED versions beside a local shell, which is precisely the "published artifact
# rather than the clone under test" this script exists to avoid. So there is no pip
# fallback; a machine without uv is asked for one, or for its own commands.
if [ -n "${LANGFLOW_SRC_RUN_CMD:-}" ]; then
  # An empty (but set) LANGFLOW_SRC_SYNC_CMD means "skip the sync", which is why this
  # uses ${VAR-default} and not ${VAR:-default}: with the latter there is no way to
  # ask for no sync at all.
  SYNC_CMD="${LANGFLOW_SRC_SYNC_CMD-}"
  RUN_CMD="${LANGFLOW_SRC_RUN_CMD}"
elif command -v uv > /dev/null 2>&1; then
  # --frozen keeps the lockfile as committed. Without it a sync may rewrite
  # uv.lock in the clone, which is the same silent mutation point 2 above refuses.
  SYNC_CMD="${LANGFLOW_SRC_SYNC_CMD-uv sync --frozen}"
  RUN_CMD="uv run langflow run"
else
  echo "ERROR: uv is not installed, and it is what builds this clone." >&2
  echo "Install it without a system package repository:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "Or supply the commands yourself: LANGFLOW_SRC_SYNC_CMD and LANGFLOW_SRC_RUN_CMD." >&2
  exit 2
fi

mkdir -p "${STATE_DIR}"
# Absolute from here on: the launch below changes this script's own working directory
# to the clone, and every path it still writes (PID file, log, database, config dir)
# has to survive that.
REPO="$(cd "${REPO}" && pwd)"
STATE_DIR="$(cd "${STATE_DIR}" && pwd)"
PID_FILE="${STATE_DIR}/langflow.pid"
LOG_FILE="${STATE_DIR}/langflow.log"
if [ "${KEEP_STATE}" != "1" ]; then
  # A run inherits no flows, no users and no credentials from the last one. On a
  # long-lived VM that is not hygiene theatre: leftover state is exactly how a
  # green run stops proving anything, because the flow it needed was already there.
  rm -rf "${STATE_DIR}/data"
  # The log is truncated for the same reason, and it is not cosmetic: the failure
  # path below tails this file, so an appended log makes a start attempt inherit the
  # previous one's error and mis-name its own cause.
  : > "${LOG_FILE}"
fi
mkdir -p "${STATE_DIR}/data"

if [ -n "${SYNC_CMD}" ]; then
  echo "Syncing dependencies (${SYNC_CMD})..."
  ( cd "${REPO}" && eval "${SYNC_CMD}" )
fi

# --- The UI has to exist before a browser lane is worth starting ----------------
# src/backend/base/langflow/frontend/ is in upstream's .gitignore and holds zero
# tracked files: it is produced by `make build_frontend`, never by a clone and never
# by a dependency sync. Without it the backend still answers /health_check with 200
# while serving no interface, so the start looks perfect and every spec dies at page
# load. Refused rather than built, because building writes into a clone this script
# has promised not to touch (npm install into src/frontend, then a copy into the
# served directory) — the caller opts in by running the command themselves, once.
if [ ! -f "${FRONTEND_DIR}/index.html" ]; then
  echo "ERROR: no frontend build at ${FRONTEND_DIR}" >&2
  echo "The backend would still answer /health_check, and every browser spec would fail" >&2
  echo "at page load against a server with no UI. Build it once in the clone:" >&2
  echo "  make -C ${REPO} install_frontend build_frontend" >&2
  echo "(Override the location with LANGFLOW_SRC_FRONTEND_DIR if upstream moves it.)" >&2
  exit 2
fi

echo "Starting Langflow on ${BIND_HOST}:${PORT} (logs: ${LOG_FILE})..."
# The flags below carry the same reasoning as scripts/start-langflow-pip.sh — read
# that file's comments for the why of each. Repeated here rather than sourced because
# a starter that hides its environment behind an include is a starter nobody audits.
#   LANGFLOW_DEACTIVATE_TRACING  local spend is out of scope for token history (#1300, #1183)
#   LANGFLOW_A2A_ENABLED         product default is OFF, and a disabled server passes every A2A spec while testing nothing (#1240, #1195)
#   LANGFLOW_SSRF_ALLOWED_HOSTS  private ranges only, loopback deliberately OUT (security/ssrf-url-validation.spec.ts asserts the refusal)
#   --workers 1                  Langflow defaults to (2*cpu)+1, each holding full in-memory state (#773) — and on this lane N shards multiply it
#
# Launched as a SIMPLE background command — `cd` here, no subshell — and that shape is
# load-bearing twice over.
#   With `( cd X && cmd ) &`, $! is the SUBSHELL's PID. The stop script then kills the
#   wrapper and the server survives as an orphan: the stop reports success, the port
#   stays bound, and the next start collides with an instance nothing knows about.
#   Wrapping the command in `exec` looks like the fix and is not — measured on bash
#   3.2, `( cd X && VAR=1 exec cmd >>log 2>&1 ) &` still forks. The surviving subshell
#   holds the CALLER's stderr, so besides the orphan it wedges every caller that
#   captures output: a CI `run:` step, or anything reading the pipe, blocks until
#   Langflow itself exits.
# Backgrounding a simple command makes $! the process, with no fd left behind.
# (`uv run` forwards SIGTERM to the langflow process it spawns — verified — so the one
# signal the stop script sends reaches the server.)
cd "${REPO}"
LANGFLOW_AUTO_LOGIN=true \
LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
LANGFLOW_DEACTIVATE_TRACING=true \
LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16}" \
LANGFLOW_CONFIG_DIR="${STATE_DIR}/data" \
LANGFLOW_DATABASE_URL="${LANGFLOW_DATABASE_URL:-sqlite:///${STATE_DIR}/data/langflow.db}" \
  ${RUN_CMD} --host "${BIND_HOST}" --port "${PORT}" --no-open-browser \
  --workers "${LANGFLOW_WORKERS:-1}" < /dev/null >> "${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > "${PID_FILE}"

echo "Waiting for Langflow to be ready (up to ${START_TIMEOUT_S}s)..."
ELAPSED=0
while [ "${ELAPSED}" -lt "${START_TIMEOUT_S}" ]; do
  # Liveness first. A process that exited is not slow, and waiting out a five-minute
  # deadline to say so turns "it crashed on startup" into "the machine is busy" —
  # the misattribution the long deadline was widened for in the first place.
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "ERROR: Langflow exited after ${ELAPSED}s without answering (PID ${SERVER_PID}). Last log lines:" >&2
    tail -n 20 "${LOG_FILE}" >&2 || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  if curl -sf "http://${HEALTH_HOST}:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after ${ELAPSED}s (PID: ${SERVER_PID}, port ${PORT})"
    exit 0
  fi
  sleep "${POLL_INTERVAL_S}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_S))
  echo "  Waiting... (${ELAPSED}s)"
done

echo "ERROR: Langflow did not become ready in ${START_TIMEOUT_S}s. Last log lines:" >&2
tail -n 20 "${LOG_FILE}" >&2 || true
# Confirm the process is gone before dropping the PID file. `kill` returning 0 only
# means the signal was DELIVERED: if it is ignored, or the process is wedged, removing
# the file discards the only reliable handle to stop it — and the next start's probe
# cannot see a port that is BOUND but not answering, which is exactly the state this
# timeout was reached in. So the collision would come back as a failed bind on every
# later run, against an orphan nothing can name. The stop script already reasons this
# way; a starter that contradicts its own stopper is worse than either rule alone.
kill "${SERVER_PID}" 2>/dev/null || true
WAITED=0
while [ "${WAITED}" -lt "${STOP_TIMEOUT_S}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; do
  sleep 1
  WAITED=$((WAITED + 1))
done
if kill -0 "${SERVER_PID}" 2>/dev/null; then
  echo "PID ${SERVER_PID} ignored SIGTERM after ${STOP_TIMEOUT_S}s; sending SIGKILL." >&2
  kill -9 "${SERVER_PID}" 2>/dev/null || true
  sleep 1
fi
if kill -0 "${SERVER_PID}" 2>/dev/null; then
  echo "ERROR: PID ${SERVER_PID} survived SIGKILL; port ${PORT} may still be bound." >&2
  echo "Leaving ${PID_FILE} in place so the next start refuses instead of colliding." >&2
else
  rm -f "${PID_FILE}"
fi
exit 1
