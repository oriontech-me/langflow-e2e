#!/usr/bin/env bash
# The alarm around scripts/check-mirror-freshness.mjs: asks the question on a schedule
# and says something OUT LOUD when the answer stops being "current".
#
# ## Why a second caller
#
# The daily's preflight asks it too, and that is the one that matters for a verdict.
# This one covers the hours and days the daily does not run — a mirror that stalls on
# a Friday evening is a mirror nobody asks about until Monday, and the stall of
# 2026-09-16 ran for 43 syncs precisely because nothing asked between runs.
#
# ## Why it is not simply "post every hour"
#
# A stall lasts days. Hourly posts would make 24 messages about one fact, and a channel
# that gets 24 identical alarms learns to mute the twenty-fifth — which is how an alarm
# becomes worse than none. So this posts on a CHANGE of state: when the mirror stops
# being current, and again when it recovers. The recovery message is not politeness: it
# is what tells a reader the earlier alarm is closed without them having to go look.
#
# Fail-soft everywhere. A missing webhook, a curl that fails, an unwritable state file:
# each is reported to stdout (which the journal keeps) and none of them makes this exit
# non-zero, because a broken notifier must not be read as a broken mirror.
#
# Usage:
#   scripts/mirror-freshness-alarm.sh
#   CHECK_BIN=/path/to/stub STATE_FILE=... SECRETS_FILE=... scripts/mirror-freshness-alarm.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

SECRETS_FILE="${SECRETS_FILE:-/root/.e2e-secrets}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/mirror-freshness.state}"
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

# UNKNOWN is its own state, and that matters for what gets SAID: "the mirror is not
# current" is an assertion the check itself refuses to make when it could not tell, and
# a 60-second DNS blip on an hourly timer would otherwise produce a false stall alarm
# plus a recovery an hour later — the credibility erosion this file argues against.
case "$code" in
  0) state="current" ;;
  2) state="unknown" ;;
  *) state="not-current" ;;
esac

# `none`, not `unknown`: UNKNOWN is a real verdict of the check now, and using it for
# "never looked" would make the first look after an install indistinguishable from a
# check that could not reach the source.
# The state file holds TWO things, and one is not enough: what was last OBSERVED, and
# whether it was ANNOUNCED. Observation alone cannot express "we saw this and could not
# say it" — the shape a failed POST leaves behind, and the shape the first of two
# consecutive UNKNOWNs leaves on purpose. Written as `<state>:<yes|no>`.
previous="none"; announced="no"
if [ -r "$STATE_FILE" ]; then
  raw="$(cat "$STATE_FILE" 2>/dev/null || echo "none:no")"
  previous="${raw%%:*}"
  case "$raw" in *:*) announced="${raw#*:}" ;; *) announced="yes" ;; esac
fi

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
remember() {
  printf '%s:%s\n' "$1" "$2" > "$STATE_FILE" 2>/dev/null \
    || echo "[alarm] could not write $STATE_FILE — the next run will repeat this message."
}

# Nothing to say, and that is most runs.
if [ "$state" = "current" ] && { [ "$previous" = "current" ] || [ "$previous" = "none" ] || [ "$announced" = "no" ]; }; then
  case "$previous" in
    none)    echo "[alarm] first observation, and the mirror is current — nothing to say." ;;
    current) echo "[alarm] unchanged (current) — not repeating it." ;;
    *)       echo "[alarm] back to current, and the earlier state was never announced — nothing to close." ;;
  esac
  remember current yes
  exit 0
fi

# A single UNKNOWN is weather. The check could not ask, which says nothing about the
# mirror, and one 60-second blip on an hourly timer must not produce an alarm plus a
# recovery an hour later. It is REMEMBERED though — otherwise the second look cannot
# know it is the second.
if [ "$state" = "unknown" ] && [ "$previous" != "unknown" ]; then
  echo "[alarm] could not tell this time — waiting for a second look before saying anything."
  remember unknown no
  exit 0
fi

# Already said, and still true.
if [ "$state" = "$previous" ] && [ "$announced" = "yes" ]; then
  echo "[alarm] unchanged ($state) — not repeating it."
  exit 0
fi

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  # Deliberately left UNANNOUNCED: nothing can deliver from here, so the journal
  # repeating the line is the only signal there is, and marking it announced would
  # record as handled a change no one was told about.
  echo "[alarm] state changed to '$state' and there is no SLACK_WEBHOOK_URL — said here only."
  remember "$state" no
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

case "$state" in
  current)  glyph=":white_check_mark:"; plain_glyph="✅"
            sentence="The e2e mirror is following ${main_ref} again." ;;
  unknown)  glyph=":warning:"; plain_glyph="⚠️"
            sentence="The e2e mirror's freshness could not be determined twice in a row — this says nothing about the mirror, only that the question cannot be asked from the VM." ;;
  *)        glyph=":rotating_light:"; plain_glyph="🚨"
            sentence="The e2e mirror is not current, so the VM lane may be running an older suite than ${main_ref}." ;;
esac

# The HTTP status decides, because `curl -sS` exits 0 for a 404 and a 500 alike: a
# rotated webhook answers `404 no_service`, and without this the failure line never
# prints and the change is recorded as delivered.
status="$(TRANSPORT="$transport" HEADLINE="$plain_glyph $sentence" BODY="$output" \
  TEXT="$glyph $sentence $output" python3 -c '
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
  2??)
    remember "$state" yes
    ;;
  *)
    # Remembered as SEEN but not announced, so the next run says it again. Writing it as
    # announced is the defect this replaced: one failed POST consumed the transition and
    # every later run reported "unchanged".
    echo "[alarm] the notification was not accepted (HTTP ${status:-none}) — not recording it as said, so the next run repeats it."
    remember "$state" no
    ;;
esac
exit 0
