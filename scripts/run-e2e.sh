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
#     "Append daily history"            |   the same appenders, writing to the LEDGER
#     "Commit daily history"            |   nothing — see difference 6
#   "Fail scheduled run on ..."         | phase_verdict
#
# ## The six differences that matter
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
# 6. THE THREE SERIES ARE WRITTEN, NOT COMMITTED. daily-history.jsonl,
#    token-history.jsonl and spec-durations.json are appended to a LEDGER outside the
#    clone rather than to `reports/`, and no commit happens here at all. Writing inside
#    the clone would leave the tree dirty, and the wrapper's `git pull --ff-only` then
#    refuses the next morning — the protection working exactly as designed, against
#    us. Committing them back is a later etapa's job and is absent code today, not a
#    switch set to zero: a switch reads as implemented and disabled.
#
# ## Usage
#
#   TARGET_SSH=<ssh-alias> ./scripts/run-e2e.sh              # 4 shards
#   TARGET_SSH=<alias> SHARDS=2 ./scripts/run-e2e.sh
#   TARGET_SSH=<alias> DRY_RUN=1 ./scripts/run-e2e.sh        # preflight + partition only
#   TARGET_SSH=<alias> KEEP_LEDGER=0 ./scripts/run-e2e.sh    # a smoke: record nothing
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

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUNS_ROOT="${RUNS_ROOT:-$REPO_DIR/runs}"
RUN_DIR="$RUNS_ROOT/$RUN_ID"
RUNS_KEEP="${RUNS_KEEP:-30}"
RUN_URL_BASE="${RUN_URL_BASE:-file://$RUNS_ROOT}"
REPORT_URL="$RUN_URL_BASE/$RUN_ID/playwright-report/index.html"
EVENT_NAME="${EVENT_NAME:-schedule}"
WORKFLOW_ID="${WORKFLOW_ID:-daily-stable-vm}"

