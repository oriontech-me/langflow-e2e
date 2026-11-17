# shellcheck shell=bash
# wait_for_dns HOST... -- wait until every HOST resolves, then return.
#
# ## Why this exists
#
# On 2026-11-16 and 2026-11-17 the QA VM could not resolve public names from about
# 08:00 to 09:00 UTC. The daily starts at 08:00, so both runs aborted in about a minute:
# the pull failed, the published image listing timed out, and the version resolver
# refused to run because it had nothing to follow. The watchdog fired at 09:00 and could
# not post either, because hooks.slack.com did not resolve. Two days with no verdict and
# no alarm. By late morning the names resolved again.
#
# So the scripts that start in that window wait for the names first, with a bound, and
# say so in their log. When the names resolve on the first try this prints nothing and
# costs one lookup per host, so a normal day reads the same as before.
#
# ## What it prints, and why the watchdog reads it
#
#   dns-wait: cannot resolve: <hosts> -- waiting up to <N>s     (first failure)
#   dns-wait: nameserver <ip>: <timed out | status [address]>  (first failure, per server)
#   dns-wait: still failing after <S>s: <hosts>                 (every 5 attempts)
#   dns-wait: waited <S>s -- names resolve again                (recovered)
#   dns-wait: still failing after <S>s: <hosts> -- giving up    (bound reached)
#
# The per-server lines are the evidence for a network ticket: which resolver stopped
# answering, at the moment it stopped. e2e-daily-watchdog.sh reads the last "waited" or
# "still failing after" number from the daily's log and takes it off the run's elapsed
# time, so a run that spent its first hour waiting is not reported as stuck.
#
# ## The bound
#
# By the clock: DNS_WAIT_ATTEMPTS (default 60) lookups, DNS_WAIT_STEP_S (default 60)
# seconds apart, so about an hour, and the wait gives up at whichever comes first, the
# attempt count or (attempts - 1) * step seconds. Counting attempts alone was wrong:
# a lookup against a resolver that does not answer can hang for many seconds, and
# getent asks twice per host (IPv6, then IPv4), so an "hour" of attempts could run for
# hours. Each lookup is also capped at DNS_WAIT_LOOKUP_S (default 10) seconds with
# timeout(1) where it exists. Reaching the bound returns 1 and the caller goes on;
# whatever needed the network then fails the way it always did, with its own message.
# Waiting longer would hold the machine's other routines behind the daily for a day
# that may not come back.
wait_for_dns() {
  local attempts="${DNS_WAIT_ATTEMPTS:-60}" step="${DNS_WAIT_STEP_S:-60}" lookup="${DNS_WAIT_LOOKUP_S:-10}"
  case "$attempts" in '' | *[!0-9]* | 0) echo "dns-wait: DNS_WAIT_ATTEMPTS must be a positive whole number, got '$attempts' -- not waiting"; return 2 ;; esac
  case "$step" in '' | *[!0-9]*) echo "dns-wait: DNS_WAIT_STEP_S must be a whole number of seconds, got '$step' -- not waiting"; return 2 ;; esac
  case "$lookup" in '' | *[!0-9]* | 0) echo "dns-wait: DNS_WAIT_LOOKUP_S must be a positive whole number of seconds, got '$lookup' -- not waiting"; return 2 ;; esac
  [ "$#" -gt 0 ] || return 0
  # Without getent every lookup would "fail", and every day would wait the full hour.
  command -v getent >/dev/null 2>&1 || { echo "dns-wait: getent is not installed -- not waiting"; return 0; }

  local capped=()
  command -v timeout >/dev/null 2>&1 && capped=(timeout "$lookup")
  local attempt=1 started="$SECONDS" deadline failing host waited
  deadline=$(( SECONDS + (attempts - 1) * step ))
  while :; do
    failing=""
    for host in "$@"; do
      ${capped[@]+"${capped[@]}"} getent hosts "$host" >/dev/null 2>&1 || failing="$failing $host"
    done
    waited=$(( SECONDS - started ))
    if [ -z "$failing" ]; then
      [ "$attempt" -gt 1 ] && echo "dns-wait: waited ${waited}s -- names resolve again"
      return 0
    fi
    if [ "$attempt" -eq 1 ]; then
      echo "dns-wait: cannot resolve:$failing -- waiting up to $(( (attempts - 1) * step ))s"
      # shellcheck disable=SC2086  # one word per failing host; the first is diagnosed
      _dns_wait_diagnose $failing
    fi
    # With step 0 the deadline is now, so only the count can end the wait: that is how
    # the tests drive the loop without sleeping.
    if [ "$attempt" -ge "$attempts" ] || { [ "$step" -gt 0 ] && [ "$SECONDS" -ge "$deadline" ]; }; then
      echo "dns-wait: still failing after ${waited}s:$failing -- giving up"
      # The state at the end is evidence too, unless it was diagnosed a moment ago.
      # shellcheck disable=SC2086
      [ "$attempt" -gt 1 ] && _dns_wait_diagnose $failing
      return 1
    fi
    [ $(( attempt % 5 )) -eq 0 ] && echo "dns-wait: still failing after ${waited}s:$failing"
    sleep "$step"
    attempt=$(( attempt + 1 ))
  done
}

# One line per configured nameserver, asked directly for the first failing host. The
# machine's resolv.conf is systemd-resolved's upstream list, so these are the servers
# that actually stopped answering. Never fatal: no dig, or no resolv.conf, is said.
_dns_wait_diagnose() {
  local host="${1:-}" conf="${DNS_WAIT_RESOLV_CONF:-/etc/resolv.conf}" ns answer
  [ -n "$host" ] || return 0
  if ! command -v dig >/dev/null 2>&1; then
    echo "dns-wait: dig is not installed -- no per-nameserver detail"
    return 0
  fi
  [ -r "$conf" ] || { echo "dns-wait: $conf is unreadable -- no per-nameserver detail"; return 0; }
  # Each line says which of three things the server did, because a ticket needs the
  # difference: "timed out" (it did not answer at all), a status such as NXDOMAIN or
  # SERVFAIL (it answered and refused), or NOERROR and the first A record (it works;
  # a CNAME chain is skipped, so the address is the one the name lands on).
  local out status addr
  while read -r ns; do
    out="$(dig +time=3 +tries=1 "@$ns" "$host" 2>&1)"
    if printf '%s\n' "$out" | grep -q 'timed out\|no servers could be reached'; then
      echo "dns-wait: nameserver $ns: timed out ($host)"
      continue
    fi
    status="$(printf '%s\n' "$out" | sed -n 's/.*status: \([A-Z]*\).*/\1/p' | head -1)"
    addr="$(printf '%s\n' "$out" | awk '/ANSWER SECTION/ { f = 1; next } f && $4 == "A" { print $5; exit }')"
    echo "dns-wait: nameserver $ns: ${status:-unreadable answer}${addr:+ $addr} ($host)"
  done < <(awk '$1 == "nameserver" { print $2 }' "$conf")
}
