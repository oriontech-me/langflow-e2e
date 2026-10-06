#!/usr/bin/env bash
# Say something when a routine did not speak: the absence alarm of the VM lane's
# routines (ops/vm/lib/routine.sh), one check per routine, run by
# e2e-routine-watchdog@<routine>.service from that routine's own watchdog timer.
#
# ## Why it exists
#
# The daily has its own (e2e-daily-watchdog.sh), and the reason is the same: a timer that
# did not fire shows nothing, and a routine that did not run is indistinguishable from one
# that found nothing wrong. A routine adds a second kind of silence the daily does not
# have: it can run and decide not to give a verdict -- skipped (its turn never came),
# failed (the machine could not do its part) or blocked (a provider account drained). A
# red speaks for itself through routine-report.mjs. Every other way of ending is said
# here, and a red whose report could not be delivered is said here too.
#
# Like the daily's watchdog it asks SYSTEMD whether the routine ran, not the routine's
# own result: a routine that dies before writing one is exactly the case worth catching.
# The result file is read only once systemd says the routine ran today and ended.
#
# It cannot report this machine being off, for the reason the daily's watchdog states.
#
# ## The cases
#
#   the unit is missing          LoadState=not-found
#   no record of a start         never ran, or the machine rebooted since
#   no run today                 the last start is from another day
#   still running                at the check, which the timer places well past the
#                                routine's longest healthy run plus its wait budget
#   ended with no result         ran today, no result written for today
#   skipped / failed / blocked   the result says so; its REASON is the message
#   a red nobody heard           REPORT=failed in the result
#
# The calendar of the watchdog's timer is the routine's calendar: it checks only on the
# days the routine is due, so no branch in here decides what a weekend is.
#
# Usage:
#   e2e-routine-watchdog.sh <routine>             # what the unit runs
#   DRY_RUN=1 e2e-routine-watchdog.sh <routine>   # decide and print, post nothing
set -uo pipefail

export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:$PATH"

ROUTINE="${1:-}"
[[ "$ROUTINE" =~ ^[a-z][a-z0-9-]{0,40}$ ]] || { echo "usage: $0 <routine>  (got '${ROUTINE}')" >&2; exit 2; }
DRY_RUN="${DRY_RUN:-0}"
case "$DRY_RUN" in
  0 | 1) ;;
  *) echo "DRY_RUN must be exactly '0' or '1', got: '$DRY_RUN'" >&2; exit 1 ;;
esac

# Overridable ONLY so every branch can be exercised without waiting for a bad day.
UNIT="e2e-routine-$ROUTINE.service"
REPO="${WATCHDOG_REPO:-/root/e2e-qa}"
STATE="${E2E_ROUTINE_STATE_ROOT:-/root/e2e-routines}/$ROUTINE"
LOG_DIR="${E2E_ROUTINE_LOG_ROOT:-/var/log}/e2e-$ROUTINE"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"

mkdir -p "$LOG_DIR"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$WATCHDOG_LOG"; }
say "--- check start"

# Days by epoch arithmetic, not `date -d`: the same in GNU and BSD date, so the branches
# that depend on the day are tested where the tests run.
NOW="$(date -u +%s)"
MIDNIGHT=$((NOW - NOW % 86400))
TODAY_STAMP="$(date -u +%Y%m%d)"
hm() { printf '%02d:%02d' $(( ($1 % 86400) / 3600 )) $(( ($1 % 3600) / 60 )); }

load_state="$(systemctl show "$UNIT" -p LoadState --value 2>/dev/null)"
start_raw="$(systemctl show "$UNIT" -p ExecMainStartTimestamp --value --timestamp=unix 2>/dev/null | tr -d '@')"
exit_raw="$(systemctl show "$UNIT" -p ExecMainExitTimestamp --value --timestamp=unix 2>/dev/null | tr -d '@')"
result="$(systemctl show "$UNIT" -p Result --value 2>/dev/null)"
[[ "$start_raw" =~ ^[0-9]+$ ]] || start_raw=""
[[ "$exit_raw" =~ ^[0-9]+$ ]] || exit_raw=""

headline=""
body=""
field() { grep -E "^$1=" "$STATE/last.env" 2>/dev/null | tail -1 | sed "s/^$1=//"; }

if [ -z "$load_state" ] || [ "$load_state" = "not-found" ]; then
  headline="Routine $ROUTINE: the unit is missing"
  body="systemd has no $UNIT on this machine (LoadState=${load_state:-unknown}). The schedule is not late, it is absent: check that $UNIT and e2e-routine-$ROUTINE.timer are installed and the timer enabled."
