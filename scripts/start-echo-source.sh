#!/usr/bin/env bash
# Start the echo endpoint FROM A NATIVE BINARY, for the machines without containers.
#
# Sibling of scripts/start-langflow-source.sh (#1658) and the same trade: the QA VMs
# have no Docker and no Podman (the `universe` repository is blocked by policy), so
# the `ghcr.io/mccutchen/go-httpbin` service container that every CI lane starts
# (#462/#639, extended to four lanes in #1128) has no substrate there.
#
# It runs the SAME BINARY that image ships, at the SAME PINNED VERSION, downloaded
# from the project's releases. That is the whole design, and it is not laziness:
# every echo-dependent spec is written against go-httpbin's exact behaviour, and the
# ones that would catch a reimplementation are the ones nobody would think to check —
# a wrong verb answers 405 (httpbin) and not 404 (postman-echo); `/get` reports
# headers with Go's canonical casing and ARRAY values, which the assertions branch on;
# `/json` serves the byte-identical "Sample Slide Show" fixture a deterministic title
# assertion recites. A hand-written echo passes the obvious probes and then produces
# divergences that read as product failures on the very lane that exists to compare
# the two environments.
#
# Three things this script does that its Langflow sibling does not:
#
#   1. It provisions the binary, and refuses a version it cannot vouch for. The
#      tarball is checked against the release's `checksums.txt`, and the resulting
#      binary is asked its own `-version` before it is used. Both matter: a partial
#      download is a plausible failure on a VM whose network drops, and a binary that
#      predates a pin bump would otherwise be reused forever — the file name is
#      version-suffixed so the two can never be confused.
#   2. It refuses to bind an address Langflow cannot call. The point of this endpoint
#      is the SSRF layer: Langflow blocks loopback outright and blocks private ranges
#      unless LANGFLOW_SSRF_ALLOWED_HOSTS admits them, so the admitted case is only
#      non-vacuous against an RFC-1918 address. Binding loopback would make every
#      echo spec fail; binding a PUBLIC interface is worse, because the SSRF spec
#      would SKIP (see tests/helpers/other/private-echo-endpoint.ts) and a lane short
#      one silent test looks exactly like a lane that passed.
#   3. It prints the address it chose, on its own line and machine-readably. The
#      caller does not have to know the topology, and the DECISION about what
#      ECHO_BASE_URL becomes stays in scripts/resolve-echo-endpoint.mjs, which is
#      unit-tested — this script discovers, that one decides. That split is why this
#      file needs no node: it runs over `ssh <host> 'bash -s'` on a machine that may
#      have none, exactly as the Langflow starter does.
#
# Usage:
#   ./scripts/start-echo-source.sh                       # first RFC-1918 address, port 8080
#   ECHO_PORT=8081 ./scripts/start-echo-source.sh        # a second endpoint, side by side
#   ECHO_BIND_HOST=10.0.0.4 ./scripts/start-echo-source.sh   # pick the address yourself
#   ECHO_VERSION=2.23.1 ./scripts/start-echo-source.sh   # the pin every CI lane uses
#   ssh <host> 'bash -s' < scripts/start-echo-source.sh  # how the VM lane starts it
set -euo pipefail

# Pinned to the tag the four CI lanes run (`ghcr.io/mccutchen/go-httpbin:2.23.1`).
# Bumping it here without bumping them there reintroduces the difference this whole
# lane exists to measure, so the two move together.
VERSION="${ECHO_VERSION:-2.23.1}"
PORT="${ECHO_PORT:-8080}"
BIND_HOST="${ECHO_BIND_HOST:-}"
# Where the health probe looks. Split from BIND_HOST for the same reason the Langflow
# starter splits it: one is what the server listens on, the other is what this script
# can reach. Defaults to the bind address, because on this lane they are the same and
# probing loopback would prove the wrong thing — see the readiness note below.
HEALTH_HOST="${ECHO_HEALTH_HOST:-}"
STATE_ROOT="${ECHO_STATE_ROOT:-/tmp}"
STATE_DIR="${ECHO_STATE_DIR:-${STATE_ROOT}/echo-source-${PORT}}"
PID_FILE="${STATE_DIR}/echo.pid"
LOG_FILE="${STATE_DIR}/echo.log"
# Version-suffixed on purpose: a bump must produce a different path, or a machine that
# downloaded 2.23.1 once keeps serving it under the new pin's name forever.
BIN_DIR="${ECHO_BIN_DIR:-$HOME/.local/bin}"
BIN="${ECHO_BIN:-${BIN_DIR}/go-httpbin-${VERSION}}"
RELEASE_BASE="${ECHO_RELEASE_BASE:-https://github.com/mccutchen/go-httpbin/releases/download/v${VERSION}}"
ASSET="${ECHO_ASSET:-go-httpbin-linux-amd64.tar.gz}"
START_TIMEOUT_S="${ECHO_START_TIMEOUT_S:-30}"
POLL_INTERVAL_S="${ECHO_POLL_INTERVAL_S:-1}"
# go-httpbin's own default, restated because /delay/5 sits under it and a spec asserts
# that route. Lowering it below 5s turns that spec red for a reason no one will find.
MAX_DURATION="${ECHO_MAX_DURATION:-10s}"
# How long a graceful exit may take on the failure path below. Same variable the
# stop script reads, so the two cannot disagree about what "gave it a chance" means.
STOP_TIMEOUT_S="${ECHO_STOP_TIMEOUT_S:-10}"

