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

case "$code" in
  0) state="current" ;;
  *) state="not-current" ;;
esac

previous="unknown"
[ -r "$STATE_FILE" ] && previous="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
printf '%s\n' "$state" > "$STATE_FILE" 2>/dev/null \
  || echo "[alarm] could not write $STATE_FILE — the next run will repeat this message."

# First observation is not an alarm: a fresh state file on a machine that is FINE would
# otherwise announce itself, and an alarm that fires on installation is one people
# learn to dismiss.
if [ "$previous" = "unknown" ] && [ "$state" = "current" ]; then
  echo "[alarm] first observation, and the mirror is current — nothing to say."
  exit 0
fi
if [ "$state" = "$previous" ]; then
  echo "[alarm] unchanged ($state) — not repeating it."
  exit 0
fi

if [ "$state" = "current" ]; then
  text=":white_check_mark: The e2e mirror is following \`main\` again. ${output}"
else
  text=":rotating_light: The e2e mirror is not current, so the VM lane may be running an older suite than \`main\`. ${output}"
fi

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "[alarm] state changed to '$state' and there is no SLACK_WEBHOOK_URL — said here only."
  exit 0
fi
if ! printf '%s' "$text" \
  | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))' \
  | curl -sS --max-time 15 -X POST -H 'Content-Type: application/json' --data @- "$SLACK_WEBHOOK_URL" > /dev/null; then
  echo "[alarm] the notification failed to send — the state above is still the truth."
fi
exit 0