# ---------------------------------------------------------------------------
# THE LEDGER — the three series this lane has to keep
# ---------------------------------------------------------------------------
# reports/daily-history.jsonl, reports/token-history.jsonl and
# reports/spec-durations.json only grow because the Actions daily writes them, and the
# next etapa turns that daily off. Nothing else appends, so the gap would run from
# there to the day this lane commits: build-triage-dataset.mjs would read a base that
# starts partial, and the shard matrix — which balances by measured duration — would
# degrade with it, both for a reason no run reports. This lane starts keeping the three
# now, while the Actions series is still complete enough to seed from.
#
# OUTSIDE the clone, and that is not a preference. `reports/` is tracked, so a run that
# writes there leaves the tree dirty and the wrapper's next `git pull --ff-only`
# refuses — and that refusal is a guarantee worth keeping, not an obstacle: it is what
# stops a machine from silently discarding local work. So the series moves, not the
# protection. ledger_dir_is_outside_repo() checks it rather than trusting the default,
# because the cost of getting it wrong is paid once a day, quietly, by the pull.
#
# WORKFLOW_ID above is what keeps the two eras apart inside one file: every line this
# lane writes carries `daily-stable-vm`, so the Actions rows stay distinguishable after
# the two series are merged.
KEEP_LEDGER="${KEEP_LEDGER:-1}"
# `$XDG_STATE_HOME` is the right shelf for this: state that must survive between runs,
# is not a cache (losing it loses history), and is not config. Empty rather than a
# fallback path when neither variable is set — an unwritable ledger is refused in
# preflight, where it costs a variable, instead of guessed at into a directory nobody
# looks in.
LEDGER_HOME="${XDG_STATE_HOME:-${HOME:+$HOME/.local/state}}"
LEDGER_DIR="${LEDGER_DIR:-${LEDGER_HOME:+$LEDGER_HOME/langflow-e2e}}"
# DERIVED, never taken from the environment. As overridable variables they were a hole
# straight through the guard above: `LEDGER_DIR` pointing somewhere legal and
# `LEDGER_HISTORY` pointing at reports/daily-history.jsonl passed preflight with exit 0
# and then handed the tracked file to the appender — the dirty tree this whole change
# exists to prevent, reached through a variable the script itself exposed. Checking
# their parents too would have closed it; deriving them removes the state instead, and
# LEDGER_DIR is the one knob a machine ever needs.
LEDGER_HISTORY="${LEDGER_DIR:+$LEDGER_DIR/daily-history.jsonl}"
LEDGER_TOKENS="${LEDGER_DIR:+$LEDGER_DIR/token-history.jsonl}"
LEDGER_DURATIONS="${LEDGER_DIR:+$LEDGER_DIR/spec-durations.json}"
# The READ side, and it stays off here on purpose. While both dailies run, the product
# is a comparison, and a matrix balanced by VM-measured durations puts specs on
# different shards than the Actions lane does — so a failure's neighbours differ for a
# reason that has nothing to do with the product. It turns on when the Actions daily
# stops and the comparison is over. (Step 11 may want it earlier, with SHARDS above 1
# and the comparison narrowed on purpose; that is a measurement decision, not a
# default.)
USE_LEDGER_DURATIONS="${USE_LEDGER_DURATIONS:-0}"

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
# Enforced by default since 2026-09-03, because the two conditions it was waiting for
# both hold: this run PLACES the clone (see PREPARE_TARGET below), so a mismatch is no
# longer somebody forgetting to move it by hand; and a source instance at v1.13.0.dev1
# was smoked and reports `1.13.0.dev1` — the exact string the published-image strategy
# expects, so enforcement cannot fail a correctly placed clone over a formatting
# difference. Set to 0 to diagnose against a deliberately mismatched target.
REQUIRE_TARGET_VERSION="${REQUIRE_TARGET_VERSION:-1}"
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
# Forwarded to the preparer, which refuses a clone carrying somebody's uncommitted
# work. Exposed here because without it the only way past one stray file on a shared
# VM is PREPARE_TARGET=0, which switches the whole placement off to get past it.
PREPARE_TARGET_ALLOW_DIRTY="${PREPARE_TARGET_ALLOW_DIRTY:-0}"
# The stamp is only demanded when this run is the thing that wrote it. A clone
# prepared by hand carries no stamp, and refusing it there would break the one
# workflow that has to keep working while this is being adopted.
#
# This is the INTENT. What is actually demanded is decided in phase_preflight from
# what the preparation step really DID — see stamp_demand_for_plan(). The two differ
# whenever the resolution could not name a commit: demanding the stamp there fails
# the start with "no build stamp" over a cause that belonged to the resolver, which
# sends the operator to the wrong machine.
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
# THE DAILY'S SERVICE ENVIRONMENT, MIRRORED
# ---------------------------------------------------------------------------
# daily-stable.yml configures the instance under test through its service `env:` block.
# Everything there that is right for ANY local instance already lives in the starters;
# what is chosen FOR THIS LANE belongs here, in the file whose declared job is
# mirroring that workflow. The split is not a preference: the starters' env blocks are
# asserted identical to start-langflow-pip.sh's precisely so a spec cannot tell which
# starter brought its instance up, and a lane-specific value written there would either
# break that assertion or defeat its purpose (#1716's relocation).
#
# How these actually arrive, stated precisely because the first draft of this comment
# was wrong and the error was load-bearing. Each is passed as a `VAR=value` prefix on
# the remote `bash -s`, which puts it in THAT shell's environment, and the starter
# inherits it. The starter does not need to name them — but if it DOES name one with a
# literal, its own `uv run` prefix assignment REPLACES the inherited value for that name
# instead of adding to it, and what this file sends never reaches the server. Nothing
# turns red when that happens: it is the silent half of #1717, one layer down. So the
# rule is checked rather than trusted — scripts/check-vm-env-parity.mjs refuses a
# mirrored name that start-langflow-source.sh's launch block sets to anything other than
# `${NAME:-…}`, which is the shape that lets the caller's value win.
#
# Every value is overridable, and an override is how a MACHINE records a measured
# exception — the qa VM overrides tracing while #1720 is open, with the reason written
# beside it. What is pinned here is the DEFAULT: scripts/check-vm-env-parity.mjs fails
# when the workflow gains a service variable this file neither carries nor classifies,
# and run-e2e.test.mjs reads each default OUT OF the workflow instead of out of a copy,
# so a value changed there cannot leave this one behind (#1717).

