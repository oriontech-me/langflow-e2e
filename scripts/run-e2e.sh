#!/usr/bin/env bash
#
# run-e2e.sh — run the @stable daily on the QA VMs, mirroring daily-stable.yml.
#
# ## Why this exists
#
# The GitHub Enterprise Server this suite is mirrored to has no Actions runners, so
# daily-stable.yml cannot run there. This script reproduces the SAME pipeline on two
# ordinary VMs, calling exactly the same scripts the workflow calls —
# partition-shards.mjs, wait-for-backend.mjs, watch-backend.mjs, watch-tokens.mjs,
# check-run-integrity.mjs, report-backend-outages.mjs, build-run-payload.mjs,
# append-weekly-history.mjs. No logic is reimplemented here. What changes is the
# ORCHESTRATOR (bash instead of the Actions runner) and the SUBSTRATE (native
# processes instead of `services:` containers).
#
# ## The mapping
#
#   daily-stable.yml                    | here
#   ------------------------------------|-----------------------------------------
#   job `prep` (playwright container)   | phase_prep     — npm ci + --list + partition
#   job `test` (matrix, 1 job/shard)    | phase_shards   — 1 subshell + 1 backend/shard
#     services.langflow                 |   start-langflow-source.sh on the TARGET host
#     services.ollama                   |   start-ollama-source.sh   on the TARGET host
#     services.go-httpbin               |   start-echo-source.sh     on the TARGET host
#     actions/upload-artifact           |   copies into $RUN_DIR
#   job `merge`                         | phase_merge + phase_publish
#   "Fail scheduled run on ..."         | phase_verdict
#
# ## The five differences that matter
#
# 1. TWO MACHINES, NOT ONE. Playwright runs here (the runner host); Langflow, the
#    echo endpoint and Ollama run on the TARGET host, driven over
#    `ssh <target> 'bash -s' < scripts/start-*.sh`. Nothing is copied there: the
#    starters are self-contained and their whole interface is the environment, so
#    the target keeps no checkout of this repository to drift.
#
# 2. LANGFLOW DOES NOT SURVIVE THE SESSION THAT STARTS IT. Measured, not assumed: an
#    `ssh` that starts it and returns leaves the port free within seconds — the log
#    shows a graceful shutdown, not a crash. Ollama and the echo binary survive the
#    same treatment. So each backend is started by a session this script HOLDS open
#    for the life of the shard, and stopped through its own stop script before that
#    session is closed. A fire-and-forget orchestrator would find an empty port on
#    the first shard.
#
# 3. SECURE CONTEXT. Chromium only treats `localhost` as a secure context, and ten
#    clipboard specs depend on it. On the VMs that is the SSH tunnel's job, so this
#    script REFUSES to run without it rather than producing a verdict that differs
#    from the CI's for a reason that has nothing to do with the product. Override
#    with ALLOW_NO_TUNNEL=1, which names exactly what it costs.
#
# 4. PER-SHARD WORKING COPY. In CI each shard is a separate job with its own
#    checkout. Here they share a machine, so each gets its own copy of the tree with
#    node_modules symlinked: `collect-models` WRITES into
#    tests/helpers/provider-setup/data/ by fixed path and catalog-snapshot.ts freezes
#    models.json in globalSetup — shards in one directory overwrite each other's
#    catalog mid-read.
#
# 5. NO ISSUE, NO SLACK, NO PLATFORM POST — yet. While the VM daily runs beside the
#    Actions one, only the Actions verdict has consequence: this run is observed, not
#    acted on. The code paths exist and are off by default; they turn on when the
#    webhook and the secrets exist.
#
# ## Usage
#
#   TARGET_SSH=<ssh-alias> ./scripts/run-e2e.sh              # 4 shards
#   TARGET_SSH=<alias> SHARDS=2 ./scripts/run-e2e.sh
#   TARGET_SSH=<alias> DRY_RUN=1 ./scripts/run-e2e.sh        # preflight + partition only
#
# The target host is never named in this repository: it is internal topology, and it
# lives in the destination wiki. TARGET_SSH is required and has no default.
#
# ## Exit code
#
# Mirrors "Fail scheduled run on an incomplete, empty or partial report": non-zero
# when a shard had a failing test, when a shard blob is missing, or when the merged
# report is empty (zero results) or partial (results plus top-level errors).

set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# The machine hosting Langflow, the echo endpoint and Ollama. No default on purpose.
TARGET_SSH="${TARGET_SSH:-}"
# Extra ssh options, as a single string. The VMs resolve through a DNS the sandbox
# does not always see, so a caller may need `-o HostName=<ip> -o HostKeyAlias=<name>`.
TARGET_SSH_OPTS="${TARGET_SSH_OPTS:-}"

SHARDS="${SHARDS:-4}"
BASE_PORT="${BASE_PORT:-7860}"
ECHO_PORT="${ECHO_PORT:-8080}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
RETRIES="${RETRIES:-}"                        # empty = the config's default (2 in CI)
RECOVER_TIMEOUT_S="${RECOVER_TIMEOUT_S:-420}"
BACKEND_START_TIMEOUT_S="${BACKEND_START_TIMEOUT_S:-300}"

# The tunnel is the default and its absence is refused — see difference 3 above.
LANGFLOW_TUNNEL="${LANGFLOW_TUNNEL:-1}"
ALLOW_NO_TUNNEL="${ALLOW_NO_TUNNEL:-0}"

WITH_ECHO="${WITH_ECHO:-1}"
WITH_OLLAMA="${WITH_OLLAMA:-1}"

# Off while the VM daily has no consequence. Each turns on with the step that gives
# it something to talk to: 08 (webhook), 09 (secrets and cron).
CREATE_ISSUE="${CREATE_ISSUE:-0}"
NOTIFY_SLACK="${NOTIFY_SLACK:-0}"
POST_QA_PLATFORM="${POST_QA_PLATFORM:-0}"
COMMIT_HISTORY="${COMMIT_HISTORY:-0}"
REFRESH_DURATIONS="${REFRESH_DURATIONS:-0}"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUNS_ROOT="${RUNS_ROOT:-$REPO_DIR/runs}"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
RUNS_KEEP="${RUNS_KEEP:-30}"
RUN_URL_BASE="${RUN_URL_BASE:-file://$RUNS_ROOT}"
REPORT_URL="$RUN_URL_BASE/$RUN_ID/playwright-report/index.html"
EVENT_NAME="${EVENT_NAME:-schedule}"
WORKFLOW_ID="${WORKFLOW_ID:-daily-stable-vm}"

