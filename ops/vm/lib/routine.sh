#!/usr/bin/env bash
# The common shape of a scheduled routine on the VM lane: what every one of them sources
# so that none of them fails silently, and none of them runs beside the daily.
#
# ## Why one shape
#
# On Actions a routine's run was visible for free: the workflow list showed that it ran,
# how it ended, and a red run was red. On a timer none of that exists unless the routine
# says it. Each routine moved off Actions (stage 3 of the migration plan) therefore gets
# the same four things, here, instead of each wrapper inventing its own:
#
# Units are named e2e-routine-<name>.service (+ .timer), so run-daily.sh finds every
# routine by the pattern rather than by a list somebody must remember to extend.
#
#   1. The daily has priority. A routine does not start in the daily's window (weekdays
#      07:30-08:40 UTC), beside the daily or the image shadow, or while today's shadow
#      request waits to be picked up -- the same rules run-on-demand.sh follows. It WAITS
#      for its turn rather than refusing at once, because a routine has no requester to
#      try again later: the next chance is tomorrow. And run-daily.sh stops a routine
#      that holds its turn at 08:00, as it stops the shadow and the on-demand run; one
#      still waiting is left to wait.
#   2. One heavy lane at a time. A lane that starts Langflow or a browser takes
#      $E2E_HEAVY_LOCK. The 2026-10-05 shadow comparison (#2159) saw `database is busy`
#      503s and `socket hang up` with two suites on the machine; a migration cell beside
#      an on-demand run would trade its verdict for the same noise. Until the fyre
#      stencils give lanes machines of their own, the machine is shared by taking turns.
#   3. An honest exit status, and a result file that says why. The status and its code:
#
#        green    0  the routine ran and found nothing wrong
#        red      1  the routine ran and found something wrong in the product
#        skipped  2  the routine did not run: its turn never came within the budget
#        failed   3  the machine could not do its part, or the run was killed
#        blocked  4  a precondition outside the product failed (a drained provider
#                    account): not red, and not green either
#
#      The unit declares SuccessExitStatus=2 4, so systemd's own "failed" is kept for
#      failures of the machine, and a skipped or blocked day does not read as a broken
#      unit. They are still not silent: the routine's watchdog reports them.
#   4. Red reaches the destination. routine_finish hands the result to
#      scripts/routine-report.mjs, which keeps ONE open issue per routine on the
#      destination (a red day comments on it, the first green day closes it) and posts
#      the red day to Slack, when the routine asks for each.
#
# ## How a routine uses it
#
#   . "$REPO/ops/vm/lib/routine.sh"
#   routine_start migration            # logs, result trap, signals
#   routine_wait_turn 3600             # the daily's priority + the heavy-lane lock
#                                      # (routine_wait_daily 3600: the priority alone,
#                                      # for a routine that starts no Langflow or browser)
#   ...                                # the work; long-lived children get 8>&-
#   routine_set TARGET "$version"      # extra result fields, any number
#   routine_end red "2 of 12 cells red: ..."
#
# routine_end exits; the EXIT trap writes the result and reports it. Call it from the
# routine's own shell, never inside $(...) or a pipeline: there it exits only that
# subshell, and the status is lost. An exit that never
# went through routine_end -- a bug, `set -e`, the daily's SIGTERM -- is recorded as
# failed with the reason, so a result always exists for a run that started.
#
# ## The lock's descriptor
#
# The heavy-lane lock is fd 8, held for the routine's life. A daemon that inherits it
# (an ollama or an echo server started natively) would keep the lock after the routine
# exits and make every later lane wait for nothing. Start such processes with `8>&-`.
# Containers are not children of the routine -- dockerd starts them -- and need nothing.