elif [ -z "$start_raw" ]; then
  # Never ran, OR the machine rebooted: systemd forgets execution timestamps on a reboot
  # (found on the daily's watchdog, 2026-09-14). The two facts that tell them apart are
  # sent, not inferred.
  boot_at="$(systemctl show -p UserspaceTimestamp --value 2>/dev/null)"
  last_trigger="$(systemctl show "e2e-routine-$ROUTINE.timer" -p LastTriggerUSec --value 2>/dev/null)"
  headline="Routine $ROUTINE: systemd has no record of it running"
  body="$UNIT exists but has no recorded start, so there is no result for today.
That is EITHER a schedule that never reached the service, OR a reboot since its last run.
This machine booted: ${boot_at:-unknown}
The timer last fired: ${last_trigger:-no record since boot}
Check: systemctl status e2e-routine-$ROUTINE.timer $UNIT"
elif [ "$start_raw" -lt "$MIDNIGHT" ]; then
  headline="Routine $ROUTINE: no run today"
  body="The last start systemd recorded is $(( (MIDNIGHT - start_raw) / 86400 + 1 )) day(s) ago, at $(hm "$start_raw") UTC. The routine was due today and did not start.
Check: systemctl status e2e-routine-$ROUTINE.timer $UNIT"
elif [ -z "$exit_raw" ] || [ "$exit_raw" -lt "$start_raw" ]; then
  # By the exit timestamp, not ActiveState: a oneshot with RemainAfterExit=yes is
  # `active` forever after it ends (the daily's watchdog, first version).
  headline="Routine $ROUTINE: still running"
  body="It started at $(hm "$start_raw") UTC and has not finished, $(( (NOW - start_raw) / 60 )) min later. The check is placed past its longest healthy run plus its wait for a turn, so this is stuck rather than slow. If the check also sits past the unit's TimeoutStartSec, systemd has already tried to stop it and failed; otherwise today has no result until that timeout ends it.
Last log: $LOG_DIR/latest.log"
else
  started="$(field STARTED)"
  started_epoch="$(field STARTED_EPOCH)"
  [[ "$started_epoch" =~ ^[0-9]+$ ]] || started_epoch=0
  status="$(field STATUS)"
  reason="$(field REASON)"
  report="$(field REPORT)"
  # This run's, not merely today's: a result is the one systemd's last start produced
  # only when it began at or after that start. A manual run at 03:00 must not answer
  # for a 09:15 run that was killed before writing anything.
  if [ "${started:0:8}" != "$TODAY_STAMP" ] || [ "$started_epoch" -lt "$start_raw" ]; then
    headline="Routine $ROUTINE: ran today and left no result"
    body="It started at $(hm "$start_raw") UTC and ended (${result:-unknown}), but $STATE/last.env is not this run's (it started ${started:-never}). It died before its EXIT trap could write one -- SIGKILL, an OOM kill, or a bug before the library was loaded.
Last log: $LOG_DIR/latest.log"
  else
    case "$status" in
      green | red)
        # Quiet only on a delivery known to have happened (ok) or not asked for (none).
        # `unreported` is a run killed during its report, and anything else is unknown.
        if [ "$report" != "ok" ] && [ "$report" != "none" ]; then
          headline="Routine $ROUTINE: $status, and the report was not delivered (${report:-no record})"
          body="$reason
The result is on the machine, and the issue or the Slack post it asked for did not go out.
Last log: $LOG_DIR/latest.log"
        else
          say "quiet: $status today, report=${report:-none}"
        fi ;;
      skipped | failed | blocked)
        headline="Routine $ROUTINE: $status today"
        body="$reason
Last log: $LOG_DIR/latest.log" ;;
      *)
        headline="Routine $ROUTINE: a result this check does not know"
        body="STATUS='${status}' in $STATE/last.env.
Last log: $LOG_DIR/latest.log" ;;
    esac
  fi
fi

if [ -z "$headline" ]; then
  say "--- check end: nothing to report"
  exit 0
fi

if [ -n "${WATCHDOG_TEST_NOTE:-}" ]; then
  headline="[delivery test] $headline"
  body="$body

-- This is a DELIVERY TEST of the routine alarm, not a real incident. ${WATCHDOG_TEST_NOTE}"
fi

say "ALARM: $headline"
say "       ${body//$'\n'/ | }"

if [ "$DRY_RUN" = "1" ]; then
  printf '\n=== DRY_RUN — would post ===\nheadline: %s\nbody: %s\n' "$headline" "$body"
  exit 0
fi

if [ -r "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" ]; then
  # Without -u: a reference to an unset name inside the file must not abort the alarm.
  set +u
  # shellcheck disable=SC1090
  . "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}"
  set -u
fi
export SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
if node "$REPO/scripts/routine-report.mjs" alarm "$headline" "$body" >> "$WATCHDOG_LOG" 2>&1; then
  say "--- check end: alarm sent"
else
  say "the alarm itself could not be delivered"
  exit 1
fi
