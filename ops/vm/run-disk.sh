#!/usr/bin/env bash
# The disk routine: what e2e-routine-disk.service runs (stage 3, task 8). It keeps the
# one store on this machine that grows with no bound, and says when the disk fills,
# before a lane finds out by failing.
#
# ## What grows here, and what already has a rule (measured 2026-10-10, 57 of 248 GB)
#
#   run directories   the daily, the on-demand run and the shadow each keep their last 30
#                     (run-e2e.sh's RUNS_KEEP): about 470 MB a run, so bounded at roughly
#                     40 GB together. Logs are pruned by age in each wrapper.
#   docker images     each lane removes what it pulled (run-shadow.sh keeps today's
#                     nightly, run-migration.sh removes only the images absent before it,
#                     run-on-demand.sh its own builds). Nothing accumulates.
#   uv's cache        NO rule until this routine: every new target version installs again
#                     (the daily's venv, the migration's twelve cells), about 300 MB per
#                     weekday, 7.2 GB in its first three weeks. This routine caps it.
#   anything else     a human's: rehearsals, probes, spikes. Never touched here; the
#                     disk alarm below is what makes them visible when they matter.
#
# ## What it does
#
#   1. Measures the disk and uv's cache, and records both in the result every day. The
#      clean's result says what df got back, not only what du counted: a cache file
#      hard-linked into a venv is counted and freed by nothing (none on the qa today).
#   2. When the cache is over its cap (UV_CACHE_CAP_GB, 15 by decision of 2026-10-10),
#      takes the heavy-lane lock and runs `uv cache clean`. The lock is what keeps it off
#      an install in progress: every uv user on this machine is a heavy lane or the daily
#      (prepare-target-dist.sh, run-migration.sh), and the daily's priority comes first.
#      The cost is that the next install downloads again, about one day's worth.
#   3. When the disk is at or over DISK_ALARM_PCT (70, same decision), leaves an ALARM line
#      for the watchdog, with the largest directories under /root so the message says
#      where to look. The disk is measured before any wait (the daily's priority
#      included), again after each wait, and again after a clean; the ALARM comes from the last measure, on a skipped or failed day too, since
#      a busy day is the one most likely to be filling the disk.
#
# ## Verdicts
#
#   green    measured, and cleaned when it had to: the disk filling is an ALARM beside a
#            green day, never a red, because a full disk is not a product defect and a red
#            would open the routine's issue on the destination for it
#   failed   this machine: no uv, a measurement that could not be read, or a clean that
#            failed
#   skipped  the cache was over its cap and the heavy-lane lock never came within the
#            budget; nothing was cleaned, and tomorrow tries again
#
# ## Visibility
#
# None of its own: no issue, no Slack post. The watchdog says skipped, failed and the
# ALARM, which is everything here worth saying.
set -uo pipefail

REPO="${E2E_ROUTINE_REPO:-/root/e2e-qa}"
# shellcheck source=lib/routine.sh
. "$REPO/ops/vm/lib/routine.sh"

main() {
  routine_start disk
  # Visibility, decided with the routine (2026-10-10): only the watchdog speaks.
  ROUTINE_ISSUE=0
  ROUTINE_SLACK=never

  local cap_gb="${UV_CACHE_CAP_GB:-15}" path="${DISK_PATH:-/}"
  local budget="${DISK_WAIT_BUDGET_S:-3600}"
  # Globals, not locals: routine_cleanup reads them from the EXIT trap, after main.
  DK_ALARM_PCT="${DISK_ALARM_PCT:-70}"; DK_PATH="$path"; DK_USED=""; DK_AVAIL_GB=""; DK_AVAIL_KB=""
  [[ "$cap_gb" =~ ^[0-9]+$ ]] && [ "$cap_gb" -gt 0 ] || routine_end failed "UV_CACHE_CAP_GB must be a positive whole number of GB, got '$cap_gb'"
  [[ "$DK_ALARM_PCT" =~ ^[0-9]+$ ]] && [ "$DK_ALARM_PCT" -gt 0 ] && [ "$DK_ALARM_PCT" -le 100 ] \
    || { local bad="$DK_ALARM_PCT"; DK_ALARM_PCT=""; routine_end failed "DISK_ALARM_PCT must be a whole percentage from 1 to 100, got '$bad'"; }
  routine_set DISK_PATH "$path"
  routine_set DISK_ALARM_PCT "$DK_ALARM_PCT"

  # One budget for every wait: the daily's priority now, the lock later. Two full budgets
  # would outlast the unit's TimeoutStartSec, and a skipped day would end as SIGTERM's
  # failed (review of task 8).
  local t0=$SECONDS

  # The disk first, before ANY wait, the daily's priority included: a day that ends
  # skipped or failed still carries its numbers, and its ALARM (routine_cleanup), to the
  # watchdog, and a day the daily keeps the machine is the likeliest to be filling it.
  # df only reads, so it cannot disturb the daily. Measured again once the wait is over,
  # since the wait can last the whole budget.
  disk_measure || routine_end failed "could not read the disk usage of $path (df)"
  routine_wait_daily "$budget"
  disk_measure || routine_end failed "could not read the disk usage of $path (df)"

  command -v uv > /dev/null 2>&1 || routine_end failed "uv is not on PATH ($PATH): its cache cannot be measured or cleaned"
  local cache cache_mb
  cache="$(uv cache dir 2> /dev/null)"
  [ -n "$cache" ] || routine_end failed "uv did not say where its cache is (uv cache dir)"
  cache_mb="$(disk_dir_mb "$cache")" || routine_end failed "could not measure uv's cache at $cache"
  routine_set UV_CACHE "$cache"
  routine_set UV_CACHE_MB "$cache_mb"
  routine_set UV_CACHE_CAP_GB "$cap_gb"
  echo "uv cache: $cache_mb MB at $cache (cap $cap_gb GB)"

  local cleaned=no
  if [ "$cache_mb" -gt $((cap_gb * 1024)) ]; then
    echo "uv cache over its cap: waiting for the heavy-lane lock to clean it"
    local left=$((budget - (SECONDS - t0)))
    [ "$left" -ge 0 ] || left=0
    routine_wait_turn "$left"
    # The baseline for what the clean gave back is taken now, under the lock, not before
    # the wait: up to an hour of another heavy lane writing or freeing would otherwise be
    # counted as the clean's.
    disk_measure || routine_end failed "could not read the disk usage of $path (df) once the lock was taken"
    local before_kb="$DK_AVAIL_KB"
    if ! uv cache clean > "$RT_STATE/uv-clean.log" 2>&1; then
      routine_end failed "uv cache clean failed with the cache at $cache_mb MB: $(tail -n 3 "$RT_STATE/uv-clean.log" | tr '\n' ' ' | cut -c1-300)"
    fi
    local after_mb
    after_mb="$(disk_dir_mb "$cache")" || after_mb=0
    disk_measure || routine_end failed "uv's cache was cleaned, and the disk usage of $path could not be read after it (df)"
    # What the filesystem got back, not what du counted: a cache file hard-linked into a
    # venv is counted by du and freed by nothing (measured 2026-10-10: no such link on the
    # qa, so the two agree today).
    cleaned="yes, $cache_mb MB to $after_mb MB, $(( (DK_AVAIL_KB - before_kb) / 1024 )) MB returned to the disk"
    echo "uv cache cleaned: $cleaned"
  fi
  routine_set UV_CLEANED "$cleaned"

  local what="disk $DK_USED% used, $DK_AVAIL_GB GB free; uv cache $cache_mb MB"
  [ "$cleaned" = "no" ] || what="$what, cleaned ($cleaned)"
  routine_end green "$what"
}