# Checked in two steps rather than one `-lt`, for the reason the Langflow starter
# documents: a non-numeric value makes `[ -lt ]` exit 2, which inside `if` is
# indistinguishable from "false", so the bad value would reach `sleep` and abort with
# bash's message instead of this one.
#
# BOTH numbers go through it, and the deadline is the one that hides best. With
# ECHO_START_TIMEOUT_S=abc the readiness loop's `[ "${ELAPSED}" -lt "${START_TIMEOUT_S}" ]`
# exits 2, a `while` reads that as false, so the loop never runs ONCE: the script kills
# the server it just launched and reports "did not answer in abcs" — a timeout message
# for a typo, on a run that never probed anything.
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
require_positive_int ECHO_POLL_INTERVAL_S "${POLL_INTERVAL_S}" \
  "Zero never advances the deadline, so the wait below would never end."
require_positive_int ECHO_START_TIMEOUT_S "${START_TIMEOUT_S}" \
  "A non-numeric deadline makes the readiness loop skip every iteration, which reports a timeout for a run that never probed."

# --- The address Langflow has to be able to call --------------------------------
# RFC-1918 only, and the reason is not tidiness. `LANGFLOW_SSRF_ALLOWED_HOSTS` carries
# `172.16.0.0/12,10.0.0.0/8,192.168.0.0/16` on every lane and both start scripts, so a
# private address is admitted BY POLICY — which is what makes the SSRF spec's admitted
# case mean something. A public address is reachable and therefore looks fine, but
# `privateEchoEndpoint()` skips on it rather than asserting, and a host carrying a
# public address alongside the private one makes "whatever `hostname -I` prints
# first" a coin flip between a real assertion and a silent skip.
is_rfc1918() {
  case "$1" in
    10.*) return 0 ;;
    192.168.*) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

discover_addresses() {
  # `ip -4 -o addr show scope global` on Linux; `ifconfig` as the fallback so the
  # script can be exercised on a developer's machine. Neither is asked to filter:
  # the selection below is the only place that decides.
  if command -v ip > /dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif command -v ifconfig > /dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}'
  fi
}

if [ -z "${BIND_HOST}" ]; then
  # Asked BEFORE the discovery, because with neither tool present the discovery
  # prints nothing and "this machine has no private address" and "I could not look"
  # become the same empty string — the shape #1092 was raised about. The first
  # message sends the reader to the network; only the second is true.
  if ! command -v ip > /dev/null 2>&1 && ! command -v ifconfig > /dev/null 2>&1; then
    echo "ERROR: cannot enumerate this machine's addresses — neither \`ip\` nor \`ifconfig\` is on PATH." >&2
    echo "This is NOT the same as having no RFC-1918 address, and reporting it as that" >&2
    echo "would send you to the network instead of to the PATH." >&2
    echo "Pass the address explicitly with ECHO_BIND_HOST." >&2
    exit 2
  fi
  ADDRESSES="$(discover_addresses || true)"
  for addr in ${ADDRESSES}; do
    if is_rfc1918 "${addr}"; then BIND_HOST="${addr}"; break; fi
  done
  if [ -z "${BIND_HOST}" ]; then
    echo "ERROR: no RFC-1918 address on this machine to bind the echo endpoint to." >&2
    echo "Addresses found: ${ADDRESSES:-none}" >&2
    echo "Langflow blocks loopback outright and admits private ranges only through" >&2
    echo "LANGFLOW_SSRF_ALLOWED_HOSTS, so a public address would make the SSRF spec SKIP" >&2
    echo "instead of assert — a lane one silent test short, which reads as a pass." >&2
    echo "Pass one explicitly with ECHO_BIND_HOST if this machine's topology differs." >&2
    exit 2
  fi
