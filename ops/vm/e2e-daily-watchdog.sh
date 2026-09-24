#!/usr/bin/env bash
# Say something when the daily did NOT speak.
#
# ## Why this exists
#
# On Actions a missed run is visible: the workflow list shows a gap and a failed
# run shows red. A timer shows nothing at all. And for THIS lane the consequence is
# not merely operational — the stage's product is a list of differences between two
# verdicts, so **a run that did not happen is indistinguishable from a run with no
# divergence**. Without this, the VM goes down on a Tuesday, nobody notices, and the
# divergence list closes at zero for lack of data. Zero is also the cut criterion
# for stage 2, which is how a silent machine turns into a wrong decision.
#
# ## What it watches, and what it deliberately does not
#
# It asks SYSTEMD what happened, not a marker file the wrapper writes. A wrapper
# that dies before writing its own marker is exactly the case worth catching, and it
# would be the case a marker cannot report. `systemctl show` still knows the service
# ran and how it ended.
#
# It runs Mon..Fri, so the weekend needs no logic: the calendar in the timer is what
# keeps Saturday quiet, not a branch in here that could be wrong.
#
# **It cannot report this machine being off.** A detector on the machine it watches
# is blind to that machine being down — the classic dead man's switch limit. Stated
# rather than papered over: covering it needs a watcher somewhere else, and the two
# candidates today are the laptop (the dependency stage 15 exists to remove) and
# Actions (which goes away at stage 2). What it DOES cover is every failure the
# machine survives: the timer not firing, the unit failing, the run hanging, and the
# run dying before it could announce itself.
#
# ## The four ways the daily can go silent
#
#   A  it never started today
#   B  it is still running long after it should have finished
#   C  it finished without producing run-metadata.json — written BEFORE
#      phase_publish, so its absence means the run aborted before the point where it
#      would have posted to Slack. That is a failure nobody hears
#   D  it finished with a verdict and the Slack post FAILED. run-e2e.sh warns and
#      carries on by design (a broken webhook must not fail a good run), which is
#      correct and also means the day's verdict exists and was never delivered
#
# A red run is NOT one of these. A run that fails tests has spoken for itself, and
# repeating it here would train everyone to ignore this channel.
#
# Versioned since #1994; it lived in /root before that, and the copy there is left
# untouched as the rollback (point e2e-daily-watchdog.service back at it).
#
# Usage:
#   /root/e2e-qa/ops/vm/e2e-daily-watchdog.sh            # what the timer runs
#   DRY_RUN=1 /root/e2e-qa/ops/vm/e2e-daily-watchdog.sh  # decide and print, post nothing
set -uo pipefail

export HOME="${HOME:-/root}"

# The three inputs are overridable ONLY so the four branches below can be exercised
# on a real machine without waiting for a bad day to happen. Nothing in the timer
# sets them. A watchdog whose alarm paths have never been executed is a watchdog
# nobody has any reason to trust -- and this one's whole job is to be believed on the
# day it finally speaks.
UNIT="${WATCHDOG_UNIT:-e2e-daily.service}"
REPO="${WATCHDOG_REPO:-/root/e2e-qa}"
LOG_DIR="${WATCHDOG_LOG_DIR:-/var/log/e2e-daily}"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
# The run starts at 08:00 UTC. Recalibrated on 2026-09-14, because the wrapper went
# to SHARDS=4 the day before and these two constants move together -- the 150 here
# was 2.5x a 49-minute one-shard run, and it is the number the step 10 card flagged
# for revision at the shard change.
#
# The alarm point must sit BELOW the check offset or the branch is dead code: the
# check fires 60 min after the start, so a run still going when it runs has been over
# this line for 15 minutes. At the old pairing both numbers were 150 and the branch
# fired at the instant of the check, with no slack at all.
#
# 45 min is 2.4x the measured end to end of the 2026-09-13 confirmation run: 18.5 min
# from the run stamp to run-metadata.json, suite 16.0, four shards. Anything still
# running when this fires is stuck, not slow.
STILL_RUNNING_ALARM_AFTER_MIN="${STILL_RUNNING_ALARM_AFTER_MIN:-45}"
DRY_RUN="${DRY_RUN:-0}"
# Exactly 0 or 1, refused before anything runs (#2056). It is read below as `= "1"`, so
# a typo'd `yes` meant NOT a dry run: the one invocation whose purpose is to post
# nothing sent a fake incident to the channel. Same rule as run-e2e.sh's require_flag.
case "$DRY_RUN" in
  0 | 1) ;;
  *) echo "DRY_RUN must be exactly '0' or '1', got: '$DRY_RUN'" >&2; exit 1 ;;
esac

mkdir -p "$LOG_DIR"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$WATCHDOG_LOG"; }

# Every decision is written down, including the quiet ones. A watchdog whose silence
# leaves no trace cannot be distinguished from a watchdog that never ran — which is
# the same confusion it exists to remove, one level up.
say "--- check start"

TODAY_UTC="$(date -u +%Y-%m-%d)"
TODAY_STAMP="$(date -u +%Y%m%d)"