# Which Langflow this lane SHOULD be testing. The rule is upstream's — the newest
# `release-X.Y.Z` branch, never `main` — and scripts/resolve-target-version.mjs owns
# it. Here the run only REPORTS the gap: moving and rebuilding the clone is a second
# change, and until it lands a mismatch has to be visible rather than fatal, or a
# whole day of comparison data is lost to a version difference nobody can fix at 08:00.
UPSTREAM_REPO_URL="${UPSTREAM_REPO_URL:-https://github.com/langflow-ai/langflow}"
# The PUBLISHED image is what the CI lane pulls, and therefore what this lane has to
# match. Asking the registry rather than the git tags is not a detail: upstream tags
# before it builds and only ships if the tests pass, so a tag can exist for an image
# that never shipped.
# `ordering=last_updated` is not decoration: the repository carries ~2700 tags and one
# page is fetched, so an unspecified order can leave `latest` and the version tag
# pushed in the same run on different pages — and the resolution then falls back to
# the git refs, quietly, for a reason that has nothing to do with the registry.
#
# The repository named here has to be the one the ACTIONS lane pulls. daily-stable.yml
# takes `langflow_image` / `langflow_image_tag` inputs on manual dispatch, so a run
# against `langflowai/langflow:1.12.0` would be compared with an expectation resolved
# from `langflow-nightly:latest` — a comparison of a different pair of lanes than the
# one it claims. Override this together with those inputs, never one alone.
NIGHTLY_TAGS_URL="${NIGHTLY_TAGS_URL:-https://hub.docker.com/v2/repositories/langflowai/langflow-nightly/tags?page_size=100&ordering=last_updated}"
CHECK_TARGET_VERSION="${CHECK_TARGET_VERSION:-1}"
REQUIRE_TARGET_VERSION="${REQUIRE_TARGET_VERSION:-0}"
# Whether the run OBEYS the resolution instead of only reporting it. Reporting was
# step 16's first half and was deliberately not fatal: failing at 08:00 over a clone
# somebody had to move by hand threw away a day of data. This is the second half —
# the run moves the clone itself, through scripts/prepare-target-source.sh, before
# anything starts. That script is a no-op when the clone is already on the commit and
# its build is stamped with it, so the cost lands only on the days the resolution
# moves; with a nightly image, that is most days.
PREPARE_TARGET="${PREPARE_TARGET:-1}"
# Move the clone but do not build. Not a normal setting: the starter refuses a build
# that does not belong to HEAD, so this ends the run early ON PURPOSE. It exists to
# measure what a rebuild would cost, and to move a clone whose build is being done
# by hand elsewhere.
PREPARE_TARGET_SKIP_BUILD="${PREPARE_TARGET_SKIP_BUILD:-0}"
# The stamp is only demanded when this run is the thing that wrote it. A clone
# prepared by hand carries no stamp, and refusing it there would break the one
# workflow that has to keep working while this is being adopted.
STAMP_REQUIRED="$([ "${PREPARE_TARGET}" = "1" ] && [ "${PREPARE_TARGET_SKIP_BUILD}" != "1" ] && echo 1 || echo 0)"

MIN_FREE_GB="${MIN_FREE_GB:-20}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_BACKENDS="${KEEP_BACKENDS:-0}"

# `uv` lives in ~/.local/bin and cron does not load it: in a non-interactive shell
# `command -v uv` fails, and the Langflow starter needs it to build the source clone.
# Exported because the starters run through ssh, which starts another non-interactive
# shell on the far side — that one is handled explicitly at the call sites.
export PATH="$HOME/.local/bin:$PATH"

# Playwright 1.58.2 does not know Ubuntu 26.04 and refuses to install browsers there.
# Without this, any browser (re)install on these machines dies and the run ends in
# globalSetup — see the migration's divergence list, entry 1.
export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}"

# ---------------------------------------------------------------------------
# UTILITIES
# ---------------------------------------------------------------------------

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m::warning:: %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31m::error:: %s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# shellcheck disable=SC2086
target_ssh() { ssh -o BatchMode=yes -o ConnectTimeout=15 $TARGET_SSH_OPTS "$TARGET_SSH" "$@"; }

# Reads one key out of a $GITHUB_OUTPUT-formatted file, including the heredoc form
# (`key<<DELIM ... DELIM`) that report-backend-outages.mjs uses for multi-line values.
gh_out() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  node -e '
    const fs = require("fs");
    const [file, key] = process.argv.slice(1);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let value = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const heredoc = line.match(/^([A-Za-z0-9_]+)<<(.+)$/);
      if (heredoc) {
        const [, k, delim] = heredoc;
        const buf = [];
        while (++i < lines.length && lines[i] !== delim) buf.push(lines[i]);
        if (k === key) value = buf.join("\n");
        continue;
      }
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq) === key) value = line.slice(eq + 1);
    }
    if (value !== null) process.stdout.write(value);
  ' "$file" "$key"
}

HELD_SESSIONS=()

# Which of the given ports have no local listener. `ssh -L` opens its listener as soon
# as it connects, so this is answerable before anything else starts.
#
# The probe runs in a SUBSHELL, and that is the whole point: the descriptor it opens
# dies with the subshell, so the caller needs no `exec 3>&-` to clean up. The version
# that did have one carried `2>/dev/null` with it — and `exec` with no command applies
# its redirections to THE SHELL, which sent stderr to /dev/null for the rest of the
# run. Every warn and every err after preflight vanished, including the verdict's own
# explanation of why it failed: the exit code stayed right and the reason stopped
# existing. A smoke run found it; two reviews had not.
ports_without_listener() {
  local port
  for port in "$@"; do
    if ! (exec 3<> "/dev/tcp/127.0.0.1/${port}") 2> /dev/null; then
      printf '%s\n' "$port"
    fi
  done
}

cleanup() {
  local code=$?
  if [ "$KEEP_BACKENDS" = "1" ]; then
    warn "KEEP_BACKENDS=1 — the target's services were left running for inspection."
    return $code
  fi
  log "Stopping the target's services"
  local i port
  for i in $(seq 1 "${SHARD_TOTAL:-$SHARDS}"); do
    port=$((BASE_PORT + i - 1))
    target_ssh "LANGFLOW_PORT=$port bash -s" < scripts/stop-langflow-source.sh > /dev/null 2>&1 || true
  done
  [ "$WITH_ECHO" = "1" ] && target_ssh "ECHO_PORT=$ECHO_PORT bash -s" < scripts/stop-echo-source.sh > /dev/null 2>&1 || true
  [ "$WITH_OLLAMA" = "1" ] && target_ssh "OLLAMA_PORT=$OLLAMA_PORT bash -s" < scripts/stop-ollama-source.sh > /dev/null 2>&1 || true
  # The holders last, and only after the stop scripts have had their turn: killing
  # one is what makes its Langflow die by hangup, which is the ungraceful path.
  local pid
  for pid in "${HELD_SESSIONS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  return $code
}

# ---------------------------------------------------------------------------
# HYGIENE — what a fresh Actions runner gave for free
# ---------------------------------------------------------------------------
# A full disk and a leftover backend both produce failures that look like product
# bugs, and on the comparison this etapa exists to produce they would be filed as
# environment divergences and chased as ghosts. Cheaper to refuse up front.

phase_hygiene() {
  log "Hygiene"

  local free_gb
  free_gb="$(df -Pk "$REPO_DIR" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
  info "runner host: ${free_gb} GB free"
  [ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb} GB free here, and a run needs at least ${MIN_FREE_GB} (blobs, reports, one tree copy per shard)."

  free_gb="$(target_ssh "df -Pk /" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
  info "target host: ${free_gb} GB free"
  [ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb} GB free on the target."

  # Leftovers from a run that was killed rather than finished. Stopping through the
  # stop scripts (not pkill) keeps this honest: they only touch what a starter of
  # ours recorded a PID file for, so a Langflow somebody else is using survives.
  log "Clearing leftovers on the target"
  local i port
  for i in $(seq 1 "$SHARDS"); do
    port=$((BASE_PORT + i - 1))
    target_ssh "LANGFLOW_PORT=$port bash -s" < scripts/stop-langflow-source.sh 2>&1 | sed 's/^/    /' || true
  done
  target_ssh "ECHO_PORT=$ECHO_PORT bash -s" < scripts/stop-echo-source.sh 2>&1 | sed 's/^/    /' || true
  target_ssh "OLLAMA_PORT=$OLLAMA_PORT bash -s" < scripts/stop-ollama-source.sh 2>&1 | sed 's/^/    /' || true

  # Old run directories. Retention is the only thing standing between a daily cron
  # and a disk that fills up in a month of tree copies.
  if [ -d "$RUNS_ROOT" ]; then
    local old
    old="$(find "$RUNS_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$RUNS_KEEP" || true)"
    if [ -n "$old" ]; then
      info "removing $(echo "$old" | wc -l | tr -d ' ') run director(ies) beyond the last $RUNS_KEEP"
      echo "$old" | while read -r d; do [ -n "$d" ] && rm -rf "$d"; done
    fi
  fi
}