# Rejecting a value that is neither `true` nor `false` instead of passing it through:
# these flags read anything that is not "true" as false, so `0`, `FALSE` or a value
# carrying a space would go in silently and invert the setting with nothing said —
# #1714's failure class, arriving through the caller rather than through a file.
require_bool() {
  case "$2" in
    true | false) ;;
    *) echo "$1 must be exactly 'true' or 'false', got: '$2'" >&2; exit 1 ;;
  esac
}

# Tracing ON, because daily-stable.yml runs with it on and the traces/observability
# specs assert against a traced instance. Both starters default it OFF — right for a
# developer's own instance, wrong for the lane that has to match CI. Measured, not
# assumed: on 2026-09-04 nine @stable specs failed on the VM while the same day's
# Actions daily was green, for no reason other than this variable (#1714).
LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-false}"
require_bool LANGFLOW_DEACTIVATE_TRACING "$LANGFLOW_DEACTIVATE_TRACING"

# Caps what ONE wedge costs (#1048). The value is a heartbeat watchdog on the event
# loop, not a per-request deadline, and a wedged worker never recovers on its own. Not
# a starter default: 120 is chosen for THIS lane's load, and a developer's instance has
# no reason to inherit it. Read daily-stable.yml's comment before changing it — it
# records why the product's own docs argue for the opposite and are wrong.
LANGFLOW_WORKER_TIMEOUT="${LANGFLOW_WORKER_TIMEOUT:-120}"
case "$LANGFLOW_WORKER_TIMEOUT" in
  '' | *[!0-9]*) echo "LANGFLOW_WORKER_TIMEOUT must be a positive integer of seconds, got: '$LANGFLOW_WORKER_TIMEOUT'" >&2; exit 1 ;;
esac
[ "$LANGFLOW_WORKER_TIMEOUT" -gt 0 ] || { echo "LANGFLOW_WORKER_TIMEOUT must be greater than zero." >&2; exit 1; }

# The workflow sets this to OVERRIDE a default the nightly image bakes in (`false`, a
# security default). A source instance bakes in nothing, so the two lanes agree today
# for DIFFERENT REASONS — measured on 2026-09-04, the custom-component specs pass 8/8
# on the VM without it. Mirrored anyway, and that is exactly #1717's point: latent
# agreement is the half of this class no run can report, because the day the product
# default moves, only one lane notices.
LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}"
require_bool LANGFLOW_ALLOW_CUSTOM_COMPONENTS "$LANGFLOW_ALLOW_CUSTOM_COMPONENTS"

# `foreign_keys: ON`. The dict replaces the product default wholesale, so the default
# pragmas are repeated here rather than merged. This is the SILENT half of #1717: with
# SQLite foreign keys off, a cascade/orphan defect (upstream #13955, the span -> trace
# FK) leaves the raw DELETE "succeeding" with orphaned rows, so traces-delete-cascade
# passes on the VM and fails on Actions. This lane's entire product is the comparison
# between those two verdicts, so this one cannot be found by running anything: it
# produces agreement, not failure.
DEFAULT_SQLITE_PRAGMAS='{"synchronous": "NORMAL", "journal_mode": "WAL", "busy_timeout": 30000, "foreign_keys": "ON"}'
LANGFLOW_SQLITE_PRAGMAS="${LANGFLOW_SQLITE_PRAGMAS:-$DEFAULT_SQLITE_PRAGMAS}"
# Parseability, not content. Malformed JSON is never intentional and Langflow falls
# back to its own defaults without saying so — this variable's failure mode arriving
# through the caller. WHICH pragmas are set stays the operator's call, for the same
# reason the tracing override is: a machine may need a measured exception, and it
# records the reason where it makes it.
node -e 'const v=process.argv[1];let p;try{p=JSON.parse(v)}catch(e){console.error("LANGFLOW_SQLITE_PRAGMAS is not valid JSON ("+e.message+"): "+v);process.exit(1)}if(p===null||typeof p!=="object"||Array.isArray(p)){console.error("LANGFLOW_SQLITE_PRAGMAS must be a JSON object, got: "+v);process.exit(1)}' \
  "$LANGFLOW_SQLITE_PRAGMAS"

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

