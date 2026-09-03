#!/usr/bin/env bash
# Start Ollama FROM A NATIVE BINARY, for the machines without containers.
#
# Third of the same trade as scripts/start-langflow-source.sh (#1658) and
# scripts/start-echo-source.sh (#1681): the QA VMs have no Docker and no Podman, so
# the `ollama-e2e:llama3.2-1b` service container that daily-stable.yml starts for
# ollama-provider.spec.ts has no substrate there.
#
# The container this replaces is OURS, not upstream's. docker/ollama-e2e/Dockerfile
# bakes the test model into `ollama/ollama:latest` so no lane pays a 1.3 GB pull from
# registry.ollama.ai mid-run (#583). Two consequences this script is built around:
#
#   - The pinned version is not a number anyone chose. It is whatever `latest` was
#     when build-ollama-image.yml last ran, and that image is rebuilt rarely — so the
#     pin here has to be derived from that date, not from the newest release. Bumping
#     one side alone reintroduces the exact difference the VM lane exists to measure.
#   - The model is part of the image, so on a native host it is part of THIS script's
#     job. ollama-provider.spec.ts SKIPS when the model is missing, with a reason —
#     and a lane one silent test short reads as a lane that passed.
#
# Unlike the echo, this one needs NO resolver. ollama-provider.spec.ts already reads
# OLLAMA_BASE_URL (where Playwright probes), OLLAMA_BASE_URL_FROM_LANGFLOW (how
# Langflow reaches the service) and OLLAMA_TEST_MODEL; only the DEFAULTS are
# container-shaped (`localhost`, `host.docker.internal`). The native topology is
# configuration, not new code, and this script's whole job is to make those three
# values true and to print the address it chose so the caller can set them.
#
# Usage:
#   ./scripts/start-ollama-source.sh                          # first RFC-1918 address, port 11434
#   OLLAMA_PORT=11435 ./scripts/start-ollama-source.sh        # a second instance, side by side
#   OLLAMA_BIND_HOST=10.0.0.4 ./scripts/start-ollama-source.sh    # pick the address yourself
#   OLLAMA_VERSION=0.32.5 ./scripts/start-ollama-source.sh    # the pin the CI image carries
#   ssh <host> 'bash -s' < scripts/start-ollama-source.sh     # how the VM lane starts it
set -euo pipefail

# Pinned to the version inside ghcr.io/<repo>/ollama-e2e:llama3.2-1b. That image was
# built from `ollama/ollama:latest`, and `latest` was 0.32.5 from its release on
# 2026-07-27 until 0.32.6 on 2026-08-19 — the image's own build sits inside that
# window. Rebuilding the image moves this pin; the unit test reads the model out of
# the Dockerfile for the same reason, so the two cannot drift silently.
VERSION="${OLLAMA_VERSION:-0.32.5}"
PORT="${OLLAMA_PORT:-11434}"
BIND_HOST="${OLLAMA_BIND_HOST:-}"
# Split from BIND_HOST for the reason the sibling starters record: one is what the
# server listens on, the other is what this script can reach. On this lane they are
# the same address, and probing loopback instead would prove the wrong half.
HEALTH_HOST="${OLLAMA_HEALTH_HOST:-}"
# Read out of docker/ollama-e2e/Dockerfile's ARG by the unit test. Changing the model
# means changing it there, in OLLAMA_TEST_MODEL, and here — the test is what makes
# forgetting one of the three fail loudly instead of skipping a spec.
MODEL="${OLLAMA_E2E_MODEL:-llama3.2:1b}"
STATE_ROOT="${OLLAMA_STATE_ROOT:-/tmp}"
STATE_DIR="${OLLAMA_STATE_DIR:-${STATE_ROOT}/ollama-source-${PORT}}"
# Version-suffixed on purpose, exactly as the echo starter's binary path is: a bump
# must produce a different prefix, or a machine that unpacked 0.32.5 once keeps
# serving it under the new pin's name forever. The prefix — not just the binary —
# because the tarball ships `bin/ollama` beside `lib/ollama/*`, and the binary finds
# its runners relative to itself.
PREFIX="${OLLAMA_PREFIX:-$HOME/.local/lib/ollama-${VERSION}}"
BIN="${OLLAMA_BIN:-${PREFIX}/bin/ollama}"
RELEASE_BASE="${OLLAMA_RELEASE_BASE:-https://github.com/ollama/ollama/releases/download/v${VERSION}}"
ASSET="${OLLAMA_ASSET:-ollama-linux-amd64.tar.zst}"
START_TIMEOUT_S="${OLLAMA_START_TIMEOUT_S:-60}"
POLL_INTERVAL_S="${OLLAMA_POLL_INTERVAL_S:-1}"
# A cold pull of the test model is ~1.3 GB. Separate from the readiness deadline
# because they fail for different reasons: one says the server never came up, the
# other says the network is slow — and reporting the second as the first sends the
# reader to the wrong machine.
PULL_TIMEOUT_S="${OLLAMA_PULL_TIMEOUT_S:-900}"
# Same variable the stop script reads, so the two cannot disagree about how long a
# graceful exit is allowed to take.
STOP_TIMEOUT_S="${OLLAMA_STOP_TIMEOUT_S:-10}"