# df on $DK_PATH into DK_USED (percent), DK_AVAIL_GB and DK_AVAIL_KB, and the result.
# The result keeps the LAST of each key, so a measure after the clean replaces the first.
disk_measure() {
  local used avail_kb
  read -r used avail_kb < <(df -Pk "$DK_PATH" 2> /dev/null | awk 'NR == 2 { sub(/%$/, "", $5); print $5, $4 }') || return 1
  [[ "$used" =~ ^[0-9]+$ ]] && [[ "$avail_kb" =~ ^[0-9]+$ ]] || return 1
  DK_USED="$used"; DK_AVAIL_KB="$avail_kb"; DK_AVAIL_GB=$((avail_kb / 1048576))
  routine_set DISK_USED_PCT "$DK_USED"
  routine_set DISK_AVAIL_GB "$DK_AVAIL_GB"
  echo "disk $DK_PATH: $DK_USED% used, $DK_AVAIL_GB GB free (alarm at $DK_ALARM_PCT%)"
}

# The EXIT trap's hook, before the result is written: the ALARM is decided from the LAST
# measure, whatever the verdict. A green, skipped or failed day all carry it.
routine_cleanup() {
  [ -n "${DK_USED:-}" ] && [ -n "${DK_ALARM_PCT:-}" ] || return 0
  [ "$DK_USED" -ge "$DK_ALARM_PCT" ] || return 0
  routine_set ALARM "the disk $DK_PATH is $DK_USED% used, at or over the $DK_ALARM_PCT% alarm, with $DK_AVAIL_GB GB free. Largest under /root: $(disk_largest). Run directories (30 per lane) and docker images already have rules; anything else there is a human's to remove."
}

# Size of a directory in MB, whole. Fails when it does not exist or du cannot read it.
disk_dir_mb() {
  [ -d "$1" ] || { echo 0; return 0; }
  local kb
  kb="$(du -sk "$1" 2> /dev/null | cut -f1)"
  [[ "$kb" =~ ^[0-9]+$ ]] || return 1
  echo $(( kb / 1024 ))
}

# The five largest entries directly under /root, for the alarm's message. Best effort, and
# BOUNDED: it runs from the EXIT trap, which a stopping unit gives only TimeoutStopSec
# (2 min) before SIGKILL, and a cold walk of /root (57 GB) can take longer -- killed there,
# the routine would write no result and its ALARM would be lost on the full-disk day.
# Past DISK_SURVEY_TIMEOUT_S the walk is killed and the list says it is incomplete. KILL,
# not TERM: routine_finish ignores TERM, and an ignored signal is inherited by du.
disk_largest() {
  local root="${DISK_SURVEY_ROOT:-/root}" limit="${DISK_SURVEY_TIMEOUT_S:-45}" out pid waited=0 cut="" list
  out="$(mktemp "${TMPDIR:-/tmp}/e2e-disk-survey.XXXXXX" 2> /dev/null)" || { printf 'not surveyed (no temp file)'; return 0; }
  du -xsk "$root"/* "$root"/.[!.]* > "$out" 2> /dev/null &
  pid=$!
  while kill -0 "$pid" 2> /dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -KILL "$pid" 2> /dev/null
      cut=" (survey cut at ${limit}s, incomplete: the largest may be missing)"
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2> /dev/null
  list="$(sort -rn "$out" | head -n 5 \
    | awk -F'\t' '{ n = split($2, p, "/"); printf "%s%s %.1f GB", (NR > 1 ? ", " : ""), p[n], $1 / 1048576 }')"
  rm -f "$out"
  printf '%s%s' "${list:-none measured}" "$cut"
}

main "$@"
