#!/usr/bin/env bash
# The stable-orphans routine: what e2e-routine-stable-orphans.service runs (stage 3,
# task 6, #2224). It takes over .github/workflows/stable-orphan-reconcile.yml (#1746).
#
# ## What it does
#
# `@stable` removal is automatic (the daily's auto-removal, on the VM since 2026-09-28)
# and restoration is manual, a checkbox on a dedicated issue. This reconciles the two:
# every test that lost the tag, dated by its spec's history, against the open issues that
# name it. A removal nobody holds is an orphan. The reconciler is the repository's own,
# scripts/reconcile-stable-orphans.ts, unchanged in what it decides:
#
#   1. main is fetched from the source into a private ref and checked out as a detached
#      worktree of its own: the history walk needs the whole history, and the clone has
#      it. The clone's own working tree, index and branches are never touched.
#   2. The open issues are read from EVERY repository that owns trackers, by
#      scripts/orphan-report.mjs, each with the credential for its host: the source,
#      where the older dedicated issues live, and the destination, where the VM lane's
#      new ones open. Read from the source alone, an issue owned on the destination
#      would read as an orphan. Stage 4 drops the source from ORPHAN_TRACKER_REPOS.
#   3. The reconciler runs on that tree with the lists, and writes its report.
#   4. The report issue is kept current on the DESTINATION, under the reconciler's fixed
#      title: replaced each run, closed when nothing is left, never touched when a lookup
#      could not be made. A new orphan, one the last published run did not list, is also
#      posted to Slack.
#
# ## Verdicts
#
#   green    the reconciliation ran and its report is current. Findings are NOT red: the
#            check warns, never fails (#1746, decision 3); its findings are the issue.
#   red      the reconciler itself refused: an unreadable declarations file or an empty
#            spec parse. A repository problem a human must fix.
#   failed   this machine or the network: fetch, worktree, a shallow history, a tracker
#            or reference lookup that could not be made, the report issue that could not
#            be written, or the reconciler's tools missing
#   skipped  the daily lane held the machine past the budget, or another run was going
#
# ## When
#
# Mondays 10:00 UTC, as decided for the calendar (stage 3, task 3). It waits for the daily
# lane like every routine and takes no heavy-lane lock: it starts no Langflow and no
# browser.
#
# ## Trying it without publishing
#
#   ORPHANS_DRY_RUN=1   reads the trackers and reconciles, and stops before the issue and
#                       Slack: the report stays in the state directory. This is how the
#                       port was compared with the workflow. Give it its own
#                       E2E_ROUTINE_STATE_ROOT and E2E_ROUTINE_LOG_ROOT, as for the
#                       coverage matrix.
set -uo pipefail

REPO="${E2E_ROUTINE_REPO:-/root/e2e-qa}"
# shellcheck source=lib/routine.sh
. "$REPO/ops/vm/lib/routine.sh"

OR_SOURCE_REPO="${SOURCE_REPO:-oriontech-me/langflow-e2e}"
OR_SOURCE_URL="${SOURCE_REMOTE_URL:-https://github.com/$OR_SOURCE_REPO}"
OR_BRANCH="${SOURCE_BRANCH:-main}"