# Two-step check rather than one `-lt`, for the reason start-langflow-source.sh
# documents: a non-numeric value makes `[ -lt ]` exit 2, which inside `if` is
# indistinguishable from "false", so the bad value would reach the readiness loop and
# produce a timeout message for a run that never probed anything.
require_positive_int() {
  # $1 = variable name, $2 = value, $3 = why a bad value matters here
  case "$2" in
    '' | *[!0-9]*) ;;
    *) if [ "$2" -ge 1 ]; then return 0; fi ;;
  esac
  echo "ERROR: $1 must be a positive integer (got '$2')." >&2
  echo "$3" >&2
  exit 2
}
require_positive_int OLLAMA_POLL_INTERVAL_S "${POLL_INTERVAL_S}" \
  "Zero never advances the deadline, so the wait below would never end."
require_positive_int OLLAMA_START_TIMEOUT_S "${START_TIMEOUT_S}" \
  "A non-numeric deadline makes the readiness loop skip every iteration, which reports a timeout for a run that never probed."
require_positive_int OLLAMA_PULL_TIMEOUT_S "${PULL_TIMEOUT_S}" \
  "The model pull would be cut off at once and the spec would skip for a missing model."
# The one that hides best, because nothing aborts. Both uses are `while` conditions,
# and a `while` is exempt from `set -e`: `[ -lt ]` exits 2, the loop reads that as
# false and never runs, and control falls straight through to the SIGKILL escalation.
# So a plausible misspelling — `30s`, the way `timeout` takes it — does not fail. It
# silently deletes the graceful window and kills a live server mid-write to its model
# store, while still reporting a clean stop.
require_positive_int OLLAMA_STOP_TIMEOUT_S "${STOP_TIMEOUT_S}" \
  "A bad value skips the graceful wait entirely and escalates straight to SIGKILL."

# --- The address Langflow has to be able to call --------------------------------
# Identical rule to the echo starter's, and for the same layer: Langflow validates the
# base URL of a local provider through its SSRF check, which blocks loopback outright
# and admits private ranges only through LANGFLOW_SSRF_ALLOWED_HOSTS — the variable
# every lane and both start scripts carry as `172.16.0.0/12,10.0.0.0/8,192.168.0.0/16`.
# In the container topology this address is the service name `ollama`; natively it has
# to be an RFC-1918 address, or Langflow refuses the call that the spec is about.
is_rfc1918() {
  case "$1" in
    10.*) return 0 ;;
    192.168.*) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

discover_addresses() {
  # `ip` on Linux, `ifconfig` as the fallback so this can be exercised on a
  # developer's machine. Neither is asked to filter: the selection below is the only
  # place that decides.
  if command -v ip > /dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif command -v ifconfig > /dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}'
  fi
}

