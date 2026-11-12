#!/usr/bin/env bash
# Can this machine still reach the destination host, the one the daily pulls its suite
# from and opens its umbrella on? Asked hourly, and said on Slack only when the answer
# has been "no" long enough to matter (#2422).
#
# ## Why this exists
#
# On 2026-11-12 the QA VM stopped reaching the destination host on ports 22 and 443
# (connection refused; the host answered from outside the VM). The daily ran anyway:
# it could not pull, so it tested a two-day-old suite, and it could not open its
# umbrella, so a red day reached the destination only because someone opened it by
# hand. The hourly mirror check had been answering UNKNOWN since 02:00 UTC, six hours
# before the daily, and said nothing, by design: UNKNOWN is "could not ask", which says
# nothing about the mirror (scripts/mirror-freshness-alarm.sh). Reachability is a
# different question, and it deserves its own answer.
#
# ## When the channel hears about it
#
#   hourly (default)  probes and records. Posts ONCE when the host has been down for
#                     THRESHOLD consecutive looks, and ONCE when it comes back.
#   ANNOUNCE=1        before the daily: probes, and posts if the host is down NOW,
#                     whatever the streak. Not recorded in the history (see below), but
#                     it marks the outage as announced, so its recovery is posted too. A down host is about to cost the daily, and
#                     an outage that began after 05:00 UTC would not reach THRESHOLD in
#                     time. While an outage lasts this is also its daily reminder.
#
# THRESHOLD defaults to 3, measured rather than guessed: in 52 days of hourly mirror
# looks (2026-09-21 → 2026-11-12, 1115 looks) the destination went unanswered three
# times. Two lasted two looks and cleared by themselves (2026-10-10, 2026-11-06); the
# third is #2422. At 2 the channel would have had two false alarms; at 3 it had none,
# and #2422 would have been posted at 04:00 UTC, four hours before the daily. Two
# transient samples are few: revisit the number when the history file has more.
#
# ## The three answers
#
#   up       both ports accept a connection and the credential is not refused.
#   down     a port refuses or times out, or the credential is refused (#2330's outage
#            was a refused credential, not the network, and it cost the same umbrella).
#   unknown  there was nothing to probe (no ISSUE_HOST). It neither extends nor
#            breaks a streak. Ports open with a credential check that could not tell
#            counts as up: the host is reachable, and the credential has its own
#            preflight in the daily.
#
# The host and repository are read from the lane file, never written here: this
# repository is public, and /root/.e2e-lane holds the topology (ops/vm/run-daily.sh).
#
# Fail-soft everywhere, the mirror alarm's rule: a missing webhook, a curl that fails,
# an unwritable state file each go to stdout (the journal keeps it) and none of them
# makes this exit non-zero, because a broken notifier must not read as a broken host.
#
# Usage:
#   scripts/destination-reachability-alarm.sh
#   ANNOUNCE=1 scripts/destination-reachability-alarm.sh
#   PROBE_BIN=/path/to/stub STATE_DIR=... SECRETS_FILE=... LANE_FILE=... scripts/destination-reachability-alarm.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

SECRETS_FILE="${SECRETS_FILE:-/root/.e2e-secrets}"
LANE_FILE="${LANE_FILE:-/root/.e2e-lane}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e}"
# One line per look: `<epoch seconds>\t<up|down|unknown>\t<reason>`.
HISTORY_FILE="${HISTORY_FILE:-$STATE_DIR/destination-reachability.history}"
# Present while an outage has been announced; holds the epoch of its first down look.
# Its existence is what turns the next `up` into a recovery message, and what keeps a
# fourth down look from posting again.
ALERT_FILE="${ALERT_FILE:-$STATE_DIR/destination-reachability.alerted}"
HISTORY_DAYS="${HISTORY_DAYS:-7}"
THRESHOLD="${THRESHOLD:-3}"
ANNOUNCE="${ANNOUNCE:-0}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"
# An executable PATH, for the reason CHECK_BIN is one in the mirror alarm: a command
# string would be word-split.
PROBE_BIN="${PROBE_BIN:-}"
# The same, for the credential check inside the real probe (tests stub it).
CREDENTIAL_BIN="${CREDENTIAL_BIN:-}"
PROBE_PORTS="${PROBE_PORTS:-22 443}"

for f in "$SECRETS_FILE" "$LANE_FILE"; do
  if [ -r "$f" ]; then
    # shellcheck disable=SC1090
    . "$f"
  fi
done

case "$THRESHOLD" in
  ''|*[!0-9]*|0) echo "[reach] THRESHOLD='$THRESHOLD' is not a positive integer — using 3."; THRESHOLD=3 ;;
esac