# Paths are overridable ONLY so the waiting, the lock and the result can be exercised
# without the machine.
routine_start() {
  RT_NAME="$1"
  [[ "$RT_NAME" =~ ^[a-z][a-z0-9-]{0,40}$ ]] || { echo "FATAL: bad routine name '$RT_NAME'" >&2; exit 3; }
  export HOME="${HOME:-/root}"
  export PATH="$HOME/.local/bin:$PATH"
  RT_REPO="${E2E_ROUTINE_REPO:-/root/e2e-qa}"
  RT_STATE="${E2E_ROUTINE_STATE_ROOT:-/root/e2e-routines}/$RT_NAME"
  RT_LOG_DIR="${E2E_ROUTINE_LOG_ROOT:-/var/log}/e2e-$RT_NAME"
  RT_HEAVY_LOCK="${E2E_HEAVY_LOCK:-/run/lock/e2e-heavy.lock}"
  RT_SHADOW_STATE="${E2E_SHADOW_STATE:-/root/e2e-shadow}"
  RT_POLL_S="${E2E_ROUTINE_POLL_S:-30}"
  mkdir -p "$RT_STATE/results" "$RT_LOG_DIR"
  RT_EPOCH="$(date -u +%s)"
  # GNU date on the machine, BSD date where the tests may run.
  RT_STAMP="$(date -u -d "@$RT_EPOCH" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$RT_EPOCH" +%Y%m%dT%H%M%SZ)"
  RT_LOG="$RT_LOG_DIR/$RT_STAMP.log"
  exec >>"$RT_LOG" 2>&1
  ln -sfn "$RT_LOG" "$RT_LOG_DIR/latest.log"
  echo "=== $RT_NAME start $RT_STAMP ==="
  # Globals, not locals: the EXIT trap runs after the caller's function has returned.
  RT_STATUS=""; RT_REASON=""; RT_FINISHING=0; RT_EXTRA=()
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap routine_finish EXIT
}

# "<ISO weekday 1-7> <HHMM>", UTC. E2E_ROUTINE_NOW pins it for tests.
routine_now() { printf '%s\n' "${E2E_ROUTINE_NOW:-$(date -u '+%u %H%M')}"; }

# Why the daily lane would be disturbed by starting now, or nothing.
routine_daily_busy() {
  local now dow hm unit st
  now="$(routine_now)"; dow="${now%% *}"; hm="${now##* }"
  if [ "$dow" -le 5 ] && [ "$((10#$hm))" -ge 730 ] && [ "$((10#$hm))" -lt 840 ]; then
    echo "the daily's window (weekdays 07:30-08:40 UTC, now $hm on day $dow)"; return
  fi
  # ActiveState, not `is-active`: a oneshot running its wrapper is `activating`, which
  # `is-active` does not count (#2094 review).
  for unit in e2e-daily.service e2e-shadow.service; do
    st="$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || true)"
    case "$st" in
      activating | active | reloading | deactivating) echo "$unit is $st"; return ;;
    esac
  done
  if [ -r "$RT_SHADOW_STATE/request.env" ] \
     && grep -qx "SHADOW_DATE=$(date -u +%Y-%m-%d)" "$RT_SHADOW_STATE/request.env"; then
    echo "today's shadow request is waiting to start"; return
  fi
}

# Wait for the daily lane alone, within a budget in seconds. Out of budget, the routine
# ends `skipped` with what it waited on. A light routine -- one that starts neither
# Langflow nor a browser -- calls this and takes no lock: it cannot disturb a heavy lane,
# and queueing it behind one would only delay it.
routine_wait_daily() {
  local budget="$1" start=$SECONDS why
  while why="$(routine_daily_busy)"; [ -n "$why" ]; do
    if [ $((SECONDS - start)) -ge "$budget" ]; then
      routine_end skipped "its turn never came within ${budget}s: $why"
    fi
    echo "waiting: $why"
    sleep "$RT_POLL_S"
  done
}

