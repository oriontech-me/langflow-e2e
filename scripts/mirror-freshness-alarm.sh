#!/usr/bin/env bash
# The alarm around scripts/check-mirror-freshness.mjs. Two jobs, split by ANNOUNCE:
#
#   hourly (default)  asks the question and RECORDS the answer. Never posts.
#   ANNOUNCE=1        once, before the daily: posts only if the mirror is behind NOW.
#
# ## Why the channel hears about it once a day, not on every change
#
# The first version posted on every change of state: behind, then recovered. The mirror
# is pushed from a laptop, and launchd does not fire while the laptop sleeps, so every
# merge made with the lid closed became two messages. On 2026-09-23/24 that was four
# messages in one night for two stalls, and neither touched a verdict.
#
# A stale mirror costs something at ONE moment: when the daily checks it out. So the
# question that deserves the channel is "will the daily run an older suite?", asked
# half an hour before it starts. The rest is history, and the history is not lost: the
# hourly runs write it to HISTORY_FILE, and the daily's own message carries a one-line
# summary of the last 24h (scripts/mirror-freshness-summary.mjs).
#
# ## What still goes unsaid
#
# UNKNOWN at the announce check is not posted. The check could not ask, which says
# nothing about the mirror, and the daily's preflight asks again thirty minutes later
# and writes its answer into the run's evidence.
#
# Fail-soft everywhere. A missing webhook, a curl that fails, an unwritable history
# file: each is reported to stdout (which the journal keeps) and none of them makes this
# exit non-zero, because a broken notifier must not be read as a broken mirror.
#
# Usage:
#   scripts/mirror-freshness-alarm.sh
#   ANNOUNCE=1 scripts/mirror-freshness-alarm.sh
#   CHECK_BIN=/path/to/stub HISTORY_FILE=... SECRETS_FILE=... scripts/mirror-freshness-alarm.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

SECRETS_FILE="${SECRETS_FILE:-/root/.e2e-secrets}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e}"
# One line per look: `<epoch seconds>\t<current|not-current|unknown>`. Read by
# scripts/mirror-freshness-summary.mjs, which computes the same default path.
HISTORY_FILE="${HISTORY_FILE:-$STATE_DIR/mirror-freshness.history}"
# Enough for the 24h summary, with room to look back by hand after a long weekend.
HISTORY_DAYS="${HISTORY_DAYS:-7}"
ANNOUNCE="${ANNOUNCE:-0}"
# An executable PATH, not a command string: `$CMD` unquoted is word-split, so a command
# carrying quotes arrives mangled — the first version of this took a string and the
# test caught it on the first run, with the shell's own parse error travelling into a
# Slack message as though it were a verdict.
CHECK_BIN="${CHECK_BIN:-}"

# `. file` rather than systemd's EnvironmentFile=: the secrets file is a shell file with
# `export` on every line, and systemd would read the word `export` as part of the
# variable name and drop the lot with a warning nobody reads.
if [ -r "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
fi

if [ -n "$CHECK_BIN" ]; then
  output="$("$CHECK_BIN" 2>&1)"
else
  output="$(node scripts/check-mirror-freshness.mjs 2>&1)"
fi
code=$?
printf '%s\n' "$output"

# UNKNOWN is its own state: "the mirror is not current" is an assertion the check
# itself refuses to make when it could not tell.
case "$code" in
  0) state="current" ;;
  2) state="unknown" ;;
  *) state="not-current" ;;
esac

# Recorded on every run, announce included: the summary counts looks, and the announce
# check is one. Trimmed on write, so the file cannot grow without bound on a machine
# nobody logs into.
mkdir -p "$(dirname "$HISTORY_FILE")" 2>/dev/null || true
now="$(date +%s)"
# The not-a-regular-file refusal is explicit because `mv tmp DIR` does not fail: it
# moves the file INTO the directory and every later read finds nothing, silently.
if { [ ! -e "$HISTORY_FILE" ] || [ -f "$HISTORY_FILE" ]; } \
   && { if [ -r "$HISTORY_FILE" ]; then
       awk -F'\t' -v cut="$(( now - HISTORY_DAYS * 86400 ))" '$1 >= cut' "$HISTORY_FILE"
     fi
     printf '%s\t%s\n' "$now" "$state"; } > "$HISTORY_FILE.tmp" 2>/dev/null \
   && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE" 2>/dev/null; then
  :
else
  rm -f "$HISTORY_FILE.tmp" 2>/dev/null
  echo "[alarm] could not write $HISTORY_FILE — this look is missing from the daily's summary."
fi

if [ "$ANNOUNCE" != "1" ]; then
  echo "[alarm] recorded '$state' — the channel hears about the mirror only at the pre-daily check."
  exit 0
fi

case "$state" in
  current)
    echo "[alarm] current before the daily — nothing to say."
    exit 0 ;;
  unknown)
    echo "[alarm] could not tell before the daily — not posting; the daily's preflight asks again."
    exit 0 ;;
esac

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "[alarm] the mirror is behind before the daily and there is no SLACK_WEBHOOK_URL — said here only."
  exit 0
fi

# Transport is keyed on the URL PATH, the rule scripts/notify-slack.mjs and
# ops/vm/e2e-daily-watchdog.sh already follow. A Workflow Builder trigger
# (`/triggers/`) takes FLAT variables — `headline`, `body`, `links`, all three always
# sent — and drops any key it does not declare. `{"text": …}` is such a key: the
# trigger answers 200 and the channel gets its template with every variable empty,
# which is what the stall alarm of 2026-09-24 02:01 BRT looked like. The variables
# are inserted as plain text, so the workflow shape carries no mrkdwn and uses
# Unicode glyphs rather than `:shortcodes:`.
case "$SLACK_WEBHOOK_URL" in
  */triggers/*) transport="workflow"; main_ref="main" ;;
  *)            transport="text";     main_ref="\`main\`" ;;
esac

sentence="The e2e mirror is behind ${main_ref} and the daily starts in about 30 minutes: unless the mirror is synced before then, it will run an older suite."

# The HTTP status decides, because `curl -sS` exits 0 for a 404 and a 500 alike: a
# rotated webhook answers `404 no_service`, and without this the failure line never
# prints and the message is taken as delivered.
status="$(TRANSPORT="$transport" HEADLINE="🚨 $sentence" BODY="$output" \
  TEXT=":rotating_light: $sentence $output" python3 -c '
import json, os
if os.environ["TRANSPORT"] == "workflow":
    # The check writes `main` in its verdict; a backtick never belongs to a SHA or a
    # spec name, so dropping it loses nothing that the trigger would not print raw.
    body = os.environ["BODY"].replace("`", "")
    print(json.dumps({"headline": os.environ["HEADLINE"], "body": body, "links": ""}))
else:
    print(json.dumps({"text": os.environ["TEXT"]}))
' \
  | curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' --data @- "$SLACK_WEBHOOK_URL" 2>/dev/null)"
case "$status" in
  2??) echo "[alarm] posted: the mirror is behind before the daily." ;;
  # No retry: the next chance to say it is tomorrow's check, and by then the daily's
  # own message has already carried the fact in its mirror line.
  *)   echo "[alarm] the notification was not accepted (HTTP ${status:-none}) — the daily's message still carries the mirror line." ;;
esac
exit 0