if [ -z "${BIND_HOST}" ]; then
  # Asked BEFORE the discovery: with neither tool present the discovery prints
  # nothing, and "this machine has no private address" and "I could not look" become
  # the same empty string. Only the second is true, and it sends the reader to PATH
  # rather than to the network.
  if ! command -v ip > /dev/null 2>&1 && ! command -v ifconfig > /dev/null 2>&1; then
    echo "ERROR: cannot enumerate this machine's addresses — neither \`ip\` nor \`ifconfig\` is on PATH." >&2
    echo "This is NOT the same as having no RFC-1918 address." >&2
    echo "Pass the address explicitly with OLLAMA_BIND_HOST." >&2
    exit 2
  fi
  ADDRESSES="$(discover_addresses || true)"
  for addr in ${ADDRESSES}; do
    if is_rfc1918 "${addr}"; then BIND_HOST="${addr}"; break; fi
  done
  if [ -z "${BIND_HOST}" ]; then
    echo "ERROR: no RFC-1918 address on this machine to bind Ollama to." >&2
    echo "Addresses found: ${ADDRESSES:-none}" >&2
    echo "Langflow blocks loopback outright and admits private ranges only through" >&2
    echo "LANGFLOW_SSRF_ALLOWED_HOSTS, so a public address would make every call the" >&2
    echo "provider spec asserts on fail as a refusal that reads like a product bug." >&2
    echo "Pass one explicitly with OLLAMA_BIND_HOST if this machine's topology differs." >&2
    exit 2
  fi
fi

case "${BIND_HOST}" in
  127.* | localhost | ::1)
    echo "ERROR: refusing to bind Ollama to loopback (${BIND_HOST})." >&2
    echo "Langflow's SSRF layer blocks loopback unconditionally — it ignores" >&2
    echo "LANGFLOW_SSRF_ALLOWED_HOSTS for those addresses — so the provider call the" >&2
    echo "spec makes would be refused before it left Langflow." >&2
    exit 2
    ;;
esac

if ! is_rfc1918 "${BIND_HOST}"; then
  echo "ERROR: ${BIND_HOST} is not an RFC-1918 address." >&2
  echo "LANGFLOW_SSRF_ALLOWED_HOSTS admits the private ranges only, so Langflow would" >&2
  echo "refuse to call this endpoint and the failure would read as a product bug." >&2
  exit 2
fi

HEALTH_HOST="${HEALTH_HOST:-${BIND_HOST}}"

# Every client invocation below has to talk to OUR server, not to whatever a stray
# OLLAMA_HOST in the environment points at — `ollama pull` against someone else's
# instance would report success and leave this one without the model.
export OLLAMA_HOST="${BIND_HOST}:${PORT}"

# --- Refuse to start on top of something already running ------------------------
# The PID file catches an instance this script started and nobody stopped; the probe
# catches everything else. Without the probe a failed bind is invisible: the readiness
# loop would be answered by the OTHER server and report ready at once.
PID_FILE="${STATE_DIR}/ollama.pid"
LOG_FILE="${STATE_DIR}/ollama.log"
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "ERROR: an Ollama started by this script is still running on port ${PORT} (PID $(cat "${PID_FILE}"))." >&2
  echo "Stop it first: OLLAMA_PORT=${PORT} ./scripts/stop-ollama-source.sh" >&2
  exit 2
fi
# `--max-time` for the reason the readiness poll carries one: a filtered port does not
# refuse, it hangs, and curl's default connect timeout is ~300s — spent here, before
# the script has done anything at all.
if curl -sf --max-time 5 "http://${HEALTH_HOST}:${PORT}/api/tags" > /dev/null 2>&1; then
  echo "ERROR: something already answers /api/tags on ${HEALTH_HOST}:${PORT}." >&2
  echo "Refusing to start: this script cannot tell that server from the one it would" >&2
  echo "launch, so a failed bind would be reported as a healthy start and the spec would" >&2
  echo "run against it — including its model list. Free the port, or pick another with" >&2
  echo "OLLAMA_PORT." >&2
  exit 2