fi

case "${BIND_HOST}" in
  127.* | localhost | ::1)
    echo "ERROR: refusing to bind the echo endpoint to loopback (${BIND_HOST})." >&2
    echo "Langflow's SSRF layer blocks loopback unconditionally — it ignores" >&2
    echo "LANGFLOW_SSRF_ALLOWED_HOSTS for those addresses — so every echo spec would fail" >&2
    echo "with a refusal that reads like a product bug." >&2
    exit 2
    ;;
esac

if ! is_rfc1918 "${BIND_HOST}"; then
  echo "ERROR: ${BIND_HOST} is not an RFC-1918 address." >&2
  echo "Reaching it proves nothing about LANGFLOW_SSRF_ALLOWED_HOSTS, so the SSRF spec's" >&2
  echo "admitted case would SKIP rather than assert (tests/helpers/other/private-echo-endpoint.ts)." >&2
  echo "That is a silent loss of coverage, which is why this is refused and not warned about." >&2
  exit 2
fi

HEALTH_HOST="${HEALTH_HOST:-${BIND_HOST}}"

# --- Refuse to start on top of something already running ------------------------
# Same two halves, and the same reasoning, as the Langflow starter: the PID file
# catches an instance this script started and nobody stopped, the probe catches
# everything else. Without the probe a failed bind is invisible — the readiness loop
# would be answered by the OTHER endpoint and report ready at once.
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "ERROR: an echo endpoint started by this script is still running on port ${PORT} (PID $(cat "${PID_FILE}"))." >&2
  echo "Stop it first: ECHO_PORT=${PORT} ./scripts/stop-echo-source.sh" >&2
  exit 2
fi
# `--max-time` for the same reason the readiness poll carries one: a port that is
# filtered rather than closed does not refuse, it hangs, and curl's default connect
# timeout is ~300s — spent here, before the script has done anything at all.
if curl -sf --max-time 5 "http://${HEALTH_HOST}:${PORT}/get" > /dev/null 2>&1; then
  echo "ERROR: something already answers /get on ${HEALTH_HOST}:${PORT}." >&2
  echo "Refusing to start: this script cannot tell that endpoint from the one it would" >&2
  echo "launch, so a failed bind would be reported as a healthy start and the specs would" >&2
  echo "run against it. Free the port, or pick another with ECHO_PORT." >&2
  exit 2
fi

# --- Provision the pinned binary ------------------------------------------------
# `-version` prints `go-httpbin version <v>` on the first line. Asking the binary
# rather than trusting the file name is what catches the case the name cannot: a
# truncated extract, or a file someone put there by hand.
binary_version() {
  "$1" -version 2>&1 | head -1 | awk '{print $NF}'
}

if [ -x "${BIN}" ]; then
  HAVE="$(binary_version "${BIN}" || echo unknown)"
  if [ "${HAVE}" != "${VERSION}" ]; then
    echo "ERROR: ${BIN} reports version '${HAVE}', not the pinned ${VERSION}." >&2
    echo "Refusing to run it: the point of the pin is that this endpoint behaves exactly" >&2
    echo "like the container the CI lanes use, and a different build is the one difference" >&2
    echo "this lane cannot tell from a product change. Delete it to re-download." >&2
    exit 2
  fi
