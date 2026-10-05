#!/usr/bin/env bash
# Asks for today's image shadow (#2093): called by run-daily.sh after the official run.
#
# Writes the request the shadow reads -- the day, the version the official run resolved,
# and the suite commit it ran -- and starts e2e-shadow.service without waiting for it.
# It can neither fail nor delay the official run: the caller ignores its status, every
# outcome is one line on stdout (the daily's log), and the unit is ordered After= the
# daily, so it starts once the daily's own unit has finished.
#
# The cadence (#2184) is optional, and with neither knob set every run asks:
#   SHADOW_DAILY_UNTIL=YYYY-MM-DD  ask on every run through this UTC day
#   SHADOW_WEEKDAY=1..7            and on this ISO weekday (1 = Monday) after it
# The weekday alone means weekly from the start; the date alone means nothing after it.
#
# Usage (from run-daily.sh):
#   SHADOW_VERSION=<version> SHADOW_SUITE_SHA=<sha> ops/vm/request-shadow.sh
main() {
  set -uo pipefail
  local STATE="${E2E_SHADOW_STATE:-/root/e2e-shadow}"
  local UNIT="${E2E_SHADOW_UNIT:-e2e-shadow.service}"
  local version="${SHADOW_VERSION:-}" sha="${SHADOW_SUITE_SHA:-}"

  case "$version" in
    '' | *[!0-9A-Za-z.+-]*) echo "shadow: NOT requested — no usable version ('$version')"; return 0 ;;
  esac
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "shadow: NOT requested — no full suite commit ('$sha')"; return 0; }

  # One read of the clock, so the cadence and the request agree on the day.
  local today weekday until="${SHADOW_DAILY_UNTIL:-}" on="${SHADOW_WEEKDAY:-}"
  read -r today weekday < <(date -u '+%Y-%m-%d %u')
  [[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$weekday" =~ ^[1-7]$ ]] \
    || { echo "shadow: NOT requested — could not read today's date"; return 0; }
  [[ -z "$until" || "$until" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
    || { echo "shadow: NOT requested — SHADOW_DAILY_UNTIL is not a date ('$until')"; return 0; }
  [[ -z "$on" || "$on" =~ ^[1-7]$ ]] \
    || { echo "shadow: NOT requested — SHADOW_WEEKDAY is not 1 to 7 ('$on')"; return 0; }
  if [ -n "$until$on" ]; then
    local due=0
    # ISO dates compare as strings.
    if [ -n "$until" ] && ! [[ "$today" > "$until" ]]; then due=1; fi
    if [ "$weekday" = "$on" ]; then due=1; fi
    if [ "$due" = 0 ]; then
      if [ -n "$on" ]; then
        echo "shadow: NOT requested — weekly on ISO weekday $on${until:+ since $until}, and today is weekday $weekday"
      else
        echo "shadow: NOT requested — the daily shadow ended on $until"
      fi
      return 0
    fi
  fi

  if ! systemctl cat "$UNIT" > /dev/null 2>&1; then
    echo "shadow: NOT requested — $UNIT is not installed on this machine"
    return 0
  fi

  mkdir -p "$STATE" || { echo "shadow: NOT requested — cannot create $STATE"; return 0; }
  # Written whole and then renamed, so the shadow never reads half a request.
  local tmp="$STATE/request.env.tmp"
  printf 'SHADOW_DATE=%s\nSHADOW_VERSION=%s\nSHADOW_SUITE_SHA=%s\n' \
    "$today" "$version" "$sha" > "$tmp" && mv -f "$tmp" "$STATE/request.env" \
    || { echo "shadow: NOT requested — could not write $STATE/request.env"; return 0; }
  if systemctl start --no-block "$UNIT"; then
    echo "shadow: requested for $version at ${sha:0:12} ($UNIT queued)"
  else
    echo "shadow: request written, but $UNIT did not start — see systemctl status $UNIT"
  fi
  return 0
}
main "$@"
exit 0