main() {
  routine_start stable-orphans
  # Visibility, decided with the routine (2026-10-07): the findings live in the report
  # issue on the destination, and only a NEW orphan goes to Slack, by orphan-report.mjs.
  # The routine's own issue and Slack are for a red, which here means the reconciler
  # itself broke.
  ROUTINE_ISSUE=1
  ROUTINE_SLACK=red

  OR_WORK="$RT_STATE/work"
  OR_DRY_RUN="${ORPHANS_DRY_RUN:-0}"
  case "$OR_DRY_RUN" in 0 | 1) ;; *) routine_end failed "ORPHANS_DRY_RUN must be 0 or 1, got '$OR_DRY_RUN'" ;; esac
  # A dry run publishes nothing, the routine's own report included.
  if [ "$OR_DRY_RUN" = "1" ]; then
    ROUTINE_ISSUE=0
    ROUTINE_SLACK=never
  fi
  local budget="${ORPHANS_WAIT_BUDGET_S:-3600}"
  # One run at a time per state directory: two would share the worktree.
  exec 9>> "$RT_STATE/run.lock" || routine_end failed "cannot open $RT_STATE/run.lock"
  flock -n 9 || routine_end skipped "another run of this routine is going, in $RT_STATE"
  # Per run: a dry run with its own state directory shares this clone's refs.
  OR_REF="refs/e2e-orphans/$RT_STAMP-$$"
  OR_TREE="$OR_WORK/tree"

  routine_wait_daily "$budget"

  orphans_cleanup_tree
  rm -rf "${OR_WORK:?}"; mkdir -p "$OR_WORK"
  [ -x "$REPO/node_modules/.bin/ts-node" ] || routine_end failed "no node_modules/.bin/ts-node in $REPO: the reconciler runs on the clone's installed tools"
  command -v node > /dev/null 2>&1 || routine_end failed "node is not on PATH"

  # The source token, read here and never exported. It reads main, the source's issues
  # and the gate references; the source is public, so reading is all it is used for.
  local token sha
  token="$(orphans_secret SOURCE_PUSH_TOKEN)"
  [ -n "$token" ] || routine_end failed "SOURCE_PUSH_TOKEN is not in the secrets file: the source can be neither read nor asked about its references"

  orphans_git "$token" fetch -q --no-write-fetch-head "$OR_SOURCE_URL" "+refs/heads/$OR_BRANCH:$OR_REF" \
    || routine_end failed "could not read $OR_BRANCH from the source"
  sha="$(git -C "$REPO" rev-parse --verify -q "$OR_REF^{commit}")" || routine_end failed "the fetched $OR_BRANCH does not resolve"
  routine_set SOURCE_SHA "$sha"
  # The walk dates removals from history; a shallow clone would make every one unknown.
  [ "$(git -C "$REPO" rev-parse --is-shallow-repository)" = "false" ] \
    || routine_end failed "the clone $REPO is shallow: the history walk needs the whole history"
  git -C "$REPO" worktree add -q --detach "$OR_TREE" "$sha" > "$OR_WORK/worktree.log" 2>&1 \
    || routine_end failed "could not check out ${sha:0:12} as a worktree: $(orphans_tail "$OR_WORK/worktree.log")"
  ln -s "$REPO/node_modules" "$OR_TREE/node_modules"
  echo "checked out ${sha:0:12} at $OR_TREE"

  # The trackers. Each list is read with its own host's credential, in a subshell; a list
  # that cannot be read fails the run, because an empty one would make every removal an
  # orphan.
  local files=() spec host repo n=0
  for spec in ${ORPHAN_TRACKER_REPOS:-source destination}; do
    n=$((n + 1))
    if ! orphans_issues "$spec" "$token" "$OR_WORK/issues-$n.json" >> "$OR_WORK/issues.log" 2>&1; then
      routine_end failed "the open issues of the $spec could not be read, so ownership is undecided: $(orphans_tail "$OR_WORK/issues.log")"
    fi
    files+=(--issues-file "$OR_WORK/issues-$n.json")
  done
  routine_set TRACKERS "${ORPHAN_TRACKER_REPOS:-source destination}"

  # The reconciler. The source token reaches it for `gh api graphql`, the gate
  # references: that lookup cannot be done ahead of the parse that finds them.
  local rc=0
  : > "$OR_WORK/outputs"
  (
    cd "$OR_TREE" || exit 3
    GH_TOKEN="$token" GH_HOST=github.com GH_REPO="$OR_SOURCE_REPO" \
      GITHUB_OUTPUT="$OR_WORK/outputs" RUN_LABEL="the VM routine \`stable-orphans\`, run $RT_STAMP on ${sha:0:12}" \
      ./node_modules/.bin/ts-node scripts/reconcile-stable-orphans.ts "${files[@]}" \
      --markdown "$OR_WORK/report.md" --json "$OR_WORK/report.json"
  ) > "$OR_WORK/reconcile.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    routine_end "$(orphans_verdict "$OR_WORK/reconcile.log")" "the reconciler ended with status $rc on ${sha:0:12}: $(orphans_tail "$OR_WORK/reconcile.log")"
  fi

  local orphans findings tracker_failed gate_failed
  orphans="$(orphans_output orphan_count)"
  findings="$(orphans_output finding_count)"
  tracker_failed="$(orphans_output tracker_lookup_failed)"
  gate_failed="$(orphans_output gate_lookup_failed)"
  routine_set ORPHANS "$orphans"
  routine_set FINDINGS "$findings"
  routine_set REPORT_FILE "$OR_WORK/report.md"
  [ "$tracker_failed" = "false" ] || routine_end failed "the reconciler could not decide ownership (tracker lookup failed); the report issue was left alone"
  [ "$gate_failed" = "false" ] || routine_end failed "a cited reference could not be looked up, so the gate verdict is undecided; the report issue was left alone"

  if [ "$OR_DRY_RUN" = "1" ]; then
    routine_end green "dry run: $orphans orphan(s), $findings finding(s) on ${sha:0:12}; the report is $OR_WORK/report.md"
  fi

  local out
  if ! out="$(orphans_publish)"; then
    echo "$out"
    routine_end failed "the report issue could not be made current on the destination: $(orphans_field PUBLISH_ERROR "$out")"
  fi
  echo "$out"
  local issue slack
  issue="$(orphans_field ISSUE "$out")"
  slack="$(orphans_field SLACK "$out")"
  routine_set ISSUE "$issue"
  routine_set NEW_ORPHANS "$(orphans_field NEW_ORPHANS "$out")"
  routine_set SLACK "$slack"
  case "$slack" in
    failed*) routine_set ALARM "the orphan report is current ($issue), but its Slack post for new orphans failed: ${slack#failed: }" ;;
  esac
  routine_end green "$orphans orphan(s), $findings finding(s) on ${sha:0:12}; report issue: $issue"
}

