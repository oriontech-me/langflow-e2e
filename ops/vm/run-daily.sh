#!/usr/bin/env bash
# The VM lane's daily wrapper: what e2e-daily.service runs, through
# ops/systemd/e2e-daily.service.d/10-target-dist.conf.
#
# ## What it does
#
# Pulls the suite, resolves the Langflow version this lane should serve the same way
# the run does (from the published image), installs that exact published distribution
# into a venv on THIS machine, and runs scripts/run-e2e.sh against it with the lane's
# switches set. Then it copies the ledger off the machine and prunes old logs.
#
# ## Why it is versioned, and what is NOT in it
#
# It lived in /root until #1994, edited four times in three days with a dated .bak as
# the only record. The switches below are the lane's choices -- ports, shards, which
# publications are on -- and those are what a reviewer should see.
#
# What stays on the machine is what cannot be public, because this repository is:
#
#   /root/.e2e-secrets   provider keys, tokens, the Slack webhook. Mode 600.
#   /root/.e2e-lane      topology, no secrets. The wrapper refuses without it:
#
#       ISSUE_HOST=<host the umbrella issue opens on>
#       ISSUE_REPO=<owner/name on that host>
#       ISSUE_CC="<@handle ...>"     # the empty string opens an issue that pings nobody
#       BACKUP_DEST=<ssh-alias>:<dir>   # where the ledger is copied, or local:<dir>
#
# ISSUE_CC is required to be SET, not non-empty: create-failure-issue.mjs tests for
# `undefined`, so ISSUE_CC="" is a real choice (no /cc line), while an absent key would
# fall back to CC_DEFAULT -- the github.com handles, which on the issue host either do
# not exist or are somebody else.
#
# ## Why the whole body is one function
#
# The first thing it does is `git pull` on the clone it lives in, which can rewrite this
# very file while bash is reading it. bash reads a script incrementally, so the lines
# after the pull could come from the NEW file at the old offset. A function is parsed
# whole before it runs, so the pass that pulls never reads this file again.
#
# ## Why it re-executes itself after the pull
#
# Without it, a wrapper fix merged yesterday runs tomorrow, and today's run records a
# suite SHA whose wrapper is the previous commit's -- two versions in one verdict. The
# second pass inherits the log (file descriptors survive exec) and skips the pull.
#
# Usage:
#   /root/e2e-qa/ops/vm/run-daily.sh              # what the unit runs
#   DRY_RUN=1 /root/e2e-qa/ops/vm/run-daily.sh    # installs the target, then preflight
#                                                 # and shard partition only, no tests
#
# Rollback: point the drop-in back at /root/run-daily-dist.sh, which is left untouched
# on the machine, and `systemctl daemon-reload`.
main() {
  set -uo pipefail
  export HOME="${HOME:-/root}"
  # uv lives in ~/.local/bin and a systemd unit does not load it. With the target on
  # THIS machine since 2026-09-21, the installer needs it here -- the same trap as
  # #1715, one step closer to home.
  export PATH="$HOME/.local/bin:$PATH"

  # Overridable ONLY so the refusals below can be exercised without the machine; the
  # unit sets none of them.
  local REPO="${E2E_DAILY_REPO:-/root/e2e-qa}"
  local LOG_DIR="${E2E_DAILY_LOG_DIR:-/var/log/e2e-daily}"
  local SECRETS="${E2E_DAILY_SECRETS:-/root/.e2e-secrets}"
  local LANE="${E2E_DAILY_LANE:-/root/.e2e-lane}"
  local LOG_KEEP_DAYS=30
  local VENV="${E2E_DAILY_VENV:-/root/venv-target}"
  local NIGHTLY_TAGS_URL="https://hub.docker.com/v2/repositories/langflowai/langflow-nightly/tags?page_size=100&ordering=last_updated"
  local UPSTREAM_REPO_URL="https://github.com/langflow-ai/langflow"

  if [ "${E2E_DAILY_REEXECED:-0}" != "1" ]; then
    mkdir -p "$LOG_DIR"
    local STAMP LOG
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    LOG="$LOG_DIR/$STAMP.log"
    exec >>"$LOG" 2>&1
    ln -sfn "$LOG" "$LOG_DIR/latest.log"
    echo "=== daily start $STAMP — target: published distribution ==="

    cd "$REPO" || { echo "FATAL: $REPO is missing"; exit 1; }
    git pull --ff-only || echo "WARNING: pull failed — running the suite as it stands"
    echo "suite at: $(git log --oneline -1)"

    local SELF="$REPO/ops/vm/run-daily.sh"
    [ -f "$SELF" ] || { echo "FATAL: $SELF is gone after the pull — the unit points at a wrapper main no longer has"; exit 1; }
    export E2E_DAILY_REEXECED=1
    exec bash "$SELF" "$@"
  fi

  # --- second pass: the wrapper as main holds it after the pull ---------------------
  cd "$REPO" || { echo "FATAL: $REPO is missing"; exit 1; }
  echo "wrapper at: $(git log --oneline -1 -- ops/vm/run-daily.sh)"

  if [ -r "$SECRETS" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS"
  else
    echo "FATAL: $SECRETS is missing or unreadable"; exit 1
  fi

  # Before anything is installed or run: a lane that cannot say where its verdict goes
  # must not spend sixteen minutes and real model calls producing one.
  if [ -r "$LANE" ]; then
    # shellcheck disable=SC1090
    . "$LANE"
  else
    echo "FATAL: $LANE is missing or unreadable — it holds the topology this repository does not (see the header)"; exit 1
  fi
  local key missing=""
  for key in ISSUE_HOST ISSUE_REPO BACKUP_DEST; do
    [ -n "${!key:-}" ] || missing="$missing $key"
  done
  [ -n "${ISSUE_CC+set}" ] || missing="$missing ISSUE_CC"
  if [ -n "$missing" ]; then
    echo "FATAL: $LANE does not set:$missing"
    echo "       Refusing rather than falling back to a default that names the wrong host or the wrong people."
    exit 1
  fi

  # --- which Langflow today, by the same resolution the run itself uses ---------------
  # Global, not local: the EXIT trap fires after main has returned, when a local is out
  # of scope and `set -u` turns the cleanup into an error that leaves the directory.
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -sfS --max-time 20 "$NIGHTLY_TAGS_URL" -o "$TMP/tags.json" \
    || echo "WARNING: the published image listing is unreadable; the refs will answer, and they can run ahead of what shipped"
  : > "$TMP/refs.txt"
  git ls-remote --heads --tags "$UPSTREAM_REPO_URL" > "$TMP/refs.txt" \
    || echo "WARNING: the upstream ref listing is unreachable"
  local DECISION WANT
  # stderr apart from stdout: the resolver writes its warnings there, one `::warning::`
  # line each, and every fallback path emits one -- mixed into the JSON they would make
  # the parse fail, and the day the fallback exists for would refuse to run.
  DECISION="$(node scripts/resolve-target-version.mjs --refs-file "$TMP/refs.txt" --image-tags-file "$TMP/tags.json" 2>"$TMP/resolver.err" || true)"
  cat "$TMP/resolver.err"
  WANT="$(node -p "try{JSON.parse(process.argv[1]).version||''}catch{''}" "$DECISION" 2>/dev/null)"
  if [ -z "$WANT" ]; then
    echo "FATAL: could not resolve the version this lane should serve. Refusing to run:"
    echo "       yesterday's distribution is still installed, and a run against it would"
    echo "       describe the product's changelog instead of the environment."
    echo "       resolver said: $DECISION"
    exit 1
  fi
  echo "target should be: $WANT"

  # --- put it on the target, or refuse ------------------------------------------------
  # The target is THIS machine since 2026-09-21 (the consolidation): measured twice on
  # 2026-09-20 before the switch, 732 tests, 1 hard failure, 2 flaky, 15.7 min, against
  # 16.7 min for 682 on the split lane. The tunnel that went is latency removed, and it
  # beat the CPU contention.
  #
  # The installer is the repository's (#1833), not the /root copy this replaced. That
  # one checked only `langflow`, an eight-file meta-package, and built the frontend path
  # from a hardcoded interpreter version; this one verifies `langflow-base` too and
  # locates the package with find_spec. Its stdout is key=value only, so the frontend
  # directory is read from it rather than guessed.
  local PREP rc FRONTEND_DIR
  PREP="$(TARGET_VERSION="$WANT" LANGFLOW_DIST_VENV="$VENV" ./scripts/prepare-target-dist.sh)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FATAL: could not put the published distribution on $WANT (rc=$rc)."
    echo "       Refusing rather than serving whatever was there before."
    exit 1
  fi
  printf '%s\n' "$PREP"
  FRONTEND_DIR="$(printf '%s\n' "$PREP" | sed -n 's/^frontend_dir=//p')"
  [ -n "$FRONTEND_DIR" ] || { echo "FATAL: the installer succeeded and reported no frontend_dir"; exit 1; }

  export TARGET_SSH=local
  export BASE_PORT=7870   # what the rehearsal measured; 7860-7863 were the tunnel's
  export SHARDS=4         # peak load 16.8 on 16 vCPU, 12 Langflow processes — measured
  export NOTIFY_SLACK="${NOTIFY_SLACK:-1}"   # overridable so the wrapper can be rehearsed without paging the channel
  # Adopted 2026-09-22 (#1981, PR #1982). Announce the CLEAN days too, which this lane
  # asks for and the Actions lane does not: there the run list answers "did it run
  # today?", and here the only positive evidence is systemd and /var/log/e2e-daily,
  # behind the VPN.
  #
  # It does NOT widen what counts as green. The notifier refuses to announce a clean day
  # when the runner failed the run for a reason outside the per-test report (a missing
  # shard blob, the listing gate, the version gate) or when nothing passed at all --
  # both refusals say why in this log.
  #
  # Rollback: drop this line. The default is 0, so the lane goes back to speaking only
  # on a bad day.
  export NOTIFY_SLACK_ALWAYS=1

  # --- the cut, 2026-09-20: from here this lane's verdict carries consequence ---------
  # The umbrella issue is opened by THIS machine's run, on the destination -- where it
  # will stay, so it never has to be migrated. The Actions lane stays on without
  # consequence for two weeks as the fallback, and switching its schedule off is the
  # LAST step, not the first. Where the issue opens and whom it pings come from $LANE.
  #
  # The issue token lives in $SECRETS and has an expiry; the preflight reads it and
  # refuses the run when the host rejects the credential (#1950).
  #
  # What this lane does NOT do yet: remove @stable from the specs that failed. Since
  # #1944 no lane does -- the removal is off in Actions and the write path here waits on
  # the origin push token. Until then AUTO_REMOVE stays unset and the removal is done
  # by hand, from this run's results.json.
  export CREATE_ISSUE=1
  export ISSUE_HOST ISSUE_REPO ISSUE_CC
  export PREPARE_TARGET=0                # the clone does not serve; this also turns the build stamp off
  export LANGFLOW_SRC_RUN_CMD="$VENV/bin/langflow run"
  export LANGFLOW_SRC_FRONTEND_DIR="$FRONTEND_DIR"
  # REQUIRE_TARGET_VERSION is left at its default of 1 ON PURPOSE: the installer above
  # pins the distribution to the version the resolver derived from the published image,
  # so the gate has something true to check instead of being switched off.
  #
  # LANGFLOW_DEACTIVATE_TRACING is deliberately NOT set. The source clone wedged under
  # the traces family with tracing on (#1720), which is why the split-lane wrapper
  # forced it off and lost sixteen tests a day; the published distribution serves that
  # family with tracing on (measured 2026-09-10: 654 tests, zero WORKER TIMEOUT).

  ./scripts/run-e2e.sh
  local code=$?
  echo "=== daily end, exit=$code ==="

  # The ledger is this lane's authoritative history and lives OUTSIDE the clone, so
  # nothing versioned carries it off the machine. Until the two eras are merged into the
  # repository this is the only second copy of it. It runs on a red day too: a red day
  # is exactly when those rows matter.
  #
  # It cannot fail the run. The exit code is ignored on purpose, the verdict is one line
  # on stdout (so it lands in the daily log) and in $LOG_DIR/ledger-backup.log, and
  # "absent" is said out loud instead of passed over -- a backup that silently stopped
  # happening is the failure this exists to prevent.
  local LEDGER_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e"
  if [ -x ./scripts/backup-ledger.sh ]; then
    LEDGER_DIR="$LEDGER_STATE" \
    BACKUP_DEST="$BACKUP_DEST" \
    BACKUP_KEEP=14 \
    BACKUP_LOG="$LOG_DIR/ledger-backup.log" \
      ./scripts/backup-ledger.sh || true
  else
    echo "WARNING: scripts/backup-ledger.sh is absent -- the ledger was NOT copied off this machine"
  fi
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +"$LOG_KEEP_DAYS" -delete
  # The run's status, not the pruning's: without it a red day ends Result=success.
  return "$code"
}
main "$@"
exit $?