fi

# --- Provision the pinned build -------------------------------------------------
# The binary is asked its own version rather than trusted by path. `ollama --version`
# prints `... version is <v>` and exits 0 even with no server running (it warns about
# that on its own line), so the parse takes the version line and its last field.
binary_version() {
  "$1" --version 2>&1 | awk '/version is/ {print $NF; exit}'
}

# Read in two steps, never as `$(binary_version ... || echo unknown)`. That shape
# APPENDS instead of replacing: this is a pipeline under `set -o pipefail`, and awk's
# `exit` closes the pipe under the writer, so the substitution can capture a perfectly
# good version AND the fallback — `0.32.5` followed by `unknown` — which then compares
# unequal to the pin and makes the script refuse the binary it just read correctly.
# Emptiness, not exit status, is what "could not read it" actually looks like here.
read_binary_version() {
  version_output="$(binary_version "$1" || true)"
  [ -n "${version_output}" ] || version_output=unknown
  printf '%s\n' "${version_output}"
}

if [ -x "${BIN}" ]; then
  HAVE="$(read_binary_version "${BIN}")"
  if [ "${HAVE}" != "${VERSION}" ]; then
    echo "ERROR: ${BIN} reports version '${HAVE}', not the pinned ${VERSION}." >&2
    echo "Refusing to run it: the pin exists so this server behaves exactly like the" >&2
    echo "image the CI lane starts, and a different build is the one difference this" >&2
    echo "lane cannot tell from a product change. Delete the prefix to re-download." >&2
    exit 2
  fi
else
  if [ "${OLLAMA_DOWNLOAD:-1}" != "1" ]; then
    echo "ERROR: no binary at ${BIN}, and OLLAMA_DOWNLOAD is not 1." >&2
    echo "Provision it yourself, or set OLLAMA_BIN to one that exists." >&2
    exit 2
  fi
  # The asset is zstd-compressed, which `tar` cannot open on its own: without the
  # zstd binary it fails with a message about the compression program, and the reader
  # goes looking at the download. Named here instead.
  if ! command -v zstd > /dev/null 2>&1; then
    echo "ERROR: zstd is not on PATH, and ${ASSET} cannot be unpacked without it." >&2
    echo "Install it (Ubuntu: apt-get install zstd) — this is not a download failure." >&2
    exit 2
  fi
  echo "Downloading Ollama ${VERSION} (${ASSET})..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  if ! curl -fsSL -o "${TMP_DIR}/${ASSET}" "${RELEASE_BASE}/${ASSET}"; then
    echo "ERROR: could not download ${RELEASE_BASE}/${ASSET}" >&2
    echo "This machine needs egress to github.com for the pinned release." >&2
    exit 2
  fi
  if ! curl -fsSL -o "${TMP_DIR}/sha256sum.txt" "${RELEASE_BASE}/sha256sum.txt"; then
    echo "ERROR: could not download ${RELEASE_BASE}/sha256sum.txt" >&2
    echo "Refusing to install an unverified binary." >&2
    exit 2
  fi
  # Matched on the WHOLE second field, never with grep — the echo starter's lesson,
  # with a twist this release adds: ollama writes its entries as `./<asset>`, so the
  # match has to accept both spellings and still refuse a substring. A grep for the
  # asset name here would also match `ollama-linux-amd64-rocm.tar.zst`, a 1 GB file
  # with a different checksum, and the verification would fail for a reason that has
  # nothing to do with the download.
  EXPECTED="$(awk -v a="${ASSET}" '$2 == a || $2 == "./" a {print $1; exit}' "${TMP_DIR}/sha256sum.txt")"
  if [ -z "${EXPECTED}" ]; then
    echo "ERROR: ${ASSET} has no entry in the release's sha256sum.txt." >&2
    exit 2
  fi
  # sha256sum on the VMs; shasum on a developer's macOS, where the first does not
  # exist. Without the fallback the verification is the one part of this script that
  # cannot be exercised outside the target machine.
  if command -v sha256sum > /dev/null 2>&1; then
    ACTUAL="$(sha256sum "${TMP_DIR}/${ASSET}" | awk '{print $1}')"
  elif command -v shasum > /dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{print $1}')"
  else
    echo "ERROR: neither sha256sum nor shasum is available to verify the download." >&2
    echo "Refusing to install an unverified binary." >&2
    exit 2
  fi
  if [ "${ACTUAL}" != "${EXPECTED}" ]; then
    echo "ERROR: checksum mismatch for ${ASSET}." >&2
    echo "  expected ${EXPECTED}" >&2
    echo "  actual   ${ACTUAL}" >&2
    exit 2
  fi
  mkdir -p "${TMP_DIR}/unpack"
  tar --zstd -xf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}/unpack"
  if [ ! -f "${TMP_DIR}/unpack/bin/ollama" ]; then
    echo "ERROR: ${ASSET} did not contain bin/ollama." >&2
    exit 2
  fi
  # Moved into place as a whole only after the checksum passed, so an interrupted
  # download never leaves a half-unpacked prefix under the pinned name for the next
  # run to trust. `lib/` travels with it: the binary loads its runners from there.
  rm -rf "${PREFIX}"
  mkdir -p "$(dirname "${PREFIX}")"
  mv "${TMP_DIR}/unpack" "${PREFIX}"
  chmod +x "${BIN}"
  HAVE="$(read_binary_version "${BIN}")"
  if [ "${HAVE}" != "${VERSION}" ]; then
    echo "ERROR: the downloaded binary reports version '${HAVE}', not ${VERSION}." >&2
    rm -rf "${PREFIX}"
    exit 2
  fi
  echo "Installed ${BIN} (verified ${VERSION})"