state="$(systemctl show "$UNIT" -p ActiveState --value 2>/dev/null)"
# LoadState, not ActiveState, decides whether the unit EXISTS. `systemctl show` on a
# unit that was deleted answers ActiveState=inactive rather than nothing -- so the
# first version's `[ -z "$state" ]` test was dead code, and a deleted schedule would
# have been reported as "it has never run": true, useless, and pointing at the wrong
# fix. Found by pointing this at does-not-exist.service, not by reading it.
load_state="$(systemctl show "$UNIT" -p LoadState --value 2>/dev/null)"
start_raw="$(systemctl show "$UNIT" -p ExecMainStartTimestamp --value --timestamp=unix 2>/dev/null | tr -d '@')"
result="$(systemctl show "$UNIT" -p Result --value 2>/dev/null)"

headline=""
body=""

if [ -z "$load_state" ] || [ "$load_state" = "not-found" ]; then
  # Not "no run": the unit is gone. Different cause, different fix, and reporting it
  # as a missed run would send someone looking at a schedule that no longer exists.
  headline="VM daily: the unit is missing"
  body="systemd has no $UNIT on this machine (LoadState=${load_state:-unknown}). The schedule is not late — it is absent. Check that e2e-daily.service and e2e-daily.timer are still installed and enabled."
elif [ -z "$start_raw" ]; then
  # NOT only "never ran". systemd drops execution timestamps when the machine
  # REBOOTS, so a machine that restarted since the last run lands here too -- and
  # the "no run today" branch below becomes unreachable on exactly the day it is
  # needed. Found on 2026-09-14: both VMs had rebooted the day before, and this
  # branch reported a unit that had run on Friday as one that had never run.
  #
  # The first version said "otherwise the timer is not reaching the service", which
  # is the same defect as the LoadState and RemainAfterExit ones above: a true
  # sentence pointing at the wrong fix. The two facts that separate the cases cost
  # one systemctl call each, so they are SENT rather than left to be inferred.
  boot_at="$(systemctl show -p UserspaceTimestamp --value 2>/dev/null)"
  last_trigger="$(systemctl show "${UNIT%.service}.timer" -p LastTriggerUSec --value 2>/dev/null)"
  headline="VM daily: systemd has no record of it running"
  body="$UNIT exists but has no recorded start, so there is no verdict for today either way.
That is EITHER a schedule that never reached the service, OR a reboot: systemd forgets execution timestamps when the machine restarts.
This machine booted: ${boot_at:-unknown}
The timer last fired: ${last_trigger:-no record since boot}
If the boot is recent, the run is simply missing for that day; if it is not, the timer is not reaching the service.
Check: systemctl status ${UNIT%.service}.timer $UNIT"
else
  start_day="$(date -u -d "@$start_raw" +%Y-%m-%d 2>/dev/null)"
  start_hm="$(date -u -d "@$start_raw" +%H:%M 2>/dev/null)"
  elapsed_min=$(( ( $(date -u +%s) - start_raw ) / 60 ))

  # "Still running" is decided by the EXIT timestamp, not by ActiveState. A oneshot
  # unit with RemainAfterExit=yes reports `active` forever after it finishes, so the
  # first version reported a service that ended yesterday as "still running after
  # 1436 min". e2e-daily.service does not set RemainAfterExit -- but a check that is
  # only correct for the unit it happens to watch is a check that breaks the day
  # somebody adds a line to that unit for an unrelated reason.
  exit_raw="$(systemctl show "$UNIT" -p ExecMainExitTimestamp --value --timestamp=unix 2>/dev/null | tr -d '@')"
  if [ -z "$exit_raw" ] || [ "$exit_raw" -lt "$start_raw" ]; then
    if [ "$elapsed_min" -ge "$STILL_RUNNING_ALARM_AFTER_MIN" ]; then
      headline="VM daily: still running after ${elapsed_min} min"
      body="The run started at ${start_hm} UTC and has not finished. Four shards went end to end in 18.5 min on 2026-09-13, so this is stuck rather than slow. It will be killed by TimeoutStartSec=4h; until then today produces no verdict.
Last log: $LOG_DIR/latest.log"
    else
      say "quiet: still running, ${elapsed_min} min in — under the ${STILL_RUNNING_ALARM_AFTER_MIN} min alarm point"
    fi
  elif [ "$start_day" != "$TODAY_UTC" ]; then
    headline="VM daily: no run today"
    body="The last start systemd recorded is ${start_day} ${start_hm} UTC. Today is ${TODAY_UTC} and this is a weekday, so a run was due at 08:00 UTC and did not happen.