# Shell-quote a value for the shell on the OTHER side of ssh. ssh joins its arguments
# with spaces and hands ONE string to a shell over there, so anything unquoted is
# re-split on arrival. Every mirrored value used to be a bare word and survived that;
# LANGFLOW_SQLITE_PRAGMAS is a JSON object, and unquoted it would set the variable to
# `{"synchronous":` and feed the remaining five words to `bash -s` as arguments.
# Single quotes, closed and reopened around each embedded one (`'\''`) — the POSIX
# form, so it does not depend on the login shell ssh happens to start over there, and
# it stays readable in a log. `printf %q` round-trips too, but its output is
# bash-specific and unreadable at a glance.
#
# Written with sed rather than `${1//\'/…}` because the parameter-expansion form is
# what the first version used and it was WRONG: inside double quotes the backslashes
# are consumed twice, and it produced `'it\'\\'\'s'`, which does not parse at all. No
# mirrored value carries a quote today — this would arrive the day someone overrides
# one from a wrapper, and the failure would be a syntax error in a remote command
# nobody ever printed.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The environment the target's shell must carry for its instance to match the one
# daily-stable.yml's service brings up — see THE DAILY'S SERVICE ENVIRONMENT above for
# why each value lives here and not in the starter.
#
# A function rather than a string spelled into the ssh line, so the unit tests can read
# exactly what would be sent, quoting included, without a machine to send it to. The
# trailing space is part of the contract: the caller concatenates.
mirrored_target_env() {
  printf '%s' \
    "LANGFLOW_DEACTIVATE_TRACING=$(shq "$LANGFLOW_DEACTIVATE_TRACING") " \
    "LANGFLOW_WORKER_TIMEOUT=$(shq "$LANGFLOW_WORKER_TIMEOUT") " \
    "LANGFLOW_ALLOW_CUSTOM_COMPONENTS=$(shq "$LANGFLOW_ALLOW_CUSTOM_COMPONENTS") " \
    "LANGFLOW_SQLITE_PRAGMAS=$(shq "$LANGFLOW_SQLITE_PRAGMAS") "
}

# Should this run place the target's clone, and if not, why not?
#
# Split out of phase_preflight so the decision is testable without ssh — the phase
# around it fetches, curls and runs `npm ci`, so the only reachable alternative was a
# regex over this file, and a guard that pins a spelling does not pin a behaviour.
#
# The answer turns on a resolved COMMIT and never on the ref, which is the whole point.
# scripts/resolve-target-version.mjs returns `ok: true` with an EMPTY sha in two states
# it can neither help nor hide: the github ref listing unreachable or partial (the
# registry alone answers the version, not the commit), and the nightly tag deleted and
# not yet recreated — which upstream does routinely. In both it still reports a ref,
# `v1.13.0.dev1`. Handing that name to the preparer as a checkout target asks it for a
# tag the resolver has just said it could not find, so it refuses and the run dies at
# preflight — before phase_publish, so with no report at all. That is strictly worse
# than the red-with-a-report the version gate produces on its own, and it hands
# github.com the veto the resolution deliberately took away from it.
target_preparation_plan() {
  if [ "${PREPARE_TARGET:-1}" != "1" ]; then
    echo "off"
  elif [ "${CHECK_TARGET_VERSION:-1}" != "1" ]; then
    # Placement obeys a resolution, so switching the resolution off switches placement
    # off with it. Distinguished from "unresolved" so the operator who asked for this
    # is not warned about a failure that is their own configuration.
    echo "off"
  elif [ -n "${TARGET_EXPECTED_SHA:-}" ]; then
    echo "prepare"
  elif [ -n "${TARGET_EXPECTED_VERSION:-}" ]; then
    # The version is known and authoritative; only its commit is not. Distinguished
    # from the unresolved case because it sends the reader somewhere else entirely.
    echo "skip-no-commit"
  else
    echo "skip-unresolved"
  fi
  return 0
}