# ---------------------------------------------------------------------------
# PREFLIGHT
# ---------------------------------------------------------------------------

phase_preflight() {
  log "Preflight"

  [ -n "$TARGET_SSH" ] || die "TARGET_SSH is required — this script drives a second machine and will not guess its name."
  command -v node > /dev/null || die "node is not on PATH."
  command -v npm  > /dev/null || die "npm is not on PATH."
  command -v ssh  > /dev/null || die "ssh is not on PATH."
  info "node $(node -v), npm $(npm -v)"

  target_ssh true > /dev/null 2>&1 || die "cannot reach the target over ssh ($TARGET_SSH). With the VPN down this is the first thing that fails."
  info "target: reachable"

  # `uv` is the only thing that can build the Langflow source clone, and the trap is
  # PATH rather than absence: a non-interactive ssh does not load ~/.local/bin.
  target_ssh 'PATH=$HOME/.local/bin:$PATH command -v uv' > /dev/null 2>&1 \
    || die "uv is not reachable on the target even with ~/.local/bin on PATH — the Langflow starter cannot build the clone without it."

  mkdir -p "$RUN_DIR"/{logs,all-blobs,all-liveness,all-tokens}
  info "run dir: $RUN_DIR"

  # The suite this run executes, recorded before anything else can move it. Without a
  # repository on the target this is also the only record of which starter version ran
  # over there, since the starters are piped in from here.
  git fetch --prune --quiet origin || warn "could not fetch from origin — running against whatever this clone already had."
  local sha branch
  sha="$(git rev-parse HEAD)"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  local behind
  behind="$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)"
  info "suite: $branch @ ${sha:0:10}${behind:+ ($behind commit(s) behind origin)}"

  # What the CI will be testing today, resolved by upstream's own rule. Informational
  # here and compared after the run: asking now means the operator sees the gap before
  # spending an hour producing a comparison that a version difference already spoiled.
  TARGET_EXPECTED_VERSION=""; TARGET_EXPECTED_REF=""; TARGET_EXPECTED_SHA=""; TARGET_RESOLUTION=""
  TARGET_EXPECTED_BRANCH=""
  if [ "$CHECK_TARGET_VERSION" = "1" ]; then
    local vlog="$RUN_DIR/logs/target-version.log" verr="$RUN_DIR/logs/target-version.err"
    # The registry listing is optional and its absence is survivable — the resolver
    # falls back to the refs and says so — so a failure here warns and continues.
    curl -sfS --max-time 20 "$NIGHTLY_TAGS_URL" -o "$RUN_DIR/nightly-tags.json" 2>> "$vlog" \
      || warn "could not read the published nightly image listing; the expected version will come from the git refs, which can run ahead of what actually shipped."
    # Both inputs are best-effort, and NEITHER gates the other. The registry answers
    # the question — which version — and the refs only add which commit that version
    # was built from. Gating the whole resolution on the git fetch (as this did) hands
    # github.com a veto over an answer it does not provide: github unreachable at
    # 08:00, registry fine, and the run would report an unperformed check — fatal
    # under REQUIRE_TARGET_VERSION. github is also the flakier of the two here, since
    # the suite's own origin is the internal mirror and this is the only reach out.
    : > "$RUN_DIR/upstream-refs.txt"
    git ls-remote --heads --tags "$UPSTREAM_REPO_URL" > "$RUN_DIR/upstream-refs.txt" 2>> "$vlog" \
      || warn "could not reach $UPSTREAM_REPO_URL for the ref listing; the expected VERSION can still come from the registry, but the commit behind it will be unknown."
    local decision
    decision="$(node scripts/resolve-target-version.mjs \
        --refs-file "$RUN_DIR/upstream-refs.txt" \
        --image-tags-file "$RUN_DIR/nightly-tags.json" 2> "$verr" || true)"
    # The resolver's warnings are the difference between "same commit" and "same
    # cycle". Shown, not just filed: a run that silently downgraded its own claim
    # is how a comparison starts meaning less than the reader thinks.
    if [ -s "$verr" ]; then cat "$verr" >&2; cat "$verr" >> "$vlog"; fi
    if [ -n "$decision" ] && [ "$(node -p "try{JSON.parse(process.argv[1]).ok===true?'true':'false'}catch{'false'}" "$decision")" = "true" ]; then
      TARGET_EXPECTED_VERSION="$(node -p "JSON.parse(process.argv[1]).version||''" "$decision")"
      TARGET_EXPECTED_REF="$(node -p "JSON.parse(process.argv[1]).ref||''" "$decision")"
      TARGET_EXPECTED_SHA="$(node -p "JSON.parse(process.argv[1]).sha||''" "$decision")"
      TARGET_RESOLUTION="$(node -p "JSON.parse(process.argv[1]).strategy||''" "$decision")"
      # Carried for the preparer, not for the report: when the nightly tag has been
      # recreated, the commit is only reachable through the branch it lives on.
      TARGET_EXPECTED_BRANCH="$(node -p "JSON.parse(process.argv[1]).branch||''" "$decision")"
      info "target should be: $TARGET_EXPECTED_VERSION (ref $TARGET_EXPECTED_REF, commit ${TARGET_EXPECTED_SHA:0:10}, by $TARGET_RESOLUTION)"
    else
      # Quote the resolver rather than inventing a reason: it distinguishes "no
      # release branch in the listing" from "the file could not be read", and the
      # two send the reader to different places.
      local why
      why="$(node -p "try{JSON.parse(process.argv[1]).error||''}catch{''}" "${decision:-}" 2>/dev/null || true)"
      warn "could not resolve which Langflow this lane should test${why:+ — $why}"
      warn "The comparison will not know whether both sides ran the same product."
    fi
  fi

  # --- Obey the resolution: put the target ON that commit -------------------------
  # Failing here is the point. A run against the clone's old position still produces
  # a verdict, and that verdict goes into the divergence list as "a real failure only
  # Actions saw" — product changelog wearing an environment's clothes. A lane whose
  # output would be misleading is worth less than no output.
  TARGET_PREPARED_SHA=""; TARGET_REBUILT=""; TARGET_REBUILD_REASON=""; TARGET_PREPARE_S=""
  if [ "$PREPARE_TARGET" = "1" ] && [ -n "${TARGET_EXPECTED_SHA}${TARGET_EXPECTED_REF}" ]; then
    log "Preparing the target's clone"
    local prep_out prep_log="$RUN_DIR/logs/prepare-target.log"
    # stderr is streamed AND filed: a rebuild is the longest thing this run does, and
    # a phase that prints nothing for half an hour is indistinguishable from a hang.
    if ! prep_out="$(target_ssh \
        "TARGET_SHA=${TARGET_EXPECTED_SHA} TARGET_REF=${TARGET_EXPECTED_REF} TARGET_BRANCH=${TARGET_EXPECTED_BRANCH} \
         LANGFLOW_SRC_REPO=\${LANGFLOW_SRC_REPO:-\$HOME/langflow} \
         PREPARE_SKIP_BUILD=${PREPARE_TARGET_SKIP_BUILD} bash -s" \
        < scripts/prepare-target-source.sh 2> >(tee -a "$prep_log" >&2))"; then
      err "could not put the target on ${TARGET_EXPECTED_REF:-${TARGET_EXPECTED_SHA}}."
      err "Refusing to run. The comparison this lane exists to produce is only about"
      err "the environment if both sides run the same product; against the clone's old"
      err "position it describes the product's changelog instead. See $prep_log."
      die "target preparation failed"
    fi
    printf '%s\n' "$prep_out" >> "$prep_log"
    TARGET_PREPARED_SHA="$(printf '%s\n' "$prep_out" | sed -n 's/^prepared_sha=//p')"
    TARGET_REBUILT="$(printf '%s\n' "$prep_out" | sed -n 's/^rebuilt=//p')"
    TARGET_REBUILD_REASON="$(printf '%s\n' "$prep_out" | sed -n 's/^rebuild_reason=//p')"
    TARGET_PREPARE_S="$(printf '%s\n' "$prep_out" | sed -n 's/^total_s=//p')"
    # The preparer verifies its own checkout; this checks that the machine it verified
    # is the one this run resolved. They differ if TARGET_SSH points somewhere else.
    if [ -n "${TARGET_EXPECTED_SHA}" ] && [ "${TARGET_PREPARED_SHA}" != "${TARGET_EXPECTED_SHA}" ]; then
      err "the target reports ${TARGET_PREPARED_SHA:-nothing} after being asked for ${TARGET_EXPECTED_SHA}."
      die "the prepared commit is not the resolved one"
    fi
    info "target clone: ${TARGET_PREPARED_SHA:0:10} (rebuilt=${TARGET_REBUILT:-?}${TARGET_PREPARE_S:+, ${TARGET_PREPARE_S}s})"
    [ "${TARGET_REBUILT}" = "yes" ] && info "  rebuilt because: ${TARGET_REBUILD_REASON}"
  elif [ "$PREPARE_TARGET" = "1" ]; then
    warn "no target commit was resolved, so the clone was left where it is. The version"
    warn "check below still runs, but nothing has been placed — treat a match as luck."
  fi

  log "Installing dependencies (npm ci)"
  npm ci

  # Same guard as the workflow's "Verify Playwright version matches the container
  # image", derived rather than copied: the tag in daily-stable.yml is the CI's
  # browser, and a mismatch kills every test at launch with a cryptic error.
  local pkg_version lane_version
  pkg_version="$(node -p "require('@playwright/test/package.json').version")"
  lane_version="$(grep -oE 'mcr\.microsoft\.com/playwright:v[0-9.]+' .github/workflows/daily-stable.yml | head -1 | sed 's/.*:v//')"
  [ -n "$lane_version" ] || die "could not read the Playwright image tag out of daily-stable.yml."
  [ "$pkg_version" = "$lane_version" ] || die "@playwright/test is $pkg_version but the CI lane runs v$lane_version — the VM would test a different browser than the comparison assumes."
  info "@playwright/test $pkg_version (matches the lane)"

  log "Ensuring the Chromium build"
  npx playwright install --with-deps chromium

  # The tunnel, checked before anything is started. `ssh -L` opens the local listener
  # as soon as it connects, so this is answerable now — and answering it later, from a
  # failed health probe, cannot tell "no tunnel" from "backend did not start".
  if [ "$LANGFLOW_TUNNEL" = "1" ]; then
    local missing
    missing="$(ports_without_listener $(seq "$BASE_PORT" $((BASE_PORT + SHARDS - 1))) | tr '\n' ' ')"
    missing="${missing% }"
    if [ -n "$missing" ]; then
      err "no local listener on port(s): ${missing}"
      err "The tunnel to the target is what makes the backend answer on localhost, and"
      err "Chromium treats ONLY localhost as a secure context: without it the ten"
      err "clipboard specs fail deterministically and this run's verdict differs from"
      err "the CI's for a reason that is not the product."
      err "Bring the tunnel up (one forward per shard port), or accept the cost with"
      err "ALLOW_NO_TUNNEL=1, which binds the backend to the target's private address."
      [ "$ALLOW_NO_TUNNEL" = "1" ] || exit 1
      warn "ALLOW_NO_TUNNEL=1 — continuing without the tunnel. The clipboard specs WILL fail."
      LANGFLOW_TUNNEL=0
    else
      info "tunnel: listeners present on $BASE_PORT..$((BASE_PORT + SHARDS - 1))"
    fi
  fi

  trap cleanup EXIT
}