else
  if [ "${ECHO_DOWNLOAD:-1}" != "1" ]; then
    echo "ERROR: no binary at ${BIN}, and ECHO_DOWNLOAD is not 1." >&2
    echo "Provision it yourself, or set ECHO_BIN to one that exists." >&2
    exit 2
  fi
  echo "Downloading go-httpbin ${VERSION} (${ASSET})..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  if ! curl -fsSL -o "${TMP_DIR}/${ASSET}" "${RELEASE_BASE}/${ASSET}"; then
    echo "ERROR: could not download ${RELEASE_BASE}/${ASSET}" >&2
    echo "This machine needs egress to github.com for the pinned release." >&2
    exit 2
  fi
  if ! curl -fsSL -o "${TMP_DIR}/checksums.txt" "${RELEASE_BASE}/checksums.txt"; then
    echo "ERROR: could not download ${RELEASE_BASE}/checksums.txt" >&2
    echo "Refusing to install an unverified binary." >&2
    exit 2
  fi
  # Matched on the WHOLE second field, never with grep. The release publishes an
  # `<asset>.sbom.json` line alongside the asset's own, and any substring match picks
  # up both — sha256sum then reports a missing file and fails the check for a reason
  # that has nothing to do with the download. (Found the first time this ran.)
  EXPECTED="$(awk -v a="${ASSET}" '$2 == a {print $1; exit}' "${TMP_DIR}/checksums.txt")"
  if [ -z "${EXPECTED}" ]; then
    echo "ERROR: ${ASSET} has no entry in the release's checksums.txt." >&2
    exit 2
  fi
  # sha256sum on the VMs; shasum on a developer's macOS, where the first does not
  # exist. Without the fallback the verification step is the one part of this script
  # that cannot be exercised outside the target machine.
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
  tar xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}"
  if [ ! -f "${TMP_DIR}/go-httpbin" ]; then
    echo "ERROR: ${ASSET} did not contain a go-httpbin binary." >&2
    exit 2
  fi
  mkdir -p "$(dirname "${BIN}")"
  # Moved into place only after the checksum passed, so an interrupted download never
  # leaves a half-written binary under the pinned name for the next run to trust.
  mv "${TMP_DIR}/go-httpbin" "${BIN}"
  chmod +x "${BIN}"
  HAVE="$(binary_version "${BIN}" || echo unknown)"
  if [ "${HAVE}" != "${VERSION}" ]; then
    echo "ERROR: the downloaded binary reports version '${HAVE}', not ${VERSION}." >&2
    rm -f "${BIN}"
    exit 2
  fi
  echo "Installed ${BIN} (verified ${VERSION})"
fi

mkdir -p "${STATE_DIR}"
STATE_DIR="$(cd "${STATE_DIR}" && pwd)"
PID_FILE="${STATE_DIR}/echo.pid"
LOG_FILE="${STATE_DIR}/echo.log"
# Truncated, not appended: the failure path below tails this file, so an inherited log
# makes one start attempt report the previous one's error as its own cause.
: > "${LOG_FILE}"

echo "Starting go-httpbin ${VERSION} on ${BIND_HOST}:${PORT} (logs: ${LOG_FILE})..."
# Backgrounded as a SIMPLE command, for the reason start-langflow-source.sh records at
# length: with `( ... ) &` the PID is the subshell's, so the stop script kills the
# wrapper and the server survives as an orphan holding the port.
#
# `-use-real-hostname` is deliberately NOT passed. It is off by default, and it must
# stay off: /hostname would otherwise answer with this machine's real name, which is
# internal topology, published into whatever report or trace captures the response.
"${BIN}" -host "${BIND_HOST}" -port "${PORT}" -max-duration "${MAX_DURATION}" \
  < /dev/null >> "${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > "${PID_FILE}"

echo "Waiting for the echo endpoint to answer (up to ${START_TIMEOUT_S}s)..."
ELAPSED=0
while [ "${ELAPSED}" -lt "${START_TIMEOUT_S}" ]; do
  # Liveness first, same as the Langflow starter: a process that exited is not slow,
  # and waiting out the deadline to say so misnames a failed bind as a busy machine.
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "ERROR: go-httpbin exited after ${ELAPSED}s without answering (PID ${SERVER_PID}). Last log lines:" >&2
    tail -n 20 "${LOG_FILE}" >&2 || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  # Probed at the address LANGFLOW will call, not at loopback. On a host-based CI job
  # the two differ and probing the published port is right; here they are the same
  # machine and the same address, so probing loopback would confirm only that the
  # process is up — not that the address the specs depend on is reachable, which is
  # the half that fails when a bind lands on the wrong interface.
  if curl -sf --max-time 5 "http://${HEALTH_HOST}:${PORT}/get" > /dev/null 2>&1; then
    echo "Echo endpoint ready after ${ELAPSED}s (PID: ${SERVER_PID}, port ${PORT})"
    # Machine-readable, for `ssh <host> 'bash -s' < this` to capture. The caller feeds
    # it to scripts/resolve-echo-endpoint.mjs, which decides ECHO_BASE_URL and is the
    # gate that fails the lane if this address is one the specs cannot assert against.
    echo "ECHO_HOST_IP=${BIND_HOST}"
    echo "ECHO_PORT=${PORT}"
    exit 0
  fi
  sleep "${POLL_INTERVAL_S}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_S))
done

echo "ERROR: the echo endpoint did not answer in ${START_TIMEOUT_S}s. Last log lines:" >&2
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