# Whether the starter must REFUSE an unstamped build, given what preparation actually
# did. Only a run that placed and rebuilt the clone wrote a stamp, so only that run is
# entitled to demand one; anywhere else the demand fails the start over a missing file
# this run never undertook to create.
stamp_demand_for_plan() {
  if [ "${1:-}" = "prepare" ] && [ "${PREPARE_TARGET_SKIP_BUILD:-0}" != "1" ]; then
    echo 1
  else
    echo 0
  fi
  return 0
}

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

# --- The ledger ------------------------------------------------------------------

# Does THIS run keep the three series? Asked in three places, answered once.
#
# `schedule` mirrors the workflow, where all three steps carry
# `if: github.event_name == 'schedule'`, and the reason is the one #1183 already
# states for the token series: a manual run's scope is whatever grep was typed, while
# every reader of these files assumes one full @stable sweep per entry. Such a line
# does not read as noise — it reads as a bad day, and the anomaly baseline moves with
# it. KEEP_LEDGER=0 is for the runs that ARE schedule-shaped and still must not be
# recorded, a smoke through the real systemd unit being exactly that.
ledger_active() {
  [ "$KEEP_LEDGER" = "1" ] && [ "$EVENT_NAME" = "schedule" ] && [ -n "$LEDGER_DIR" ]
}

# Refuses a ledger inside the clone, which is the one way this change could defeat its
# own purpose. Both sides go through `pwd -P`, so a symlink pointing back into the
# working tree is caught too — the question is where the bytes land, not how the path
# is spelled.
#
# It answers for a path that does not exist yet, by resolving the nearest ancestor that
# does and carrying the remainder back on. That is what lets preflight refuse BEFORE
# creating anything: a rejected ledger must not leave its own directory behind inside
# the clone as the trace of the check that rejected it.
ledger_dir_is_outside_repo() {
  local probe="$1" rest="" real repo
  while [ ! -d "$probe" ]; do
    case "$probe" in
      */*) rest="/${probe##*/}$rest"; probe="${probe%/*}"; [ -n "$probe" ] || probe="/" ;;
      # No slash left: a relative path, and this script runs from $REPO_DIR.
      *)   rest="/$probe$rest"; probe="."; break ;;
    esac
  done
  real="$(cd "$probe" && pwd -P)$rest"
  repo="$(cd "$REPO_DIR" && pwd -P)"
  case "$real/" in "$repo"/*) return 1 ;; *) return 0 ;; esac
}

# The Actions series is what this one continues, so a ledger file that does not exist
# yet is seeded from the tracked one instead of starting empty. Day zero is not free:
# the durations file is what balances the matrix, and the token summary's anomaly
# baseline is a median over recent entries — both answer badly from three lines, and
# answer badly in the direction of looking fine. One-way and once; after the copy the
# tracked file is never read again, and it is never written.
ledger_seed() {
  local ledger="$1" tracked="$2"
  [ -n "$ledger" ] || return 0
  if [ -e "$ledger" ]; then return 0; fi
  if [ ! -f "$tracked" ]; then return 0; fi
  # Fail-soft, like every other step in phase_publish. A seed that cannot be copied
  # costs this series its baseline and nothing else, while aborting would take the
  # day's verdict down with it — the run has already happened, and the verdict is what
  # this lane exists to produce.
  if cp "$tracked" "$ledger"; then
    info "ledger: seeded ${ledger##*/} from $tracked"
  else
    warn "could not seed ${ledger##*/} from $tracked — this series starts from nothing."
  fi
  return 0
}

