#!/usr/bin/env bash
# The image shadow: what e2e-shadow.service runs (#2093).
#
# ## What it is
#
# A second, sequential pass of the same @stable suite on the same machine, against the
# published IMAGE of the version the official run served from the venv. It exists so a
# failure only this machine sees can be attributed to the machine or to the artifact:
#
#   VM+image x Actions+image   holds the artifact, isolates the machine
#   VM+image x VM+wheel        holds the machine, isolates the artifact
#
# It has NO consequence. It opens no issue, removes no @stable, posts nothing to Slack or
# to the platform. The switches being off is the mechanism. Behind it, the six
# publishing credentials are unset and gh is pointed at an empty config, so that a
# switch flipped by mistake fails for want of a credential -- gh's stored login is the
# fallback the issue creator uses when no token is set, and an unset token alone would
# not have closed it (#2094 review).
#
# ## How it is started
#
# Not by a timer. ops/vm/request-shadow.sh, called at the end of run-daily.sh, writes
# $STATE/request.env -- the day, the version the official run resolved, and the suite
# commit it ran -- and starts this unit with --no-block. The official run's exit status
# is never touched, and the watchdog never sees this pass: its logs, runs and ledger all
# live elsewhere.
#
# ## Where it runs, so the two lanes never touch each other
#
# Disjoint from the official lane on every resource a run owns, because there is no lock
# between them and each run's hygiene clears only its own kind (#2089):
#
#   ports     7880-7883, echo 8090, ollama 11444   (official: 7870-7873, 8080, 11434)
#   suite     its own worktree, detached at the official run's commit
#   runs      $STATE/runs
#   ledger    ~/.local/state/langflow-e2e-shadow, as workflow daily-stable-vm-image
#   logs      /var/log/e2e-shadow
#
# ## The official lane has priority
#
# There is no lock between the two, so run-daily.sh stops an active shadow when it
# starts: a daily re-run by hand while the shadow is still going would otherwise run two
# suites on one machine, and the lane with consequence would absorb the contention. A
# shadow stopped that way leaves leftovers only on its own ports, which the next
# shadow's hygiene clears.
#
# Rollback: run-daily.sh's IMAGE_SHADOW=0, or remove the unit; nothing here is read by
# the official lane.
main() {
  set -uo pipefail
  export HOME="${HOME:-/root}"
  export PATH="$HOME/.local/bin:$PATH"

  # Overridable ONLY so the refusals below can be exercised without the machine.
  local REPO="${E2E_SHADOW_REPO:-/root/e2e-qa}"
  local STATE="${E2E_SHADOW_STATE:-/root/e2e-shadow}"
  local LOG_DIR="${E2E_SHADOW_LOG_DIR:-/var/log/e2e-shadow}"
  local SECRETS="${E2E_SHADOW_SECRETS:-/root/.e2e-secrets}"
  local LANE="${E2E_SHADOW_LANE:-/root/.e2e-lane}"
  local LEDGER="${E2E_SHADOW_LEDGER:-${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e-shadow}"
  local OFFICIAL_LEDGER="${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e"
  local LOG_KEEP_DAYS=30
  local IMAGE_REPO="langflowai/langflow-nightly"

  mkdir -p "$LOG_DIR"
  local STAMP LOG
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  LOG="$LOG_DIR/$STAMP.log"
  exec >>"$LOG" 2>&1
  ln -sfn "$LOG" "$LOG_DIR/latest.log"
  echo "=== shadow start $STAMP — target: published image ==="

  # --- the request: which day, which version, which suite -------------------------
  # Consumed on read, so a shadow started by hand a second time does not silently
  # re-measure a day under a request it already answered.
  local REQ="$STATE/request.env"
  [ -r "$REQ" ] || { echo "FATAL: no request at $REQ — the shadow runs only after an official run asked for it (ops/vm/request-shadow.sh)"; exit 1; }
  local SHADOW_DATE="" SHADOW_VERSION="" SHADOW_SUITE_SHA=""
  # shellcheck disable=SC1090
  . "$REQ"
  mv -f "$REQ" "$STATE/request.consumed"
  echo "request: date=$SHADOW_DATE version=$SHADOW_VERSION suite=$SHADOW_SUITE_SHA"
  # A request from another day is a comparison of two days' products; refused, not run.
  [ "$SHADOW_DATE" = "$(date -u +%Y-%m-%d)" ] || { echo "FATAL: the request is for '$SHADOW_DATE', not today — refusing to compare two different days"; exit 1; }
  case "$SHADOW_VERSION" in
    '' | *[!0-9A-Za-z.+-]*) echo "FATAL: the request names no usable version: '$SHADOW_VERSION'"; exit 1 ;;
  esac
  [[ "$SHADOW_SUITE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "FATAL: the request names no full suite commit: '$SHADOW_SUITE_SHA'"; exit 1; }

  # --- the suite: the official run's own commit, in a worktree of its own ----------
  # Not the clone: the official run's @stable removal moves the clone's HEAD on a red
  # day, and a shadow that followed it would run a different suite than the one it is
  # compared with. Not the clone's working tree either, which the next pull rewrites.
  local WT="$STATE/wt"
  # A worktree the clone no longer knows, or a directory that is no longer the clone's
  # worktree, would fail this every weekday with nothing watching the unit: both are
  # cleared and the worktree recreated (#2094 review).
  git -C "$REPO" worktree prune
  if [ -e "$WT" ] && [ "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" ]; then
    echo "WARNING: $WT is not a worktree of $REPO — removing it and creating it again"
    rm -rf "$WT"
    git -C "$REPO" worktree prune
  fi
  if [ -e "$WT" ]; then
    git -C "$WT" checkout -q --detach --force "$SHADOW_SUITE_SHA" || { echo "FATAL: could not move $WT to $SHADOW_SUITE_SHA"; exit 1; }
  else
    git -C "$REPO" worktree add -q --detach "$WT" "$SHADOW_SUITE_SHA" || { echo "FATAL: could not create $WT at $SHADOW_SUITE_SHA"; exit 1; }
  fi
  [ "$(git -C "$WT" rev-parse HEAD)" = "$SHADOW_SUITE_SHA" ] || { echo "FATAL: $WT is not at $SHADOW_SUITE_SHA after the checkout"; exit 1; }
  echo "suite at: $(git -C "$WT" log --oneline -1)"
  # The provider keys that decide which spec files enter the suite are read from the
  # working copy's .env (run-e2e.sh, #1764). A worktree has none, so the shadow would
  # list a smaller suite than the official run from a key only the clone's .env holds,
  # and the artifact comparison would charge the image with a difference of .env.
  # Linked, never copied, so the two lanes read one file (#2094 review).
  if [ -f "$REPO/.env" ]; then
    ln -sfn "$REPO/.env" "$WT/.env"
    echo "suite keys: $WT/.env -> $REPO/.env"
  else
    rm -f "$WT/.env"
  fi

  # --- credentials: the provider keys, and nothing that can publish ---------------
  if [ -r "$SECRETS" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS"
  else
    echo "FATAL: $SECRETS is missing or unreadable"; exit 1
  fi
  # The six a publisher reads. Unset, not only switched off below: a switch flipped by
  # mistake then fails for want of a credential instead of speaking for a run with no
  # consequence.
  unset SOURCE_PUSH_TOKEN GH_TOKEN GITHUB_TOKEN QA_E2E_AUTOMATION_TOKEN SUPABASE_SERVICE_ROLE_KEY SLACK_WEBHOOK_URL
  unset GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  mkdir -p "$STATE/no-gh-login"
  export GH_CONFIG_DIR="$STATE/no-gh-login"
  if [ -r "$LANE" ]; then
    # shellcheck disable=SC1090
    . "$LANE"
  fi

  export TARGET_SSH=local
  export TARGET_KIND=image
  export LANGFLOW_IMAGE="$IMAGE_REPO:$SHADOW_VERSION"
  export BASE_PORT=7880 SHARDS=4 ECHO_PORT=8090 OLLAMA_PORT=11444
  export WORKFLOW_ID=daily-stable-vm-image
  export LEDGER_DIR="$LEDGER"
  export RUNS_ROOT="$STATE/runs"
  export CREATE_ISSUE=0 AUTO_REMOVE=0 NOTIFY_SLACK=0 NOTIFY_SLACK_ALWAYS=0 POST_QA_PLATFORM=0
  # Read-only, but about the clone the official lane checks out, not this worktree.
  export CHECK_MIRROR=0
  unset LANGFLOW_SRC_RUN_CMD LANGFLOW_SRC_FRONTEND_DIR TARGET_VENV PREPARE_TARGET
  mkdir -p "$RUNS_ROOT" "$LEDGER_DIR"

  # localhost resolves to both loopbacks in the container, as on a host with IPv6 and as
  # on the Actions service container. The QA VM boots with ipv6.disable=1, so docker
  # writes 127.0.0.1 alone, and the SSRF spec that requires the refusal to name `::1`
  # failed on every shadow run -- with the five tests serial after it skipped (#2159).
  # The pip lane resolves both from the host's own /etc/hosts. Under $STATE, because a
  # snap docker cannot read /tmp.
  printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$STATE/hosts"
  export LANGFLOW_HOSTS_FILE="$STATE/hosts"

  ( cd "$WT" && ./scripts/run-e2e.sh )
  local code=$?
  echo "=== shadow end, exit=$code ==="

  # --- the two comparisons this lane exists for ------------------------------------
  # A record, never a gate: the Actions row reaches the tracked file only when that
  # lane's commit has been mirrored, so on some days the machine pair is not yet
  # comparable here. The comparator says so, and it says so in the file.
  local c
  for c in "artifact daily-stable-vm VM+wheel" "machine daily-stable Actions+image"; do
    set -- $c
    ( cd "$WT" && node scripts/compare-lane-verdicts.mjs \
        --history "$LEDGER/daily-history.jsonl" \
        --history "$OFFICIAL_LEDGER/daily-history.jsonl" \
        --history "$REPO/reports/daily-history.jsonl" \
        --date "$SHADOW_DATE" \
        --ci-workflow "$2" --ci-label "$3" \
        --vm-workflow daily-stable-vm-image --vm-label VM+image ) \
      > "$LOG_DIR/compare-$SHADOW_DATE-$1.txt" 2>&1
    echo "comparison ($1): exit=$? -> $LOG_DIR/compare-$SHADOW_DATE-$1.txt"
  done

  # --- the ledger off the machine, beside the official one but never in it ---------
  if [ -n "${BACKUP_DEST:-}" ] && [ -x "$WT/scripts/backup-ledger.sh" ]; then
    LEDGER_DIR="$LEDGER" \
    BACKUP_DEST="${BACKUP_DEST}-shadow" \
    BACKUP_KEEP=14 \
    BACKUP_LOG="$LOG_DIR/ledger-backup.log" \
      "$WT/scripts/backup-ledger.sh" || true
  else
    echo "WARNING: the shadow ledger was NOT copied off this machine (no BACKUP_DEST, or no backup script)"
  fi

  # One nightly image a day, a few GB each unpacked: keep today's, drop the others.
  docker images --format '{{.Repository}}:{{.Tag}}' "$IMAGE_REPO" 2>/dev/null \
    | grep -vxF "$LANGFLOW_IMAGE" | xargs -r docker rmi > /dev/null 2>&1 || true
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +"$LOG_KEEP_DAYS" -delete
  find "$LOG_DIR" -maxdepth 1 -name 'compare-*.txt' -type f -mtime +"$LOG_KEEP_DAYS" -delete
  return "$code"
}
main "$@"
exit $?