# One repository's open issues into a file. `source` is read with the source token (the
# repository is public, so the token only lifts the rate limit); `destination` with the
# lane's issue credential, read in a subshell from the secrets and lane files, as
# routine.sh's report reads them.
orphans_issues() {
  local spec="$1" token="$2" out="$3"
  case "$spec" in
    source)
      ORPHAN_ISSUES_HOST=github.com ORPHAN_ISSUES_REPO="$OR_SOURCE_REPO" ORPHAN_ISSUES_TOKEN="$token" \
        node "$REPO/scripts/orphan-report.mjs" issues "$out" ;;
    destination)
      (
        set +u
        orphans_load_publishing
        [ -n "${ISSUE_HOST:-}" ] && [ -n "${ISSUE_REPO:-}" ] || { echo "ISSUE_HOST and ISSUE_REPO are not in the lane file"; exit 1; }
        ORPHAN_ISSUES_HOST="$ISSUE_HOST" ORPHAN_ISSUES_REPO="$ISSUE_REPO" ORPHAN_ISSUES_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}" \
          node "$REPO/scripts/orphan-report.mjs" issues "$out"
      ) ;;
    *) echo "unknown tracker repository '$spec' in ORPHAN_TRACKER_REPOS (source or destination)"; return 1 ;;
  esac
}

# The issue and Slack, with the publishing credentials read only here.
orphans_publish() {
  (
    set +u
    orphans_load_publishing
    export ISSUE_HOST ISSUE_REPO GITHUB_TOKEN GH_TOKEN SLACK_WEBHOOK_URL 2> /dev/null
    node "$REPO/scripts/orphan-report.mjs" publish "$OR_WORK/outputs" "$OR_WORK/report.json" "$RT_STATE"
  )
}

orphans_load_publishing() {
  local f
  for f in "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" "${E2E_ROUTINE_LANE:-/root/.e2e-lane}"; do
    # shellcheck disable=SC1090
    [ -r "$f" ] && . "$f"
  done
}

# One key of the reconciler's $GITHUB_OUTPUT (single-line keys only).
orphans_output() { sed -n "s/^$1=//p" "$OR_WORK/outputs" | tail -n 1; }
# One KEY=VALUE of orphan-report.mjs's output.
orphans_field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | tail -n 1; }

# The reconciler refusing is the repository's (red) unless its log names the machine.
orphans_verdict() {
  if grep -qE "Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|command not found|: not found|ENOSPC|No space left on device|EACCES|spawnSync gh ENOENT" "$1" 2> /dev/null; then
    echo failed
  else
    echo red
  fi
}

# git with the source credential in this one command's environment, never exported.
orphans_git() {
  local token="$1"; shift
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')" \
    git -C "$REPO" "$@"
}

# One name from the secrets file, without sourcing it.
orphans_secret() {
  sed -n "s/^\(export \)\{0,1\}$1=//p" "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" 2> /dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"
}

orphans_tail() { tail -n 3 "$1" 2> /dev/null | tr '\n' ' ' | cut -c1-300; }

orphans_cleanup_tree() {
  [ -n "${OR_TREE:-}" ] || return 0
  if [ -e "$OR_TREE" ]; then
    git -C "$REPO" worktree remove --force "$OR_TREE" 2> /dev/null || rm -rf "$OR_TREE"
  fi
  git -C "$REPO" worktree prune 2> /dev/null || true
}

routine_cleanup() {
  [ -z "${OR_REF:-}" ] || git -C "$REPO" update-ref -d "$OR_REF" 2> /dev/null || true
  # The worktree is a whole checkout registered in the clone; it never outlives the run.
  orphans_cleanup_tree
}

main "$@"
