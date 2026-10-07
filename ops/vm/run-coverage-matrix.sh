#!/usr/bin/env bash
# The coverage-matrix routine: what e2e-routine-coverage-matrix.service runs (stage 3,
# task 7). It takes over .github/workflows/refresh-coverage-matrix.yml, which lost its
# daily trigger when the Actions daily was switched off on 2026-10-02 (#2159): it fired on
# the daily's workflow_run, and since then only its Monday fallback has run.
#
# ## What it does
#
# The same job as the workflow, on the source's main:
#
#   1. `npm run coverage:refresh`: the matrix's DERIVABLE axes (checklist mitigation,
#      @stable counts, test health from reports/daily-history.jsonl) and the dashboard feed.
#      The judged axes are never touched; refreshAreas throws rather than let it.
#   2. `npm run coverage:feed -- --check`: the feed must match data.json.
#   3. When docs/coverage-heatmap/ changed, one commit on top of main, pushed to it.
#   4. The feed POSTed to the QA platform, when its endpoint is configured.
#
# ## Why it works on the source, and never in the clone
#
# The clone is the destination's mirror, which can lag the source, and the input that
# matters most -- the history row the daily wrote minutes earlier (#2164) -- lands on the
# source first. So main is fetched from the source into a private ref, unpacked into a
# work tree of its own, computed there, and the commit is built with plumbing on top of
# exactly what was fetched, as run-e2e.sh's history_to_source does. The clone's working
# tree, index and branches are never touched. A push refused because main moved is
# fetched, recomputed and pushed again: the refresh is a function of the source, so
# recomputing on the new tip is the correct merge.
#
# ## Verdicts
#
#   green    computed and current on main: committed now, or nothing had moved
#   red      the repository's own refresh or feed check failed: data a human must look at
#   failed   this machine: fetch, unpack or push, no push credential, or the refresh's
#            tools (a module missing from the clone's node_modules, a full disk)
#   skipped  the daily lane held the machine past the budget, or another run of this
#            routine was going
#
# The POST is not the verdict. Its endpoint does not exist yet (the variable was never
# set, on Actions either): unset, PLATFORM says not-configured and nothing alarms, since
# that is a known state. Set and refused, the result carries an ALARM line for the
# watchdog, and the day stays green: the committed matrix is the product.
#
# ## When
#
# Weekdays 08:45 UTC, after the daily has written its history row. It waits for the
# daily lane (and the shadow) like every routine, and takes no heavy-lane lock: it starts
# no Langflow and no browser. A day with no daily still runs, because the checklist moves
# on its own; that is the case the workflow's Monday fallback existed for.
#
# ## Trying it without publishing
#
#   MATRIX_DRY_RUN=1   computes, keeps the work tree, and stops before the push and the
#                      POST: the result names the files that would change. This is how the
#                      port was compared with the workflow, byte for byte on one commit.
#                      Give it its own E2E_ROUTINE_STATE_ROOT and E2E_ROUTINE_LOG_ROOT: in
#                      the routine's own, its result would answer for the scheduled run at
#                      the watchdog's check.
set -uo pipefail

REPO="${E2E_ROUTINE_REPO:-/root/e2e-qa}"
# shellcheck source=lib/routine.sh
. "$REPO/ops/vm/lib/routine.sh"

MX_SOURCE_URL="${SOURCE_REMOTE_URL:-https://github.com/oriontech-me/langflow-e2e}"
MX_BRANCH="${SOURCE_PUSH_BRANCH:-main}"
MX_DIR="docs/coverage-heatmap"
# The identity of the VM lane's commits on the source (run-e2e.sh's auto-removal and
# history), so the robot's commits read as one robot.
MX_COMMITTER_NAME="${MATRIX_COMMITTER_NAME:-langflow-e2e vm routine}"
MX_COMMITTER_EMAIL="${MATRIX_COMMITTER_EMAIL:-langflow-e2e-vm@users.noreply.github.com}"
MX_MESSAGE="chore(coverage-matrix): refresh derivable axes (vm) [skip ci]"