# Wait for the routine's turn: the daily lane first, then the heavy-lane lock, within
# one budget in seconds. Out of budget, the routine ends `skipped` with what it waited
# on. The lock is then held on fd 8 until the routine exits.
routine_wait_turn() {
  local budget="$1" start=$SECONDS why left
  routine_wait_daily "$budget"
  command -v flock > /dev/null 2>&1 || routine_end failed "flock is not on this machine, and without it two heavy lanes could share it"
  mkdir -p "$(dirname "$RT_HEAVY_LOCK")"
  exec 8>> "$RT_HEAVY_LOCK" || routine_end failed "cannot open the heavy-lane lock $RT_HEAVY_LOCK"
  left=$((budget - (SECONDS - start)))
  [ "$left" -ge 0 ] || left=0
  if ! flock -w "$left" 8; then
    local holder
    holder="$(cat "$RT_HEAVY_LOCK.holder" 2>/dev/null || true)"
    routine_end skipped "the machine was busy for ${budget}s: ${holder:-another heavy lane} holds $RT_HEAVY_LOCK"
  fi
  # Who holds it, for whoever waits next. Beside the lock, not in it: the lock file is
  # opened for append by every waiter and is never read.
  printf '%s (pid %s) since %s\n' "$RT_NAME" "$$" "$RT_STAMP" > "$RT_HEAVY_LOCK.holder" 2>/dev/null || true
  # The daily lane may have started while the lock was being waited for.
  why="$(routine_daily_busy)"
  [ -z "$why" ] || routine_end skipped "the daily lane started while the lock was awaited: $why"
  echo "turn taken: $(cat "$RT_HEAVY_LOCK.holder" 2>/dev/null)"
}

# One more KEY=VALUE for the result. Keys are upper-case words; values lose newlines.
routine_set() {
  [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "WARNING: routine_set ignored bad key '$1'"; return 0; }
  # The result's own fields: written before the extras, and every reader takes the LAST
  # occurrence, so an extra named STATUS would replace the verdict (review of #2190).
  case "$1" in
    ROUTINE | STATUS | REASON | EXIT | STARTED | STARTED_EPOCH | FINISHED | LOG | REPORT)
      echo "WARNING: routine_set ignored '$1': the result sets it itself"; return 0 ;;
  esac
  RT_EXTRA+=("$1" "$2")
}

routine_end() {
  RT_STATUS="$1"; RT_REASON="$2"
  echo "$(printf %s "$RT_STATUS" | tr a-z A-Z): $RT_REASON"
  exit "$(routine_code "$RT_STATUS")"
}

routine_code() {
  case "$1" in
    green) echo 0 ;; red) echo 1 ;; skipped) echo 2 ;; blocked) echo 4 ;; *) echo 3 ;;
  esac
}

# The EXIT trap: the routine's own cleanup hook, the result, the report. Runs once.
routine_finish() {
  local code=$?
  [ "$RT_FINISHING" = "0" ] || return 0
  RT_FINISHING=1
  trap '' TERM INT
  if [ -z "$RT_STATUS" ]; then
    RT_STATUS=failed
    case "$code" in
      143) RT_REASON="stopped by SIGTERM: the daily starting, systemctl stop, or the unit's TimeoutStartSec" ;;
      130) RT_REASON="interrupted" ;;
      *) RT_REASON="ended with status $code before a verdict" ;;
    esac
  fi
  case "$RT_STATUS" in green | red | skipped | failed | blocked) ;; *) RT_REASON="unknown status '$RT_STATUS': $RT_REASON"; RT_STATUS=failed ;; esac
  # The routine's own cleanup, if it defined one. Its failure is logged, never fatal:
  # the result must still be written.
  if declare -F routine_cleanup > /dev/null; then
    echo "--- cleanup ---"
    routine_cleanup || echo "WARNING: routine_cleanup ended with status $?"
  fi
  # Released before the report: the report talks to the network and holds nothing.
  if { : >&8; } 2>/dev/null; then
    # Only our own line: a routine that never got the lock must not erase the holder's.
    grep -q "^$RT_NAME (pid $$) " "$RT_HEAVY_LOCK.holder" 2>/dev/null && rm -f "$RT_HEAVY_LOCK.holder"
    exec 8>&-
  fi
  routine_write_result unreported
  routine_report
  find "$RT_LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +30 -delete 2>/dev/null || true
  find "$RT_STATE/results" -maxdepth 1 -name '*.env' -type f -mtime +90 -delete 2>/dev/null || true
  local out
  out="$(routine_code "$RT_STATUS")"
  echo "=== $RT_NAME end, status=$RT_STATUS exit=$out ==="
  exit "$out"
}