# The real probe. Exit 0 = up, 1 = down, 2 = unknown; one line of reason on stdout.
probe() {
  local host="${ISSUE_HOST:-}" port failed=""
  if [ -z "$host" ]; then
    echo "no ISSUE_HOST in $LANE_FILE — nothing to probe"
    return 2
  fi
  # Both ports by default, because they fail the daily in different places: 22 is the
  # git pull (the clone's remote is ssh), 443 is the API that opens the umbrella.
  # A refusal, a timeout and a name that does not resolve all land here as "no
  # connection" — from the daily's side they cost the same.
  for port in $PROBE_PORTS; do
    if command -v timeout >/dev/null 2>&1; then
      timeout "$PROBE_TIMEOUT" bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null || failed="$failed $port"
    else
      bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null || failed="$failed $port"
    fi
  done
  if [ -n "$failed" ]; then
    echo "no connection on port(s)${failed}"
    return 1
  fi
  local out rc=0
  if [ -n "$CREDENTIAL_BIN" ]; then
    out="$("$CREDENTIAL_BIN" 2>&1)" || rc=$?
  else
    out="$(ISSUE_HOST="$host" ISSUE_REPO="${ISSUE_REPO:-}" node scripts/check-issue-credential.mjs 2>&1)" || rc=$?
  fi
  case "$rc" in
    0) echo "ports open, credential usable"; return 0 ;;
    # A refusal is an answer, and #2330 showed it costs the same umbrella as the network.
    3) echo "ports open, but the credential was refused — $(printf '%s' "$out" | head -1)"; return 1 ;;
    # Ports open and the API could not tell (no token here, a 5xx, a timeout): the host
    # is reachable, which is the question this alarm asks. Counting it as unknown would
    # keep an announced outage open for as long as the API hiccups, and every later
    # outage would read as "already announced". The credential has its own preflight.
    *) echo "ports open, credential not confirmed (exit $rc)"; return 0 ;;
  esac
}

rc=0
if [ -n "$PROBE_BIN" ]; then
  reason="$("$PROBE_BIN" 2>&1)" || rc=$?
else
  reason="$(probe)" || rc=$?
fi
reason="$(printf '%s' "$reason" | tr '\t\n' '  ' | sed 's/ *$//')"
case "$rc" in
  0) state="up" ;;
  1) state="down" ;;
  *) state="unknown" ;;
esac
echo "[reach] $state: $reason"

mkdir -p "$STATE_DIR" "$(dirname "$HISTORY_FILE")" "$(dirname "$ALERT_FILE")" 2>/dev/null || true
now="$(date +%s)"

# The streak BEFORE this look: consecutive `down` looks at the end of the history,
# skipping `unknown`, and the epoch of the first of them. This look is added in memory
# below, so a history that cannot be written loses the record, not the alarm.
prev_streak=0; prev_since=0
if [ -f "$HISTORY_FILE" ] && [ -r "$HISTORY_FILE" ]; then
  read -r prev_streak prev_since < <(awk -F'\t' '
    { s[NR] = $2; t[NR] = $1 }
    END {
      n = 0; first = 0
      for (i = NR; i >= 1; i--) {
        if (s[i] == "unknown") continue
        if (s[i] != "down") break
        n++; first = t[i]
      }
      print n, first
    }' "$HISTORY_FILE" 2>/dev/null || echo "0 0")
fi
case "$prev_streak" in ''|*[!0-9]*) prev_streak=0 ;; esac
case "$prev_since" in ''|*[!0-9]*) prev_since=0 ;; esac
case "$state" in
  down)    streak=$(( prev_streak + 1 )); since="$prev_since"; [ "$since" -gt 0 ] || since="$now" ;;
  unknown) streak="$prev_streak"; since="$prev_since" ;;
  *)       streak=0; since=0 ;;
esac

# Only the hourly look is recorded. The pre-daily look is half an hour off the hourly
# grid, and counting it would let three looks span one hour — THRESHOLD was measured on
# looks an hour apart — and post the outage alarm twice, 30 minutes apart.
if [ "$ANNOUNCE" != "1" ]; then
  # Through a temp file and trimmed on write, as the mirror alarm does; the
  # not-a-regular-file refusal is there because `mv tmp DIR` moves INTO the directory.
  if { [ ! -e "$HISTORY_FILE" ] || [ -f "$HISTORY_FILE" ]; } \
     && { if [ -r "$HISTORY_FILE" ]; then
         awk -F'\t' -v cut="$(( now - HISTORY_DAYS * 86400 ))" '$1 >= cut' "$HISTORY_FILE"
       fi
       printf '%s\t%s\t%s\n' "$now" "$state" "$reason"; } > "$HISTORY_FILE.tmp" 2>/dev/null \
     && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE" 2>/dev/null; then
    :
  else
    rm -f "$HISTORY_FILE.tmp" 2>/dev/null
    echo "[reach] could not write $HISTORY_FILE — this look counts now, but the next one will not see it."
  fi