main() {
  routine_start coverage-matrix
  # Visibility, decided with the routine (2026-10-07): a red is a repository problem a
  # human must fix, so it goes to the destination's issue and to Slack; green is quiet.
  ROUTINE_ISSUE=1
  ROUTINE_SLACK=red

  MX_WORK="$RT_STATE/work"
  MX_DRY_RUN="${MATRIX_DRY_RUN:-0}"
  case "$MX_DRY_RUN" in 0 | 1) ;; *) routine_end failed "MATRIX_DRY_RUN must be 0 or 1, got '$MX_DRY_RUN'" ;; esac
  # A dry run publishes nothing, the report included: its green would close the
  # routine's open issue, and its red would open one, for a run nobody scheduled (found
  # in the field rehearsal, 2026-10-07).
  if [ "$MX_DRY_RUN" = "1" ]; then
    ROUTINE_ISSUE=0
    ROUTINE_SLACK=never
  fi
  local attempts="${MATRIX_PUSH_ATTEMPTS:-3}" budget="${MATRIX_WAIT_BUDGET_S:-3600}"
  # One run at a time per state directory: two would share the work tree and remove it
  # from under each other (review of #2212). Held on fd 9 until the process exits.
  exec 9>> "$RT_STATE/run.lock" || routine_end failed "cannot open $RT_STATE/run.lock"
  flock -n 9 || routine_end skipped "another run of this routine is going, in $RT_STATE"
  # Per run, not per routine: a dry run with its own state directory shares this clone's
  # refs, and must not delete the scheduled run's ref. Removed by the EXIT trap.
  MX_REF="refs/e2e-matrix/$RT_STAMP-$$"

  routine_wait_daily "$budget"

  rm -rf "${MX_WORK:?}"; mkdir -p "$MX_WORK"
  # The tools the refresh runs on are the machine's: their absence is failed, never a red
  # charged to the repository (review of #2212).
  [ -x "$REPO/node_modules/.bin/ts-node" ] || routine_end failed "no node_modules/.bin/ts-node in $REPO: the refresh runs on the clone's installed tools"
  command -v npm > /dev/null 2>&1 || routine_end failed "npm is not on PATH"
  # Read here, kept in a shell variable that is never exported: the refresh runs the
  # repository's own code and has no business with a push credential.
  local token
  token="$(matrix_secret SOURCE_PUSH_TOKEN)"
  [ -n "$token" ] || routine_end failed "SOURCE_PUSH_TOKEN is not in the secrets file: main can be neither read nor written"

  local attempt sha rc
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    sha="$(matrix_fetch "$token")" || routine_end failed "could not read $MX_BRANCH from the source"
    routine_set SOURCE_SHA "$sha"
    echo "attempt $attempt: $MX_BRANCH is ${sha:0:12}"
    matrix_compute "$sha"
    routine_set CHANGED "${MX_CHANGED// /,}"

    if [ "$MX_DRY_RUN" = "1" ]; then
      routine_set PLATFORM dry-run
      if [ "$MX_N" -eq 0 ]; then
        routine_end green "dry run: already current at ${sha:0:12}; the work tree is $MX_WORK/tree"
      fi
      routine_end green "dry run: would commit $MX_N file(s) on top of ${sha:0:12} ($MX_CHANGED); the work tree is $MX_WORK/tree"
    fi

    if [ "$MX_N" -eq 0 ]; then
      matrix_post
      routine_end green "already current on $MX_BRANCH at ${sha:0:12}"
    fi

    rc=0; matrix_push "$token" "$sha" || rc=$?
    case "$rc" in
      0)
        routine_set COMMIT "$MX_COMMIT"
        matrix_post
        routine_end green "refreshed: $MX_N file(s) committed as ${MX_COMMIT:0:12} on top of ${sha:0:12}" ;;
      1) echo "the push was refused: $MX_BRANCH moved since ${sha:0:12}; fetching and recomputing" ;;
      *) routine_end failed "could not build the commit on top of ${sha:0:12}" ;;
    esac
  done
  routine_end failed "the push to $MX_BRANCH failed $attempts times: refused because it kept moving, or the credential cannot write (the log has git's words)"
}

# The source's branch, into the private ref; prints its commit.
matrix_fetch() {
  local token="$1" sha
  matrix_git "$token" fetch -q --no-write-fetch-head "$MX_SOURCE_URL" "+refs/heads/$MX_BRANCH:$MX_REF" >&2 || return 1
  sha="$(git -C "$REPO" rev-parse --verify -q "$MX_REF^{commit}")" || return 1
  printf '%s\n' "$sha"
}

# The commit's tree, unpacked, refreshed and checked. Sets MX_CHANGED to the files under
# $MX_DIR whose content differs from the commit's, space-separated, and MX_N to
# how many. A failing refresh or check is red.
matrix_compute() {
  local sha="$1" tree="$MX_WORK/tree" f rel new old
  rm -rf "$tree"; mkdir -p "$tree"
  git -C "$REPO" archive "$sha" | tar -x -C "$tree" || routine_end failed "could not unpack ${sha:0:12} into $tree"
  ln -s "$REPO/node_modules" "$tree/node_modules"
  if ! (cd "$tree" && npm run --silent coverage:refresh) > "$MX_WORK/refresh.log" 2>&1; then
    routine_end "$(matrix_npm_verdict "$MX_WORK/refresh.log")" "npm run coverage:refresh failed on ${sha:0:12}: $(matrix_tail "$MX_WORK/refresh.log")"
  fi
  if ! (cd "$tree" && npm run --silent coverage:feed -- --check) > "$MX_WORK/feed-check.log" 2>&1; then
    routine_end "$(matrix_npm_verdict "$MX_WORK/feed-check.log")" "the feed disagrees with data.json after the refresh, on ${sha:0:12}: $(matrix_tail "$MX_WORK/feed-check.log")"
  fi
  MX_CHANGED=""; MX_N=0
  while IFS= read -r f; do
    rel="${f#"$tree"/}"
    new="$(git -C "$REPO" hash-object "$f")"
    old="$(git -C "$REPO" rev-parse --verify -q "$sha:$rel" 2> /dev/null || true)"
    [ "$new" = "$old" ] || { MX_CHANGED="${MX_CHANGED:+$MX_CHANGED }$rel"; MX_N=$((MX_N + 1)); }
  done < <(find "$tree/$MX_DIR" -type f | LC_ALL=C sort)
  echo "computed on ${sha:0:12}: $MX_N file(s) changed${MX_CHANGED:+: $MX_CHANGED}"
}