# Settles the ledger BEFORE the run rather than at publish time, and split out of
# phase_preflight so the decision is testable without ssh. A ledger that cannot be
# written is a day of data lost, and if the first write is also the first check the
# loss is found at 08:50, after the whole hour has been spent — while here it is still
# the cheapest failure in this script to fix, one variable.
preflight_ledger() {
  if ledger_active; then
    # Placement is settled before creation, so a refused ledger leaves nothing behind.
    ledger_dir_is_outside_repo "$LEDGER_DIR" \
      || die "LEDGER_DIR ($LEDGER_DIR) is inside the clone. The three series live outside it precisely so that a run cannot leave the tree dirty — and a dirty tree is what the wrapper's next \`git pull --ff-only\` refuses, every morning, without saying why."
    mkdir -p "$LEDGER_DIR" || die "cannot create the ledger directory ($LEDGER_DIR)."
    [ -w "$LEDGER_DIR" ] || die "the ledger directory is not writable ($LEDGER_DIR)."
    info "ledger: $LEDGER_DIR"
  elif [ "$KEEP_LEDGER" = "1" ] && [ "$EVENT_NAME" = "schedule" ]; then
    # Reached only with LEDGER_DIR empty, which means neither XDG_STATE_HOME nor HOME
    # was set — the systemd shape of #1715, where what a unit inherits is not what a
    # login shell has. Fatal rather than a warning: a scheduled run that quietly keeps
    # no series is indistinguishable, months later, from a machine that was down.
    die "LEDGER_DIR is unset and neither XDG_STATE_HOME nor HOME is set, so this run has nowhere to keep the three series. Set LEDGER_DIR, or KEEP_LEDGER=0 for a run that must not be recorded."
  else
    info "ledger: not kept for this run (KEEP_LEDGER=$KEEP_LEDGER, event=$EVENT_NAME)"
  fi
}

# Which duration table balances the matrix. A switch that is ON and finds nothing must
# say so: falling back in silence is how a run comes to be balanced by numbers nobody
# chose, and the symptom — shards of uneven length — looks like the suite's own drift.
durations_table() {
  if [ "$USE_LEDGER_DURATIONS" = "1" ]; then
    if [ -n "$LEDGER_DURATIONS" ] && [ -f "$LEDGER_DURATIONS" ]; then
      printf '%s\n' "$LEDGER_DURATIONS"
      return 0
    fi
    warn "USE_LEDGER_DURATIONS=1 but the ledger has no durations table yet (${LEDGER_DURATIONS:-<no ledger>}) — this run balances on the tracked one instead."
  fi
  printf '%s\n' "reports/spec-durations.json"
}