A missing run is not an empty one: with no verdict for today, the two lanes cannot be compared, and the divergence list is short by a day rather than genuinely clean.
Check: systemctl status e2e-daily.timer e2e-daily.service"
  else
    # It ran today and finished. Did it get far enough to speak?
    run_dir=""
    for d in "$REPO"/runs/"$TODAY_STAMP"T*/; do [ -d "$d" ] && run_dir="$d"; done

    # A DRY_RUN invocation stops after the shard partition, so it legitimately
    # produces a run directory with no run-metadata.json -- the exact shape of case C.
    # This is not hypothetical: testing the daily unit with a DRY_RUN drop-in is how
    # the schedule itself was proved on 2026-09-04, and doing it again would make this
    # alarm cry wolf about the very technique used to verify it. The scheduled run
    # never sets DRY_RUN, so the check costs nothing on a real day.
    if grep -q 'DRY_RUN=1 — stopping after the partition' "$LOG_DIR/latest.log" 2>/dev/null; then
      say "quiet: the last invocation was a DRY_RUN, which produces no report by design"
    elif [ -z "$run_dir" ]; then
      headline="VM daily: ran today and produced nothing"
      body="The run started at ${start_hm} UTC and ended (${result}), but there is no run directory for ${TODAY_UTC} under ${REPO}/runs/. It aborted before it could produce or post anything.
Last log: $LOG_DIR/latest.log"
    elif [ ! -f "${run_dir}run-metadata.json" ]; then
      headline="VM daily: aborted before it could report"
      body="The run started at ${start_hm} UTC and ended (${result}), but ${run_dir} has no run-metadata.json. That file is written before the publish phase, so the run never reached the point where it would have posted to Slack — today's failure is one nobody would otherwise hear.
Last log: $LOG_DIR/latest.log"
    elif grep -q "the Slack notification failed" "$LOG_DIR/latest.log" 2>/dev/null; then
      # Deliberately a string match on run-e2e.sh's own warning. It is the only
      # evidence that exists: the notifier failing does not fail the run, by design.
      # If that wording changes upstream this check goes quiet — noted rather than
      # pretended away, and it is the least valuable of the four.
      headline="VM daily: it has a verdict and could not deliver it"
      body="The run finished (${result}) with a report in ${run_dir}, but run-e2e.sh reported that the Slack notification failed. Today's verdict exists on the machine and was never announced.
Last log: $LOG_DIR/latest.log"
    else
      say "quiet: started ${start_day} ${start_hm} UTC, finished (${result}), report at ${run_dir}"
    fi
  fi
fi

if [ -z "$headline" ]; then
  say "--- check end: nothing to report"
  exit 0
fi

# A delivery test has to be possible, and it has to be honest in the channel.
#
# The transport cannot be verified any other way: a Workflow Builder trigger answers
# HTTP 200 to a payload it does not understand and renders nothing, so "it posted"
# proves nothing and only a human seeing the message closes the loop. Whoever rebuilds
# this machine has to redo that check -- hence a knob rather than a one-off curl that
# lives in somebody's shell history.
if [ -n "${WATCHDOG_TEST_NOTE:-}" ]; then
  headline="[delivery test] $headline"
  body="$body

— This is a DELIVERY TEST of the missed-run alarm, not a real incident. ${WATCHDOG_TEST_NOTE}"
fi

say "ALARM: $headline"
say "       ${body//$'\n'/ | }"

if [ "$DRY_RUN" = "1" ]; then
  printf '\n=== DRY_RUN — would post ===\nheadline: %s\nbody: %s\n' "$headline" "$body"
  exit 0
fi

if [ -r /root/.e2e-secrets ]; then
  # shellcheck disable=SC1091
  . /root/.e2e-secrets
fi
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  say "could not post: SLACK_WEBHOOK_URL is not set"
  exit 1
fi

# Transport is keyed on the PATH segment, the same rule scripts/notify-slack.mjs
# follows and for the same reason: a Workflow Builder trigger answers 200 to Block
# Kit and renders nothing, so posting the wrong shape is indistinguishable from
# posting the right one. The three variables are ALWAYS sent, even empty — a
# declared trigger variable that the POST omits fails the whole trigger.
#
# This duplicates four lines of that script. It was written on the machine, where a
# repository change reached it only at the next scheduled pull. Now that it lives in
# the repository, moving the transport into notify-slack.mjs is possible -- and is not
# done in the same change that moves the file, so a regression has one cause.
payload="$(BODY="$body" HEADLINE="$headline" python3 -c '
import json, os
print(json.dumps({"headline": os.environ["HEADLINE"], "body": os.environ["BODY"], "links": ""}))
')"
case "$SLACK_WEBHOOK_URL" in
  */services/*)
    payload="$(BODY="$body" HEADLINE="$headline" python3 -c '
import json, os
print(json.dumps({"blocks": [
  {"type": "header", "text": {"type": "plain_text", "text": os.environ["HEADLINE"][:150]}},
  {"type": "section", "text": {"type": "mrkdwn", "text": os.environ["BODY"][:2900]}},
]}))
')" ;;
esac

http="$(curl -sS -o /tmp/watchdog-slack.out -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data "$payload" "$SLACK_WEBHOOK_URL" 2>>"$WATCHDOG_LOG")"
say "posted: HTTP $http"
[ "$http" = "200" ] || { say "the alarm itself could not be delivered"; exit 1; }
say "--- check end: alarm sent"
