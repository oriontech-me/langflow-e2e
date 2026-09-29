#!/usr/bin/env bash
# Asks for today's image shadow (#2093): called by run-daily.sh after the official run.
#
# Writes the request the shadow reads -- the day, the version the official run resolved,
# and the suite commit it ran -- and starts e2e-shadow.service without waiting for it.
# It can neither fail nor delay the official run: the caller ignores its status, every
# outcome is one line on stdout (the daily's log), and the unit is ordered After= the
# daily, so it starts once the daily's own unit has finished.
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
  if ! systemctl cat "$UNIT" > /dev/null 2>&1; then
    echo "shadow: NOT requested — $UNIT is not installed on this machine"
    return 0
  fi

  mkdir -p "$STATE" || { echo "shadow: NOT requested — cannot create $STATE"; return 0; }
  # Written whole and then renamed, so the shadow never reads half a request.
  local tmp="$STATE/request.env.tmp"
  printf 'SHADOW_DATE=%s\nSHADOW_VERSION=%s\nSHADOW_SUITE_SHA=%s\n' \
    "$(date -u +%Y-%m-%d)" "$version" "$sha" > "$tmp" && mv -f "$tmp" "$STATE/request.env" \
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