# ---------------------------------------------------------------------------
# SERVICES — the `services:` block, natively, on the target
# ---------------------------------------------------------------------------

phase_services() {
  log "Starting the target's services"

  TARGET_ADDR=""
  ECHO_BASE_URL_RESOLVED=""

  if [ "$WITH_ECHO" = "1" ]; then
    local out
    out="$(target_ssh "ECHO_PORT=$ECHO_PORT bash -s" < scripts/start-echo-source.sh | tee "$RUN_DIR/logs/echo-start.log")"
    TARGET_ADDR="$(printf '%s\n' "$out" | awk -F= '/^ECHO_HOST_IP=/{print $2}')"
    [ -n "$TARGET_ADDR" ] || die "the echo starter did not report ECHO_HOST_IP."
    info "echo: $TARGET_ADDR:$ECHO_PORT"

    # The DECISION about what ECHO_BASE_URL becomes stays in the resolver, which is
    # unit-tested; this script only discovers. `--mode fail` because on this lane a
    # silent fallback to public httpbin.org is exactly the failure we are here to
    # avoid measuring as a product difference.
    local decision ok
    decision="$(node scripts/resolve-echo-endpoint.mjs --topology native \
      --service-port "$ECHO_PORT" --host-ips "$TARGET_ADDR" --mode fail 2>> "$RUN_DIR/logs/echo-start.log" || true)"
    ok="$(node -p "try{JSON.parse(process.argv[1]).ok===true?'true':'false'}catch{'false'}" "$decision" 2>/dev/null || echo false)"
    if [ "$ok" = "true" ]; then
      ECHO_BASE_URL_RESOLVED="$(node -p "JSON.parse(process.argv[1]).langflowUrl||''" "$decision")"
      info "echo endpoint for Langflow: $ECHO_BASE_URL_RESOLVED"
    else
      die "could not resolve the echo endpoint: $(node -p "try{JSON.parse(process.argv[1]).error||''}catch{''}" "$decision" 2>/dev/null)"
    fi
  fi

  if [ "$WITH_OLLAMA" = "1" ]; then
    local out addr
    out="$(target_ssh "OLLAMA_PORT=$OLLAMA_PORT bash -s" < scripts/start-ollama-source.sh | tee "$RUN_DIR/logs/ollama-start.log")"
    addr="$(printf '%s\n' "$out" | awk -F= '/^OLLAMA_HOST_IP=/{print $2}')"
    OLLAMA_MODEL_RESOLVED="$(printf '%s\n' "$out" | awk -F= '/^OLLAMA_MODEL=/{print $2}')"
    [ -n "$addr" ] || die "the Ollama starter did not report OLLAMA_HOST_IP."
    [ -n "$TARGET_ADDR" ] || TARGET_ADDR="$addr"
    info "ollama: $addr:$OLLAMA_PORT (model ${OLLAMA_MODEL_RESOLVED:-<none>})"
  fi

  if [ -z "$TARGET_ADDR" ]; then
    TARGET_ADDR="$(target_ssh "ip -4 -o addr show scope global | awk '{print \$4}' | cut -d/ -f1 | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -1")"
    [ -n "$TARGET_ADDR" ] || die "could not determine the target's private address."
  fi
  info "target address: $TARGET_ADDR"
}