fi

utc() { date -u -d "@$1" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date -u -r "$1" '+%Y-%m-%d %H:%M UTC'; }
hours() { awk -v s="$1" 'BEGIN { h = s / 3600; printf (h < 1 ? "under 1h" : "%.0fh"), h }'; }
host_name="${ISSUE_HOST:-the destination host}"
# The start of an announced outage, from the mark: the history is trimmed to
# HISTORY_DAYS, so for a long outage only the mark still knows when it began.
announced_since=""
if [ -e "$ALERT_FILE" ]; then
  announced_since="$(head -1 "$ALERT_FILE" 2>/dev/null)"
  case "$announced_since" in ''|*[!0-9]*) announced_since="$now" ;; esac
fi

# One outage is one message down and one message back. A recovery that could not be
# delivered leaves the mark in place, so an outage that starts again before the next
# delivered recovery is read as the same one: the channel never heard it end.
message=""
mark=""
case "$ANNOUNCE:$state" in
  1:down)
    if [ -n "$announced_since" ]; then
      message="Reminder: the daily starts in about 30 minutes and the QA VM still cannot reach ${host_name} (since $(utc "$announced_since")): ${reason}. Unless it comes back, the daily will test the suite it already has and will not open its umbrella."
    else
      message="The daily starts in about 30 minutes and the QA VM cannot reach ${host_name} (since $(utc "$since"), ${streak} check(s) in a row): ${reason}. Unless it comes back, the daily will test the suite it already has and will not open its umbrella."
      # Marked as announced: the channel has heard it is down, so it must hear when it
      # is back, and the hourly look must not announce it a second time.
      mark="$since"
    fi
    ;;
  1:*)
    echo "[reach] before the daily: $state — nothing to say."
    exit 0
    ;;
  0:down)
    if [ -n "$announced_since" ]; then
      echo "[reach] down for ${streak} look(s), already announced — not posting again."
      exit 0
    fi
    if [ "$streak" -lt "$THRESHOLD" ]; then
      echo "[reach] down for ${streak} of ${THRESHOLD} look(s) — not posting yet; a short blip clears by itself."
      exit 0
    fi
    message="The QA VM cannot reach ${host_name} since $(utc "$since") (${streak} checks in a row): ${reason}. If this lasts until the daily (08:00 UTC on weekdays), the daily will not pull the suite or open its umbrella. Seen from the VM only."
    mark="$since"
    ;;
  0:up)
    if [ -z "$announced_since" ]; then
      echo "[reach] up — nothing to say."
      exit 0
    fi
    message="The QA VM reaches ${host_name} again (unreachable from $(utc "$announced_since"), about $(hours $(( now - announced_since )))). The next daily can pull and open its umbrella."
    mark="clear"
    ;;
  *)
    echo "[reach] unknown — recorded, not counted."
    exit 0
    ;;
esac

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "[reach] no SLACK_WEBHOOK_URL — said here only: $message"
  exit 0
fi

# Transport keyed on the URL path, the rule scripts/notify-slack.mjs and the mirror
# alarm follow: a Workflow Builder trigger (`/triggers/`) takes flat variables and drops
# `text` silently.
case "$SLACK_WEBHOOK_URL" in
  */triggers/*) transport="workflow" ;;
  *)            transport="text" ;;
esac
case "$state" in
  up) glyph="✅"; emoji=":white_check_mark:"; headline="QA VM reaches the destination again" ;;
  *)  glyph="🚨"; emoji=":rotating_light:"; headline="QA VM cannot reach the destination" ;;
esac

status="$(TRANSPORT="$transport" HEADLINE="$glyph $headline" BODY="$message" \
  TEXT="$emoji $message" python3 -c '
import json, os
if os.environ["TRANSPORT"] == "workflow":
    print(json.dumps({"headline": os.environ["HEADLINE"], "body": os.environ["BODY"], "links": ""}))
else:
    print(json.dumps({"text": os.environ["TEXT"]}))
' \
  | curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' --data @- "$SLACK_WEBHOOK_URL" 2>/dev/null)"

case "$status" in
  2??)
    echo "[reach] posted: $message"
    # The mark moves only on delivery: an alarm the channel never received was not
    # given, so the next hourly look tries again.
    case "$mark" in
      clear) rm -f "$ALERT_FILE" 2>/dev/null ;;
      '')    : ;;
      *)     printf '%s\n' "$mark" > "$ALERT_FILE" 2>/dev/null \
               || echo "[reach] could not write $ALERT_FILE — the next look may post again." ;;
    esac
    ;;
  *)
    echo "[reach] the notification was not accepted (HTTP ${status:-none}) — the next look tries again."
    ;;
esac
exit 0
