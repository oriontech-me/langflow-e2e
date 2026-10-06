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
#   SHADOW_WEEKDAY=1..5            and once per ISO week: the first run on or after this
#                                  ISO weekday (1 = Monday) that week
# The weekday alone means weekly from the start; the date alone means nothing after it.
#
# "First run on or after": a Monday with no daily run -- the machine down, a holiday --
# is caught up on the next run that week, instead of the week passing with no shadow and
# no line saying so (review of #2185). The week of the last request that queued the unit
# is kept in $STATE/requested-week.
#
# Usage (from run-daily.sh):
#   SHADOW_VERSION=<version> SHADOW_SUITE_SHA=<sha> ops/vm/request-shadow.sh
# A calendar date, not only its shape: 2026-10-90 sorts after every real October day and
# would silently stretch the daily cadence (review of #2185). Pure bash, so GNU and BSD
# date behave the same.
shadow_real_date() {
  [[ "$1" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || return 1
  local y=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]})) d=$((10#${BASH_REMATCH[3]})) dim
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] || return 1
  case "$m" in
    2) dim=28; if [ $((y % 4)) = 0 ] && { [ $((y % 100)) != 0 ] || [ $((y % 400)) = 0 ]; }; then dim=29; fi ;;
    4 | 6 | 9 | 11) dim=30 ;;
    *) dim=31 ;;
  esac
  [ "$d" -le "$dim" ]
}

main() {
  set -uo pipefail
  local STATE="${E2E_SHADOW_STATE:-/root/e2e-shadow}"
  local UNIT="${E2E_SHADOW_UNIT:-e2e-shadow.service}"
  local version="${SHADOW_VERSION:-}" sha="${SHADOW_SUITE_SHA:-}"

  case "$version" in
    '' | *[!0-9A-Za-z.+-]*) echo "shadow: NOT requested — no usable version ('$version')"; return 0 ;;
  esac
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "shadow: NOT requested — no full suite commit ('$sha')"; return 0; }

  # Before the cadence: "not installed" is the rollback's signal, and a weekly cadence
  # must not hide it on four days out of five (review of #2185).
  if ! systemctl cat "$UNIT" > /dev/null 2>&1; then
    echo "shadow: NOT requested — $UNIT is not installed on this machine"
    return 0
  fi

  # One read of the clock, so the cadence and the request agree on the day. A date that
  # fails or prints nothing leaves both empty, which the check below refuses.
  local today="" weekday="" week="" until="${SHADOW_DAILY_UNTIL:-}" on="${SHADOW_WEEKDAY:-}"
  read -r today weekday week < <(date -u '+%Y-%m-%d %u %G-W%V' 2> /dev/null) || true
  [[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$weekday" =~ ^[1-7]$ && "$week" =~ ^[0-9]{4}-W[0-9]{2}$ ]] \
    || { echo "shadow: NOT requested — could not read today's date"; return 0; }
  [[ -z "$until" ]] || shadow_real_date "$until" \
    || { echo "shadow: NOT requested — SHADOW_DAILY_UNTIL is not a date ('$until')"; return 0; }
  # 1 to 5: the daily runs Monday to Friday, so a weekend weekday would never be due and
  # each day would only say "today is weekday N" (review of #2185).
  [[ -z "$on" || "$on" =~ ^[1-5]$ ]] \
    || { echo "shadow: NOT requested — SHADOW_WEEKDAY is not 1 to 5, the days the daily runs ('$on')"; return 0; }
  local catchup=""
  if [ -n "$until$on" ]; then
    local due=0 last=""
    # ISO dates compare as strings.
    if [ -n "$until" ] && ! [[ "$today" > "$until" ]]; then due=1; fi
    if [ "$due" = 0 ] && [ -n "$on" ] && [ "$weekday" -ge "$on" ]; then
      last="$(cat "$STATE/requested-week" 2> /dev/null || true)"
      if [ "$last" != "$week" ]; then
        due=1
        [ "$weekday" = "$on" ] || catchup=" (catching up: no shadow was requested on weekday $on this week)"
      fi
    fi
    if [ "$due" = 0 ]; then
      if [ -z "$on" ]; then
        echo "shadow: NOT requested — the daily shadow ended on $until"
      elif [ "$weekday" -lt "$on" ]; then
        echo "shadow: NOT requested — weekly on ISO weekday $on${until:+ after $until}, and today is weekday $weekday"
      else
        echo "shadow: NOT requested — weekly on ISO weekday $on${until:+ after $until}, and this week's ($week) was already requested"
      fi
      return 0
    fi
  fi

  mkdir -p "$STATE" || { echo "shadow: NOT requested — cannot create $STATE"; return 0; }
  # Written whole and then renamed, so the shadow never reads half a request.
  local tmp="$STATE/request.env.tmp"
  printf 'SHADOW_DATE=%s\nSHADOW_VERSION=%s\nSHADOW_SUITE_SHA=%s\n' \
    "$today" "$version" "$sha" > "$tmp" && mv -f "$tmp" "$STATE/request.env" \
    || { echo "shadow: NOT requested — could not write $STATE/request.env"; return 0; }
  if systemctl start --no-block "$UNIT"; then
    # Only a request that queued the unit counts for the week: one that did not is
    # asked again on the next run.
    printf '%s\n' "$week" > "$STATE/requested-week" 2> /dev/null \
      || echo "shadow: WARNING — could not record $week in $STATE/requested-week: the next runs this week will ask again"
    echo "shadow: requested for $version at ${sha:0:12} ($UNIT queued)$catchup"
  else
    echo "shadow: request written, but $UNIT did not start — see systemctl status $UNIT"
  fi
  return 0
}
main "$@"
exit 0