# ---------------------------------------------------------------------------
# PREP — job `prep`: duration-balanced shard matrix
# ---------------------------------------------------------------------------

phase_prep() {
  log "Computing the duration-balanced shard matrix"

  case "$SHARDS" in '' | *[!0-9]*) SHARDS=4 ;; esac
  [ "$SHARDS" -ge 1 ] || SHARDS=4

  # `--list` stdout is a machine contract: playwright.config.ts sends its warnings to
  # stderr precisely because of this (#1024).
  npx playwright test --grep "@stable" --list --reporter=json > "$RUN_DIR/stable-list.json"

  node scripts/partition-shards.mjs matrix \
    "$RUN_DIR/stable-list.json" reports/spec-durations.json "$SHARDS" > "$RUN_DIR/matrix.json"

  SHARD_TOTAL="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).shard_total" "$RUN_DIR/matrix.json")"
  info "$SHARD_TOTAL shard(s)"
}

# ---------------------------------------------------------------------------
# SHARD — one job of the `test` matrix
# ---------------------------------------------------------------------------

# Starts a backend on the target and HOLDS the session open, because it does not
# survive one that returns (see difference 2). The holder's stdout is the starter's,
# so the readiness line and any failure land in the shard's log.
start_backend_for_shard() {
  local idx="$1" port="$2"
  local holder_log="$RUN_DIR/logs/shard-$idx-backend.log"
  local bind_env=""
  [ "$LANGFLOW_TUNNEL" = "1" ] || bind_env="LANGFLOW_BIND_HOST=$TARGET_ADDR "

  # `sleep` outlives the run on purpose: the session must not close before the stop
  # script has run, and cleanup kills the holder afterwards. LANGFLOW_SRC_REPO is
  # explicit because the starter's default path is not where these machines keep the
  # clone, and its absence fails with the right message for the wrong reason.
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 $TARGET_SSH_OPTS "$TARGET_SSH" \
    "PATH=\$HOME/.local/bin:\$PATH LANGFLOW_SRC_REPO=\${LANGFLOW_SRC_REPO:-\$HOME/langflow} LANGFLOW_REQUIRE_BUILD_STAMP=$STAMP_REQUIRED ${bind_env}LANGFLOW_PORT=$port bash -s; sleep 86400" \
    < scripts/start-langflow-source.sh > "$holder_log" 2>&1 &
  HELD_SESSIONS+=("$!")

  local probe_host="localhost"
  [ "$LANGFLOW_TUNNEL" = "1" ] || probe_host="$TARGET_ADDR"
  local waited=0
  while [ "$waited" -lt "$BACKEND_START_TIMEOUT_S" ]; do
    if curl -sf --max-time 5 "http://${probe_host}:${port}/health_check" > /dev/null 2>&1; then
      info "shard $idx: backend ready on ${probe_host}:${port} after ${waited}s"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  err "shard $idx: the backend did not answer in ${BACKEND_START_TIMEOUT_S}s. Last lines:"
  tail -n 30 "$holder_log" >&2 || true
  return 1
}

# One working copy per shard — see difference 4. node_modules is a symlink because
# copying hundreds of megabytes per shard buys nothing; everything else is a real
# copy because collect-models writes into it.
prepare_shard_workdir() {
  local idx="$1" wd="$RUN_DIR/shard-$idx"
  rm -rf "$wd"; mkdir -p "$wd"
  tar -cf - \
    --exclude=node_modules --exclude=.git --exclude=runs \
    --exclude=playwright-report --exclude=blob-report --exclude=test-results \
    -C "$REPO_DIR" . | tar -xf - -C "$wd"
  ln -sfn "$REPO_DIR/node_modules" "$wd/node_modules"
}