# One commit on top of $2 with the changed files, pushed to the branch. Returns 0 pushed
# (MX_COMMIT set), 1 refused (the branch moved), 2 the commit could not be built.
matrix_push() {
  local token="$1" sha="$2" idx="$MX_WORK/index" rel blob tree
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git -C "$REPO" read-tree "$sha" || return 2
  # Paths under $MX_DIR carry no spaces; the list is split on them.
  for rel in $MX_CHANGED; do
    blob="$(git -C "$REPO" hash-object -w "$MX_WORK/tree/$rel")" || return 2
    GIT_INDEX_FILE="$idx" git -C "$REPO" update-index --add --cacheinfo "100644,$blob,$rel" || return 2
  done
  tree="$(GIT_INDEX_FILE="$idx" git -C "$REPO" write-tree)" || return 2
  MX_COMMIT="$(GIT_AUTHOR_NAME="$MX_COMMITTER_NAME" GIT_AUTHOR_EMAIL="$MX_COMMITTER_EMAIL" \
               GIT_COMMITTER_NAME="$MX_COMMITTER_NAME" GIT_COMMITTER_EMAIL="$MX_COMMITTER_EMAIL" \
               git -C "$REPO" commit-tree "$tree" -p "$sha" -m "$MX_MESSAGE")" || return 2
  matrix_git "$token" push -q "$MX_SOURCE_URL" "$MX_COMMIT:refs/heads/$MX_BRANCH" || return 1
  echo "pushed ${MX_COMMIT:0:12} to $MX_BRANCH"
}

# The feed, POSTed exactly as docs/coverage-heatmap/FEED.md documents it: the file on disk
# is the payload. Never changes the verdict; a refused POST is an ALARM for the watchdog.
matrix_post() {
  local endpoint auth code hdr="$MX_WORK/post.headers" resp="$MX_WORK/post.response"
  endpoint="$(matrix_secret QA_COVERAGE_MATRIX_ENDPOINT)"
  auth="$(matrix_secret QA_E2E_AUTOMATION_TOKEN)"
  if [ -z "$endpoint" ] || [ -z "$auth" ]; then
    routine_set PLATFORM not-configured
    echo "platform: not sent, QA_COVERAGE_MATRIX_ENDPOINT or its token is not configured"
    return 0
  fi
  # The bearer goes through a file, not argv, where any process on the machine reads it.
  (umask 077; printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$auth" > "$hdr")
  code="$(curl -sS --max-time 30 -o "$resp" -w '%{http_code}' -X POST "$endpoint" -H "@$hdr" \
          --data-binary "@$MX_WORK/tree/$MX_DIR/dashboard-feed.json" 2>> "$MX_WORK/post.log")" || code="${code:-000}"
  rm -f "$hdr"
  case "$code" in
    200 | 201)
      routine_set PLATFORM "sent ($code)"
      echo "platform: sent, HTTP $code" ;;
    *)
      routine_set PLATFORM "failed ($code)"
      routine_set ALARM "the coverage matrix is current on $MX_BRANCH, but the QA platform refused its feed: HTTP $code. $(matrix_tail "$resp")"
      echo "platform: FAILED, HTTP $code" ;;
  esac
}

# git with the push credential in this one command's environment, never exported.
matrix_git() {
  local token="$1"; shift
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')" \
    git -C "$REPO" "$@"
}

# One name from the secrets file, without sourcing it.
matrix_secret() {
  sed -n "s/^\(export \)\{0,1\}$1=//p" "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" 2> /dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"
}

# A failed npm step is the repository's (red) unless its log names the machine: a module
# the clone's node_modules lacks (main gained a dependency the clone's lockfile has not
# installed yet), a tool not found, a full disk, a permission (review of #2212).
matrix_npm_verdict() {
  if grep -qE "Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|command not found|: not found|ENOSPC|No space left on device|EACCES" "$1" 2> /dev/null; then
    echo failed
  else
    echo red
  fi
}

matrix_tail() { tail -n 3 "$1" 2> /dev/null | tr '\n' ' ' | cut -c1-300; }

routine_cleanup() {
  [ -z "${MX_REF:-}" ] || git -C "$REPO" update-ref -d "$MX_REF" 2> /dev/null || true
  rm -f "${MX_WORK:-/nonexistent}/post.headers" "${MX_WORK:-/nonexistent}/index"
  # The tree is a whole checkout; it is kept only when a dry run asked to compare it.
  [ "${MX_DRY_RUN:-0}" = "1" ] || rm -rf "${MX_WORK:-/nonexistent}/tree"
}

main "$@"