# Where this run's spend line goes, as one KEY=VALUE per line. A function so the
# composition is testable rather than read: the two outcomes are mutually exclusive by
# construction, and neither label can be dropped while the history path is set.
#
# WORKFLOW, because without it the summarizer writes `workflow: "unknown"`, which reads
# as an Actions row that lost its label rather than as a VM one. GITHUB_RUN_ID because
# the summarizer takes the run's identity from the environment, which in Actions is
# simply there and here is not: a smoke found the spend row landing with
# `run_id: null` while the history row for the SAME run carried the id, and a row that
# cannot be joined back to its run is dropped by every consumer that groups by run.
tokens_history_env() {
  if ledger_active; then
    printf '%s\n' "TOKENS_HISTORY=$LEDGER_TOKENS" "WORKFLOW=$WORKFLOW_ID" "GITHUB_RUN_ID=$RUN_ID"
  else
    printf '%s\n' "TOKENS_SUPPRESS_HISTORY=1"
  fi
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

  preflight_ledger

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
  # Failing an ATTEMPTED placement is the point. A run against the clone's old position
  # still produces a verdict, and that verdict goes into the divergence list as "a real
  # failure only Actions saw" — product changelog wearing an environment's clothes. A
  # lane whose output would be misleading is worth less than no output.
  #
  # Not placing at all is a different case and must not share that fate. When the
  # resolution names no commit, dying here costs the whole run — this is upstream of
  # phase_publish, so there is no report either — where the version gate at the end
  # produces the same red WITH the evidence. target_preparation_plan() draws that line.
  TARGET_PREPARED_SHA=""; TARGET_REBUILT=""; TARGET_REBUILD_REASON=""; TARGET_PREPARE_S=""
  local plan; plan="$(target_preparation_plan)"
  # What is demanded of the starter follows what preparation DID, not what was asked
  # for. The configured value above is the intent; this is the outcome.
  STAMP_REQUIRED="$(stamp_demand_for_plan "$plan")"
  if [ "$plan" = "prepare" ]; then
    log "Preparing the target's clone"
    local prep_out prep_rc=0 prep_log="$RUN_DIR/logs/prepare-target.log"
    # stderr is streamed AND filed: a rebuild is the longest thing this run does, and
    # a phase that prints nothing for half an hour is indistinguishable from a hang.
    #
    # The status is captured rather than branched on directly, so the summary is filed
    # on BOTH paths. On a failure the preparer has usually printed nothing to stdout —
    # it emits its key=value block only after everything succeeded, and every refusal
    # goes to stderr, which is tee'd — so this is insurance against a partial or
    # polluted capture, not a lost summary. A log the operator is pointed at should
    # not have a path on which it is silently short.
    prep_out="$(target_ssh \
        "TARGET_SHA=${TARGET_EXPECTED_SHA} TARGET_REF=${TARGET_EXPECTED_REF} TARGET_BRANCH=${TARGET_EXPECTED_BRANCH} \
         LANGFLOW_SRC_REPO=\${LANGFLOW_SRC_REPO:-\$HOME/langflow} \
         PREPARE_ALLOW_DIRTY=${PREPARE_TARGET_ALLOW_DIRTY} \
         PREPARE_SKIP_BUILD=${PREPARE_TARGET_SKIP_BUILD} bash -s" \
        < scripts/prepare-target-source.sh 2> >(tee -a "$prep_log" >&2))" || prep_rc=$?
    printf '%s\n' "$prep_out" >> "$prep_log"
    if [ "$prep_rc" != "0" ]; then
      err "could not put the target on ${TARGET_EXPECTED_REF:-${TARGET_EXPECTED_SHA}}."
      err "Refusing to run. The comparison this lane exists to produce is only about"
      err "the environment if both sides run the same product; against the clone's old"
      err "position it describes the product's changelog instead. See $prep_log."
      die "target preparation failed"
    fi
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
  elif [ "$plan" = "skip-no-commit" ]; then
    # The version is authoritative and the commit is not known — the registry decided
    # the version string by digest, while the commit is looked up by TAG NAME in the
    # git ref listing, and that lookup came back empty. Placing the clone on the tag
    # name anyway would ask for the tag the resolver just failed to find; placing it on
    # the branch head would build something nobody resolved and then fail the
    # exact-match gate below for a difference this run invented. So: do less, say more.
    warn "resolved ${TARGET_EXPECTED_VERSION} but not the commit behind it, so the clone was"
    warn "left where it is. The registry names the version; the commit comes from the git"
    warn "tag listing, which was empty for ${TARGET_EXPECTED_REF:-that version} — github"
    warn "unreachable, or the nightly tag deleted and not yet recreated."
    warn "The version check below still runs and will report the gap. To place it by hand:"
    warn "  git -C <clone> checkout ${TARGET_EXPECTED_BRANCH:-release-<cycle>}  # cycle parity, not the commit"
    warn "The build stamp is NOT demanded of the starter, because this run did not write one."
  elif [ "$plan" = "skip-unresolved" ]; then
    warn "no target version was resolved at all, so the clone was left where it is. The"
    warn "version check below cannot run either — treat a green run as unverified, not as"
    warn "evidence that both lanes tested the same product."
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

  # Which timings balance the matrix. The TRACKED file while both dailies run: the
  # product of this etapa is a comparison, and a matrix balanced by VM-measured
  # durations puts specs on different shards than the Actions lane does, so a failure's
  # neighbours — and the load its backend was under — differ for a reason that has
  # nothing to do with the product. The ledger's own timings take over with
  # USE_LEDGER_DURATIONS, which is the next etapa's switch to throw.
  local durations
  durations="$(durations_table)"
  info "durations: $durations"

  node scripts/partition-shards.mjs matrix \
    "$RUN_DIR/stable-list.json" "$durations" "$SHARDS" > "$RUN_DIR/matrix.json"

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
    "PATH=\$HOME/.local/bin:\$PATH LANGFLOW_SRC_REPO=\${LANGFLOW_SRC_REPO:-\$HOME/langflow} LANGFLOW_REQUIRE_BUILD_STAMP=$STAMP_REQUIRED $(mirrored_target_env)${bind_env}LANGFLOW_PORT=$port bash -s; sleep 86400" \
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

  # The comparison this step exists for. A mismatch is now FATAL by default: the run
  # placed the clone itself a few phases ago, so the two sides disagreeing means
  # something actually went wrong — the placement did not take, or the target answered
  # for an instance this run did not start. Producing a comparison anyway would file
  # product changelog as an environment difference, which is the failure this whole
  # step exists to remove. REQUIRE_TARGET_VERSION=0 goes back to reporting only.
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

  # The durations series. Empty and partial are excluded for the workflow's own reason:
  # `extract` merges onto what it is given, and a sweep that ran a fraction of the
  # specs would rewrite the balance of the whole matrix from a fraction of the evidence.
  if ledger_active && [ "$RUN_EMPTY" = "false" ] && [ "$RUN_PARTIAL" = "false" ]; then
    log "Recording the spec durations"
    ledger_seed "$LEDGER_DURATIONS" reports/spec-durations.json
    local next="$RUN_DIR/spec-durations.next.json"
    # The PREVIOUS file is the ledger's own, never the tracked one: reading the tracked
    # copy every day would re-merge Actions timings into this lane's series forever and
    # the VM's own numbers would never take over.
    if node scripts/partition-shards.mjs extract "$RUN_DIR/results.json" "$LEDGER_DURATIONS" > "$next"; then
      mv "$next" "$LEDGER_DURATIONS" || warn "could not replace $LEDGER_DURATIONS — the table is left as it was."
    else
      warn "duration extraction FAILED — $LEDGER_DURATIONS is left as it was (#1252)."
    fi
  fi

  # The spend series. It was suppressed until now for a reason that has since been
  # removed, not because this lane has nothing to record: the summarizer's default
  # target is reports/token-history.jsonl, tracked, inside a clone this run does not
  # own, and the line it appends is an uncommitted change the next `git pull --ff-only`
  # refuses every morning. Pointed at the ledger it is neither, and #1183's argument
  # turns around — that one excludes the PR and manual lanes because their scope is not
  # the daily's sweep, and this lane's scope IS the daily's sweep. What must not happen
  # is the two ending up in one series, and WORKFLOW is what prevents it: without it
  # the summarizer writes `workflow: "unknown"`, which is indistinguishable from an
  # Actions row that lost its label.
  if ledger_active; then
    ledger_seed "$LEDGER_TOKENS" reports/token-history.jsonl
  fi
  local tokens_env=() kv
  while IFS= read -r kv; do tokens_env+=("$kv"); done < <(tokens_history_env)
  env "${tokens_env[@]}" TOKENS_DIR="$RUN_DIR/all-tokens" \
    node scripts/watch-tokens.mjs --summarize \
    > "$RUN_DIR/logs/token-summary.log" 2>&1 || warn "the token summary failed (not blocking)."

  # The run series — one line per scheduled sweep, and the switch that used to gate it
  # was named for something this script does not do. COMMIT_HISTORY implied a commit;
  # the code under it only ever wrote a file, so the append was being held back by a
  # decision that belonged to a later etapa, and the series it feeds would have had a
  # hole exactly as wide as the wait. Committing is what stays behind, and it stays
  # behind as absent code rather than as a switch set to zero.
  #
  # LIVENESS_DIR and SHARD_TOTAL are passed for the same reason the workflow passes
  # them: without the expected count a shard that died before writing its summary
  # vanishes from the row instead of reading as a gap (#1012), and the wedge this lane
  # is measuring (#1720) is exactly what those fields carry.
  if ledger_active; then
    log "Recording the daily history"
    ledger_seed "$LEDGER_HISTORY" reports/daily-history.jsonl
    PLAYWRIGHT_JSON="$RUN_DIR/results.json" \
    HISTORY_FILE="$LEDGER_HISTORY" \
    WORKFLOW="$WORKFLOW_ID" \
    GITHUB_RUN_ID="$RUN_ID" \
    LIVENESS_DIR="$RUN_DIR/all-liveness" \
    SHARD_TOTAL="${SHARD_TOTAL:-}" \
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