fi

mkdir -p "${STATE_DIR}"
STATE_DIR="$(cd "${STATE_DIR}" && pwd)"
PID_FILE="${STATE_DIR}/ollama.pid"
LOG_FILE="${STATE_DIR}/ollama.log"
# Truncated, not appended: the failure path tails this file, so an inherited log makes
# one start attempt report the previous one's error as its own cause.
: > "${LOG_FILE}"

echo "Starting Ollama ${VERSION} on ${BIND_HOST}:${PORT} (logs: ${LOG_FILE})..."
# Backgrounded as a SIMPLE command, for the reason start-langflow-source.sh records at
# length: with `( ... ) &` the PID is the subshell's, so the stop script kills the
# wrapper and the server survives as an orphan holding the port.
"${BIN}" serve < /dev/null >> "${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > "${PID_FILE}"

# Shared by both failure paths below. Confirms the process is GONE before dropping the
# PID file: `kill` returning 0 only means the signal was delivered, and removing the
# file while the process lives discards the only reliable handle to stop it — the next
# start's probe cannot see a port that is bound but not answering.
stop_launched_server() {
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
}

echo "Waiting for Ollama to answer (up to ${START_TIMEOUT_S}s)..."
# Wall clock, not a poll counter. Each iteration costs the probe's `--max-time 5` PLUS
# the sleep, and the probe only reaches that ceiling in the case it was added for — a
# port that is filtered rather than closed, which hangs instead of refusing. Counting
# iterations there advertises "up to 60s" and waits six minutes, then reports a 60s
# timeout. `SECONDS` is a bash builtin and resets on assignment.
SECONDS=0
READY_AFTER=0
READY=0
while [ "${SECONDS}" -lt "${START_TIMEOUT_S}" ]; do
  # Liveness first, same as the sibling starters: a process that exited is not slow,
  # and waiting out the deadline to say so misnames a failed bind as a busy machine.
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "ERROR: Ollama exited after ${SECONDS}s without answering (PID ${SERVER_PID}). Last log lines:" >&2
    tail -n 20 "${LOG_FILE}" >&2 || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  # Probed at the address LANGFLOW will call, not at loopback: the half that fails
  # when a bind lands on the wrong interface is exactly the half loopback cannot see.
  if curl -sf --max-time 5 "http://${HEALTH_HOST}:${PORT}/api/tags" > /dev/null 2>&1; then
    READY=1
    READY_AFTER="${SECONDS}"
    break
  fi
  sleep "${POLL_INTERVAL_S}"