run_shard() {
  local idx="$1" files="$2"
  local port=$((BASE_PORT + idx - 1))
  local host="localhost"
  [ "$LANGFLOW_TUNNEL" = "1" ] || host="$TARGET_ADDR"
  local base_url="http://${host}:${port}/"
  local wd="$RUN_DIR/shard-$idx"
  local pidfile="$RUN_DIR/logs/shard-$idx.pids"
  local log="$RUN_DIR/logs/shard-$idx.log"
  local status=0

  # First thing in the subshell, before anything that can fail: it inherited the
  # parent's EXIT trap, which stops every service of the run — one shard dying here
  # would take the others down with it. Replacing it also guarantees the background
  # recorders die with the shard even on a `set -e` abort.
  : > "$pidfile"
  trap 'while read -r p; do kill "$p" 2>/dev/null || true; done < "'"$pidfile"'"' EXIT

  start_backend_for_shard "$idx" "$port" || return 1
  prepare_shard_workdir "$idx"
  cd "$wd"

  local gh_env="$RUN_DIR/logs/shard-$idx.env"
  : > "$gh_env"

  export CI=true
  export PLAYWRIGHT_BASE_URL="$base_url"
  export PW_SHARD_FILE_LEVEL=1
  export PLAYWRIGHT_BLOB_OUTPUT_DIR="$wd/blob-report"
  export TOKENS_TIMEOUT_MS=8000 TOKENS_DETAIL_CAP=25 TOKENS_BUDGET_MS=15000
  # Both sides of the Ollama contract are the target's private address: the probe
  # runs here and reaches it over the network, and Langflow runs THERE and cannot use
  # loopback — its SSRF layer blocks it outright, whatever the allowlist says.
  if [ "$WITH_OLLAMA" = "1" ]; then
    export OLLAMA_BASE_URL="http://${TARGET_ADDR}:${OLLAMA_PORT}"
    export OLLAMA_BASE_URL_FROM_LANGFLOW="http://${TARGET_ADDR}:${OLLAMA_PORT}"
    export OLLAMA_TEST_MODEL="${OLLAMA_MODEL_RESOLVED:-llama3.2:1b}"
  fi
  # ABSENT, not empty. The specs resolve the endpoint with `??`, under which "" is a
  # value and does NOT fall through to the next link — the base stays empty and the
  # spec builds a broken URL that reads as a product failure.
  if [ -n "$ECHO_BASE_URL_RESOLVED" ]; then
    export ECHO_BASE_URL="$ECHO_BASE_URL_RESOLVED"
  else
    unset ECHO_BASE_URL
  fi

  # ---- Collect models ----------------------------------------------------
  # continue-on-error in the workflow (#980): a provider that will not configure is a
  # skip with a reason, not a red lane. Its outcome still feeds the gate below,
  # because it is what leaves the backend wedged (#922/#927).
  info "shard $idx: collect-models"
  local collect_outcome=success
  ( PLAYWRIGHT_RETRIES=0 PREFLIGHT_SKIP_CREDENTIALS=1 \
    npx playwright test tests/collect-models.spec.ts --reporter=line ) >> "$log" 2>&1 || collect_outcome=failure
  [ "$collect_outcome" = "success" ] || warn "shard $idx: collect-models failed (not blocking — see the log)."

  # ---- Health gate after collect-models ----------------------------------
  info "shard $idx: waiting for the backend to recover from the collect-models load"
  if ! WAIT_BASE_URL="$base_url" \
       WAIT_TIMEOUT_S="$RECOVER_TIMEOUT_S" \
       WAIT_NEXT_STEP_LABEL="the @stable round of shard $idx" \
       WAIT_ATTRIBUTION="NOT a test failure" \
       WAIT_COLLECT_MODELS_OUTCOME="$collect_outcome" \
       WAIT_PROBE_TIMEOUT_MS=8000 WAIT_INTERVAL_S=5 WAIT_HEARTBEAT_EVERY=6 \
       node scripts/wait-for-backend.mjs >> "$log" 2>&1; then
    err "shard $idx: the backend did not come back — aborting this shard (see logs/shard-$idx.log)."
    return 1
  fi

  # ---- Background recorders ----------------------------------------------
  WATCH_URL="http://${host}:${port}/api/v1/version" \
  WATCH_OUT="$wd/backend-liveness.jsonl" \
  WATCH_INTERVAL_MS=2000 WATCH_TIMEOUT_MS=4000 WATCH_MAX_SECONDS=3600 \
    nohup node scripts/watch-backend.mjs > "$RUN_DIR/logs/shard-$idx-liveness.log" 2>&1 &
  local liveness_pid=$!
  echo "$liveness_pid" >> "$pidfile"

  # Provider rotation by weekday (#1185). Writes MODEL_TEST_ID/MODEL_TEST_PROVIDER.
  GITHUB_ENV="$gh_env" node scripts/select-daily-model-target.mjs >> "$log" 2>&1 \
    || warn "shard $idx: provider rotation failed (the lane stays multi-provider)."
  # shellcheck disable=SC1090
  if [ -s "$gh_env" ]; then set -a; . "$gh_env"; set +a; fi

  TOKENS_BASE_URL="http://${host}:${port}" \
  TOKENS_OUT="$wd/token-probes-${idx}.jsonl" \
  TOKENS_INTERVAL_MS=15000 TOKENS_MAX_SECONDS=3600 \
    nohup node scripts/watch-tokens.mjs > "$RUN_DIR/logs/shard-$idx-tokens.log" 2>&1 &
  local tokens_pid=$!
  echo "$tokens_pid" >> "$pidfile"

  # ---- The round ----------------------------------------------------------
  info "shard $idx: running @stable"
  # shellcheck disable=SC2086
  ( PLAYWRIGHT_RETRIES="$RETRIES" \
    TOKENS_ATTRIB="$wd/token-attrib-${idx}.jsonl" \
    npx playwright test --grep "@stable" --pass-with-no-tests $files ) >> "$log" 2>&1 || status=$?

  # ---- Collection (what upload-artifact did) ------------------------------
  kill "$liveness_pid" 2>/dev/null || true
  sleep 3
  mkdir -p "$RUN_DIR/all-liveness/liveness-$idx"
  WATCH_OUT="$wd/backend-liveness.jsonl" \
  WATCH_SUMMARY="$RUN_DIR/all-liveness/liveness-$idx/backend-liveness.json" \
  WATCH_LABEL="$idx" WATCH_FILES="$files" \
    node scripts/watch-backend.mjs --summarize >> "$log" 2>&1 || true
  cp "$wd/backend-liveness.jsonl" "$RUN_DIR/all-liveness/liveness-$idx/" 2>/dev/null || true

  kill "$tokens_pid" 2>/dev/null || true
  sleep 10
  cp "$wd/token-probes-${idx}.jsonl" "$RUN_DIR/all-tokens/" 2>/dev/null || true
  cp "$wd/token-attrib-${idx}.jsonl" "$RUN_DIR/all-tokens/" 2>/dev/null || true
  printf '%s' "${MODEL_TEST_PROVIDER:-}" > "$RUN_DIR/all-tokens/token-provider-${idx}.txt"

  curl -sf --connect-timeout 5 --max-time 15 "http://${host}:${port}/api/v1/version" \
    > "$RUN_DIR/logs/shard-$idx-version.json" 2>/dev/null || true

  # Blobs renamed per shard: without --shard Playwright names them all alike, and the
  # merge reads the whole directory regardless of file name.
  local blob found=0
  for blob in "$wd/blob-report"/*.zip; do
    [ -e "$blob" ] || continue
    cp "$blob" "$RUN_DIR/all-blobs/shard-${idx}-$(basename "$blob")"
    found=1
  done
  [ "$found" = "1" ] || err "shard $idx: produced no blob."

  target_ssh "LANGFLOW_PORT=$port bash -s" < "$REPO_DIR/scripts/stop-langflow-source.sh" >> "$log" 2>&1 || true
  return $status
}

phase_shards() {
  log "Running $SHARD_TOTAL shard(s)"

  local pids=() idxs=() i files
  for i in $(seq 1 "$SHARD_TOTAL"); do
    files="$(node -p "
      const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
      (m.include.find(s => String(s.shard) === process.argv[2]) || {}).files || ''
    " "$RUN_DIR/matrix.json" "$i")"
    if [ -z "$files" ]; then
      warn "shard $i has no files in the matrix — skipping."
      continue
    fi
    ( run_shard "$i" "$files" ) &
    pids+=("$!"); idxs+=("$i")
    # Staggered: four backends building and booting at once fight over the target's I/O.
    sleep 10
  done

  TEST_JOB_FAILED=0
  local n
  for n in "${!pids[@]}"; do
    if wait "${pids[$n]}"; then
      info "shard ${idxs[$n]}: OK"
    else
      TEST_JOB_FAILED=1
      warn "shard ${idxs[$n]}: FAILED"
    fi
  done
  cd "$REPO_DIR"
}

# ---------------------------------------------------------------------------
# MERGE — job `merge`
# ---------------------------------------------------------------------------

phase_merge() {
  log "Merging the shard reports"
  cd "$REPO_DIR"

  local outputs="$RUN_DIR/logs/merge-outputs.txt"
  : > "$outputs"

  # Guard 1 — did every expected shard produce a blob? (counts FILES)
  local found
  found="$(find "$RUN_DIR/all-blobs" -maxdepth 1 -name '*.zip' | wc -l | tr -d ' ')"
  SHARD_COMPLETE=true
  if [ "$found" -lt "$SHARD_TOTAL" ]; then
    warn "only $found/$SHARD_TOTAL blobs present — the merged report is INCOMPLETE (a shard died before reporting). Failures may be undercounted."
    SHARD_COMPLETE=false
  else
    info "$found/$SHARD_TOTAL blobs present"
  fi

  PLAYWRIGHT_JSON_OUTPUT_NAME="$RUN_DIR/results.json" \
  PLAYWRIGHT_HTML_REPORT="$RUN_DIR/playwright-report" \
    npx playwright merge-reports --reporter=html,json "$RUN_DIR/all-blobs" > /dev/null

  # Guard 2 — does the report contain RESULTS? A valid, empty blob passes guard 1 and
  # reaches triage looking benign (#1012).
  PLAYWRIGHT_JSON="$RUN_DIR/results.json" GITHUB_OUTPUT="$outputs" \
    node scripts/check-run-integrity.mjs || true
  RUN_EMPTY="$(gh_out "$outputs" empty)";     RUN_EMPTY="${RUN_EMPTY:-true}"
  RUN_PARTIAL="$(gh_out "$outputs" partial)"; RUN_PARTIAL="${RUN_PARTIAL:-false}"
  RUN_UNREADABLE="$(gh_out "$outputs" unreadable)"
  RUN_TESTS="$(gh_out "$outputs" tests_total)"
  RUN_ERRORS="$(gh_out "$outputs" report_errors)"
  RUN_FIRST_ERROR="$(gh_out "$outputs" first_error)"

  # Mid-run backend outages: the cause has to come BEFORE the per-test material, or
  # triage starts from the collateral specs (#1030).
  LIVENESS_DIR="$RUN_DIR/all-liveness" PLAYWRIGHT_JSON="$RUN_DIR/results.json" \
  SHARD_TOTAL="$SHARD_TOTAL" GITHUB_OUTPUT="$outputs" \
    node scripts/report-backend-outages.mjs || true
  LIVENESS_MEASURED="$(gh_out "$outputs" measured)"
  LIVENESS_WEDGED="$(gh_out "$outputs" wedged)"
  LIVENESS_MD="$(gh_out "$outputs" summary_md)"
  LIVENESS_OUTAGES="$(gh_out "$outputs" outages_total)"
  LIVENESS_DOWN_SECONDS="$(gh_out "$outputs" down_seconds_total)"

  # The version that actually served. Sweeping every shard avoids ending up without
  # one just because shard 1 was the one that died.
  LANGFLOW_VERSION=""
  local vfile
  for vfile in "$RUN_DIR"/logs/shard-*-version.json; do
    [ -s "$vfile" ] || continue
    LANGFLOW_VERSION="$(node -p "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version||''}catch{''}" "$vfile" 2>/dev/null || echo "")"
    [ -n "$LANGFLOW_VERSION" ] && break
  done

  # The comparison this step exists for. A mismatch is reported, not fatal: while the
  # clone is moved by hand, failing here would throw away a day of otherwise usable
  # data. REQUIRE_TARGET_VERSION=1 flips that once the run moves the clone itself.
  TARGET_VERSION_MATCH="unchecked"; TARGET_VERSION_REASON=""
  if [ "$CHECK_TARGET_VERSION" = "1" ] && [ -n "$TARGET_EXPECTED_VERSION" ]; then
    local compared
    compared="$(node scripts/resolve-target-version.mjs --compare "$TARGET_EXPECTED_VERSION" "${LANGFLOW_VERSION:-}" "$TARGET_RESOLUTION" 2>/dev/null || true)"
    TARGET_VERSION_MATCH="${compared%%	*}"
    TARGET_VERSION_REASON="${compared#*	}"
    case "$TARGET_VERSION_MATCH" in
      yes | cycle) info "target version: $TARGET_VERSION_MATCH — $TARGET_VERSION_REASON" ;;
      no)
        warn "TARGET VERSION MISMATCH (by $TARGET_RESOLUTION) — $TARGET_VERSION_REASON"
        warn "Every product difference between those two lands in this run's verdict, and"
        warn "the comparison with the Actions daily will read it as an environment"
        warn "divergence. Move the clone to $TARGET_EXPECTED_REF and rebuild before"
        warn "treating today's differences as findings."
        ;;
      *) warn "target version: could not be compared — $TARGET_VERSION_REASON" ;;
    esac
  fi

  # Both versions in one place, because the whole point of this lane is comparing a
  # verdict with the CI's and neither number is guessable afterwards.
  node -e '
    const fs = require("fs");
    const [out, ...kv] = process.argv.slice(1);
    const o = {};
    for (let i = 0; i < kv.length; i += 2) o[kv[i]] = kv[i + 1];
    fs.writeFileSync(out, JSON.stringify(o, null, 2) + "\n");
  ' "$RUN_DIR/run-metadata.json" \
    run_id "$RUN_ID" \
    suite_sha "$(git rev-parse HEAD)" \
    suite_branch "$(git rev-parse --abbrev-ref HEAD)" \
    langflow_version "${LANGFLOW_VERSION:-}" \
    langflow_expected_version "${TARGET_EXPECTED_VERSION:-}" \
    langflow_expected_ref "${TARGET_EXPECTED_REF:-}" \
    langflow_expected_sha "${TARGET_EXPECTED_SHA:-}" \
    langflow_version_resolution "${TARGET_RESOLUTION:-}" \
    langflow_version_match "${TARGET_VERSION_MATCH:-unchecked}" \
    langflow_prepared_sha "${TARGET_PREPARED_SHA:-}" \
    langflow_prepared_rebuilt "${TARGET_REBUILT:-no}" \
    langflow_prepared_reason "${TARGET_REBUILD_REASON:-}" \
    langflow_prepare_seconds "${TARGET_PREPARE_S:-}" \
    shards "$SHARD_TOTAL" \
    tunnel "$LANGFLOW_TUNNEL" \
    tests_total "${RUN_TESTS:-0}"

  info "tests: ${RUN_TESTS:-0} | top-level errors: ${RUN_ERRORS:-0} | empty: $RUN_EMPTY | partial: $RUN_PARTIAL"
  info "Langflow: ${LANGFLOW_VERSION:-<unknown>}"
}

# ---------------------------------------------------------------------------
# PUBLISH
# ---------------------------------------------------------------------------

phase_publish() {
  cd "$REPO_DIR"

  # Built ALWAYS, even with every POST disabled: it is the only analysis of the merged
  # report into totals and failures, and the Slack notifier reads it rather than
  # carrying a second parser that can disagree with the first.
  log "Building the run payload"
  local stable_count total_count
  stable_count="$(npx ts-node scripts/stable-tests.ts --count 2>/dev/null || echo "")"
  total_count="$(grep -rE '^\s*test\s*\(' tests/tests-automations/regression --include='*.spec.ts' | wc -l | tr -d ' ')"

  PLAYWRIGHT_JSON="$RUN_DIR/results.json" \
  WORKFLOW="$WORKFLOW_ID" \
  GITHUB_RUN_ID="$RUN_ID" \
  RUN_URL="$REPORT_URL" \
  LANGFLOW_VERSION="$LANGFLOW_VERSION" \
  STABLE_COUNT="$stable_count" \
  TOTAL_COUNT="$total_count" \
  EVIDENCE_URL="$REPORT_URL" \
    node scripts/build-run-payload.mjs > "$RUN_DIR/payload.json"
  info "payload: $RUN_DIR/payload.json"

  if [ "$POST_QA_PLATFORM" = "1" ]; then
    if [ -z "${QA_PLATFORM_ENDPOINT:-}" ] || [ -z "${QA_E2E_AUTOMATION_TOKEN:-}" ]; then
      warn "QA_PLATFORM_ENDPOINT/QA_E2E_AUTOMATION_TOKEN are not set — POST skipped."
    else
      local code
      code="$(curl -s -o "$RUN_DIR/logs/qa-platform-response.json" -w '%{http_code}' \
        -X POST "$QA_PLATFORM_ENDPOINT" \
        -H "Authorization: Bearer $QA_E2E_AUTOMATION_TOKEN" \
        -H "Content-Type: application/json" \
        --data @"$RUN_DIR/payload.json")"
      case "$code" in
        200 | 201) info "QA Platform: recorded (HTTP $code)" ;;
        *) warn "the QA Platform POST failed (HTTP $code) — this does not fail the run." ;;
      esac
    fi
  fi

  if [ "$REFRESH_DURATIONS" = "1" ] && [ "$RUN_EMPTY" = "false" ] && [ "$RUN_PARTIAL" = "false" ]; then
    log "Refreshing reports/spec-durations.json"
    local next="$RUN_DIR/spec-durations.next.json"
    if node scripts/partition-shards.mjs extract "$RUN_DIR/results.json" reports/spec-durations.json > "$next"; then
      mv "$next" reports/spec-durations.json
    else
      warn "duration extraction FAILED — spec-durations.json is left as it was (#1252)."
    fi
  fi

  TOKENS_DIR="$RUN_DIR/all-tokens" node scripts/watch-tokens.mjs --summarize \
    > "$RUN_DIR/logs/token-summary.log" 2>&1 || warn "the token summary failed (not blocking)."

  if [ "$COMMIT_HISTORY" = "1" ] && [ "$EVENT_NAME" = "schedule" ]; then
    log "Recording the daily history"
    PLAYWRIGHT_JSON="$RUN_DIR/results.json" \
    HISTORY_FILE=reports/daily-history.jsonl \
    WORKFLOW="$WORKFLOW_ID" \
    GITHUB_RUN_ID="$RUN_ID" \
      node scripts/append-weekly-history.mjs || warn "history append failed (not blocking)."
  fi

  # Off in this etapa, by design: while the VM daily runs beside the Actions one, only
  # the Actions verdict has consequence. Two issues for one day would be worse than
  # none, and the comparison is the product here — not the alert.
  if [ "$CREATE_ISSUE" = "1" ] && [ "$EVENT_NAME" = "schedule" ] \
    && { [ "$TEST_JOB_FAILED" = "1" ] || [ "$RUN_EMPTY" = "true" ]; }; then
    log "Opening the failure issue"
    RUN_ID="$RUN_ID" RUN_DIR="$RUN_DIR" \
    RUN_EMPTY="$RUN_EMPTY" RUN_UNREADABLE="$RUN_UNREADABLE" RUN_PARTIAL="$RUN_PARTIAL" \
    RUN_ERRORS="$RUN_ERRORS" RUN_FIRST_ERROR="$RUN_FIRST_ERROR" RUN_TESTS="$RUN_TESTS" \
    LIVENESS_MD="$LIVENESS_MD" \
      node scripts/create-failure-issue.mjs || warn "issue creation failed (does not fail the run)."
  fi

  # Same condition as the issue, deliberately: the message and the issue are two views
  # of one verdict and must not disagree. Fail-soft — a notifier is never allowed to be
  # the reason a run reports failure.
  if [ "$NOTIFY_SLACK" = "1" ] && [ "$EVENT_NAME" = "schedule" ] \
    && { [ "$TEST_JOB_FAILED" = "1" ] || [ "$RUN_EMPTY" = "true" ]; }; then
    log "Notifying Slack"
    local issue_url=""
    [ -f "$RUN_DIR/issue-url.txt" ] && issue_url="$(cat "$RUN_DIR/issue-url.txt")" || true
    PAYLOAD_JSON="$RUN_DIR/payload.json" \
    RUN_EMPTY="$RUN_EMPTY" RUN_PARTIAL="$RUN_PARTIAL" RUN_UNREADABLE="$RUN_UNREADABLE" \
    RUN_ERRORS="$RUN_ERRORS" RUN_TESTS="$RUN_TESTS" RUN_FIRST_ERROR="$RUN_FIRST_ERROR" \
    LIVENESS_MEASURED="$LIVENESS_MEASURED" LIVENESS_WEDGED="$LIVENESS_WEDGED" \
    LIVENESS_OUTAGES="$LIVENESS_OUTAGES" LIVENESS_DOWN_SECONDS="$LIVENESS_DOWN_SECONDS" \
    ISSUE_URL="$issue_url" REPORT_URL="$REPORT_URL" RUN_ID="$RUN_ID" \
    LANGFLOW_VERSION="$LANGFLOW_VERSION" \
      node scripts/notify-slack.mjs || warn "the Slack notification failed (does not fail the run)."
  fi
}

# ---------------------------------------------------------------------------
# VERDICT — "Fail scheduled run on an incomplete, empty or partial report"
# ---------------------------------------------------------------------------

phase_verdict() {
  log "Verdict"
  info "report:   $RUN_DIR/playwright-report/index.html"
  info "results:  $RUN_DIR/results.json"
  info "metadata: $RUN_DIR/run-metadata.json"

  local failed=0
  if [ "${RUN_EMPTY:-true}" = "true" ]; then
    err "ZERO tests executed — an infrastructure abort, not a test failure. Triage: find out why nothing ran, not which test broke."
    [ -n "${RUN_FIRST_ERROR:-}" ] && err "first error: $RUN_FIRST_ERROR"
    failed=1
  elif [ "${RUN_PARTIAL:-false}" = "true" ]; then
    err "PARTIAL run — ${RUN_TESTS:-0} result(s) but ${RUN_ERRORS:-0} top-level error(s): a shard aborted before running its specs. The totals are UNDERCOUNTED."
    failed=1
  elif [ "${SHARD_COMPLETE:-true}" = "false" ]; then
    err "INCOMPLETE report — a shard blob is missing."
    failed=1
  fi
  if [ "${TEST_JOB_FAILED:-0}" = "1" ]; then
    err "at least one shard had a failing test."
    failed=1
  fi
  if [ "$REQUIRE_TARGET_VERSION" = "1" ]; then
    case "${TARGET_VERSION_MATCH:-unchecked}" in
      no)
        if [ "${TARGET_RESOLUTION:-}" = "published-image" ]; then
          err "the target served the wrong Langflow — ${TARGET_VERSION_REASON:-no reason recorded}."
          err "REQUIRE_TARGET_VERSION=1 makes that fatal: a comparison between different"
          err "products describes the changelog, not the environments."
        else
          # The expectation came from the git refs, which run AHEAD of what shipped —
          # upstream tags before it builds. So this may not be a real mismatch, and
          # asserting one would be asserting something the source cannot support. It
          # still fails under REQUIRE, because an expectation that cannot be trusted is
          # not a guarantee either; what changes is the claim.
          err "the version check could not be established authoritatively: the expectation"
          err "came from ${TARGET_RESOLUTION:-an unknown resolution}, not from the published image, and that"
          err "source runs ahead of what shipped. Reported difference: ${TARGET_VERSION_REASON:-none recorded}."
          err "REQUIRE_TARGET_VERSION=1 asks for a guarantee the registry was silent about."
        fi
        failed=1
        ;;
      yes | cycle) ;;
      *)
        # "Require" has to require. Every way the check itself can fail — the registry
        # or github unreachable, the resolver erroring, the target reporting no version
        # — lands here, and passing green on those is passing green precisely when
        # nobody can tell whether the two lanes ran the same product.
        err "the version check could not be performed (${TARGET_VERSION_MATCH:-unchecked}${TARGET_VERSION_REASON:+: $TARGET_VERSION_REASON})."
        err "REQUIRE_TARGET_VERSION=1 asks for a guarantee, and an unperformed check is"
        err "not a weaker guarantee — it is none. Set CHECK_TARGET_VERSION=1 and make the"
        err "resolution work, or drop REQUIRE_TARGET_VERSION."
        failed=1
        ;;
    esac
  fi
  [ "$failed" = "0" ] && log "Green run." || true
  return $failed
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

main() {
  log "Daily @stable on the VMs — run $RUN_ID"
  info "shards: $SHARDS   tunnel: $LANGFLOW_TUNNEL   event: $EVENT_NAME"

  phase_preflight
  phase_hygiene
  phase_services
  phase_prep

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN=1 — stopping after the partition."
    return 0
  fi

  phase_shards
  phase_merge
  phase_publish
  phase_verdict
}

# Sourcing guard: `source scripts/run-e2e.sh` exercises the functions in isolation.
# The exit-code contract of phase_verdict is tested that way, with no machines and no
# real run — which is the only way that contract gets covered at all.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