# results/<stamp>.env and last.env, each written whole and then renamed. KEY=VALUE, one
# per line, meant to be parsed, never sourced. REPORT is the report's outcome: the
# watchdog reads it, since a red nobody heard is a silence like any other.
routine_write_result() {
  local res="$RT_STATE/results/$RT_STAMP.env" i
  {
    routine_kv ROUTINE "$RT_NAME"
    routine_kv STATUS "$RT_STATUS"
    routine_kv REASON "$RT_REASON"
    routine_kv EXIT "$(routine_code "$RT_STATUS")"
    for ((i = 0; i < ${#RT_EXTRA[@]}; i += 2)); do routine_kv "${RT_EXTRA[i]}" "${RT_EXTRA[i + 1]}"; done
    routine_kv STARTED "$RT_STAMP"
    # Epoch seconds of the same instant: the watchdog compares it with systemd's start of
    # the unit, so a result from an earlier run the same day never answers for this one.
    routine_kv STARTED_EPOCH "$RT_EPOCH"
    routine_kv FINISHED "$(date -u +%Y%m%dT%H%M%SZ)"
    routine_kv LOG "$RT_LOG"
    routine_kv REPORT "$1"
  } > "$res.tmp" && mv -f "$res.tmp" "$res"
  cp -f "$res" "$RT_STATE/last.env.tmp" && mv -f "$RT_STATE/last.env.tmp" "$RT_STATE/last.env"
  echo "result: $res (status=$RT_STATUS, report=$1)"
}

# What the routine says outside the machine, per its declared visibility:
#   ROUTINE_ISSUE=1   red comments on (or opens) the routine's issue on the destination;
#                     the first green closes it
#   ROUTINE_SLACK=red|always|never
# Both are set by the routine itself, beside the reason for its choice: visibility is
# decided routine by routine (stage 3, 2026-10-04), and the platform is never one of the
# channels -- it carries the official verdict alone (2026-10-02).
# Skipped, failed and blocked are the watchdog's to say: they are silences of the
# verdict, not verdicts. The report never changes the routine's status.
routine_report() {
  local outcome=none
  if [ "${ROUTINE_ISSUE:-0}" = "1" ] || [ "${ROUTINE_SLACK:-never}" != "never" ]; then
    case "$RT_STATUS" in
      green | red)
        # The publishing credentials and the lane's destination are read HERE, in a
        # subshell, and never by the routine: its work starts Langflow and may run
        # third-party code, and a token in its environment would reach all of it.
        if (
          # Without -u: a reference to an unset name inside these files must not abort
          # the report, as the watchdog reads the same file (review of #2190).
          set +u
          for f in "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" "${E2E_ROUTINE_LANE:-/root/.e2e-lane}"; do
            # shellcheck disable=SC1090
            [ -r "$f" ] && . "$f"
          done
          # The visibility too: a routine sets it with a plain assignment, and node reads
          # only the environment -- unexported, a red day reported nothing and said ok.
          export ROUTINE_ISSUE ROUTINE_SLACK ISSUE_HOST ISSUE_REPO ISSUE_CC GITHUB_TOKEN GH_TOKEN SLACK_WEBHOOK_URL 2>/dev/null
          node "$RT_REPO/scripts/routine-report.mjs" verdict "$RT_STATE/last.env"
        ); then
          outcome=ok
        else
          outcome=failed
          echo "ERROR: the report could not be delivered; the watchdog will say so"
        fi ;;
    esac
  fi
  routine_write_result "$outcome"
}

routine_kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n\r' '  ')"; }