done

if [ "${READY}" != "1" ]; then
  echo "ERROR: Ollama did not answer in ${START_TIMEOUT_S}s. Last log lines:" >&2
  tail -n 20 "${LOG_FILE}" >&2 || true
  stop_launched_server
  exit 1
fi

# --- The model the spec needs ---------------------------------------------------
# A server with no model is the dangerous state, not an obvious one: the spec's
# reachability probe passes, and it then SKIPS with a reason nobody reads on a green
# lane. In the container topology the weights are baked in; natively they are this
# script's responsibility, and "ready" has to mean the model is there.
model_present() {
  "${BIN}" list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -Fxq "${MODEL}"
}

if ! model_present; then
  if [ "${OLLAMA_PULL:-1}" != "1" ]; then
    echo "ERROR: model ${MODEL} is not on this instance and OLLAMA_PULL is not 1." >&2
    stop_launched_server
    exit 1
  fi
  echo "Pulling ${MODEL} (first run on this machine; up to ${PULL_TIMEOUT_S}s)..."
  PULL_STARTED_AT="${SECONDS}"
  # `timeout` when it exists — a pull that stalls on a dropped link would otherwise
  # hold the whole lane. Absent (macOS), the pull runs unbounded rather than being
  # skipped: a missing coreutils is not a reason to start a server the spec will skip.
  if command -v timeout > /dev/null 2>&1; then
    PULL_CMD_STATUS=0
    timeout "${PULL_TIMEOUT_S}" "${BIN}" pull "${MODEL}" || PULL_CMD_STATUS=$?
  else
    PULL_CMD_STATUS=0
    "${BIN}" pull "${MODEL}" || PULL_CMD_STATUS=$?
  fi
  if [ "${PULL_CMD_STATUS}" -ne 0 ]; then
    echo "ERROR: pulling ${MODEL} failed (status ${PULL_CMD_STATUS})." >&2
    echo "This machine needs egress to registry.ollama.ai for the first pull." >&2
    stop_launched_server
    exit 1
  fi
  # Asked again rather than inferred from the exit status: `ollama pull` can report
  # success for a name the server then lists differently, and the spec matches the
  # name exactly.
  if ! model_present; then
    echo "ERROR: ${MODEL} is still not listed after a successful pull." >&2
    echo "Models present: $("${BIN}" list 2>/dev/null | awk 'NR > 1 {print $1}' | tr '\n' ' ')" >&2
    stop_launched_server
    exit 1
  fi
fi

# Readiness and the pull are reported separately because they are different waits and
# only one of them is the server's. Folding a 15-minute cold pull into "ready after"
# would print a 2s start for a run that took a quarter of an hour.
if [ -n "${PULL_STARTED_AT:-}" ]; then
  echo "Ollama ready after ${READY_AFTER}s, plus $((SECONDS - PULL_STARTED_AT))s pulling ${MODEL} (PID: ${SERVER_PID}, port ${PORT})"
else
  echo "Ollama ready after ${READY_AFTER}s (PID: ${SERVER_PID}, port ${PORT}, model ${MODEL})"
fi
# Machine-readable, for `ssh <host> 'bash -s' < this` to capture. The caller turns
# these into OLLAMA_BASE_URL / OLLAMA_BASE_URL_FROM_LANGFLOW / OLLAMA_TEST_MODEL —
# the three the spec already reads, which is why this needs no resolver of its own.
echo "OLLAMA_HOST_IP=${BIND_HOST}"
echo "OLLAMA_PORT=${PORT}"
echo "OLLAMA_MODEL=${MODEL}"
exit 0
