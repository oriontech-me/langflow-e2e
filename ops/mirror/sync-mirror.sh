#!/usr/bin/env bash
# Push the source repository's branches and tags to the destination the VM lane reads
# (#2041), from the QA VM itself, next to its only consumer.
#
# Until now a launchd job on a laptop pushed the mirror, and launchd does not fire while
# a laptop sleeps: every merge made with the lid closed left the destination behind
# until someone opened it. Here, "the mirror is current" and "the lane can run" fail
# together instead of independently: if this VM is down, the daily is down too.
#
# This is the laptop's ~/git-mirrors/sync-langflow.sh, versioned and in English, with its
# guard intact:
#   1. fetch the source into a bare mirror; a failed fetch ABORTS — the mirror may be
#      stale, and the push's --prune would then delete good branches on the destination;
#   2. for every branch and tag on the destination, the commit it points at must exist in
#      the mirror. One the mirror has NEVER SEEN can only have been born on the
#      destination (a push or a merge made there), and the force-push would lose it, so
#      the sync ABORTS (exit 2). One the mirror has but no local ref reaches is an
#      ORPHAN — a branch deleted on the source after a squash or rebase — and is pruned:
#      that false positive stalled 43 runs in a row on 2026-09-16..18;
#   3. push heads and tags with --prune.
# The only escapes are DRY_RUN=1 (fetch and verify, push nothing) and ALLOW_OVERWRITE=1
# (push over a divergence, on purpose).
#
# No alarm of its own: a sync that refuses or stops leaves the destination behind, and
# e2e-mirror-freshness already says that out loud. This only has to say WHY, and it says
# it on stdout, which the unit sends to the journal.
#
# Environment:
#   MIRROR_DIR       the bare mirror (default /root/mirror/langflow-e2e.git; created on
#                    first run, fetching heads and tags only)
#   SOURCE_URL       default https://github.com/oriontech-me/langflow-e2e.git
#   DEST_URL         default https://$ISSUE_HOST/$ISSUE_REPO from the lane file (no .git
#                    suffix, #2332); the host is never named in this repository
#   LANE_FILE        default /root/.e2e-lane
#   CREDENTIAL_HELPER  the git credential helper for the destination (default: this
#                    clone's scripts/git-credential-destination.sh, which mints a GitHub
#                    App installation token, #2518). Empty uses git's own configuration.
#   DRY_RUN, ALLOW_OVERWRITE  0/1, as above
#
# Exit: 0 pushed, up to date, or a clean dry run; 1 the fetch or the destination listing
# failed (nothing pushed); 2 a divergence was refused (nothing pushed); 3 the push failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MIRROR_DIR="${MIRROR_DIR:-/root/mirror/langflow-e2e.git}"
SOURCE_URL="${SOURCE_URL:-https://github.com/oriontech-me/langflow-e2e.git}"
LANE_FILE="${LANE_FILE:-/root/.e2e-lane}"
DRY_RUN="${DRY_RUN:-0}"
ALLOW_OVERWRITE="${ALLOW_OVERWRITE:-0}"
CREDENTIAL_HELPER="${CREDENTIAL_HELPER-$REPO/scripts/git-credential-destination.sh}"

say() { echo "[mirror-sync] $*"; }

for flag in DRY_RUN ALLOW_OVERWRITE; do
  case "${!flag}" in 0 | 1) ;; *) say "ERROR: $flag must be 0 or 1, got '${!flag}'"; exit 1 ;; esac
done

if [ -z "${DEST_URL:-}" ]; then
  # Only the two names, read in a subshell: anything else the lane file sets (a DRY_RUN,
  # a MIRROR_DIR) must never override the unit's own switches (#2041 review).
  DEST_URL="$( (set +u; ISSUE_HOST="" ISSUE_REPO=""
    # shellcheck disable=SC1090
    [ -r "$LANE_FILE" ] && . "$LANE_FILE" > /dev/null 2>&1
    [ -n "${ISSUE_HOST:-}" ] && [ -n "${ISSUE_REPO:-}" ] && printf 'https://%s/%s' "$ISSUE_HOST" "$ISSUE_REPO") )"
  if [ -z "$DEST_URL" ]; then
    say "ERROR: no destination: set DEST_URL, or ISSUE_HOST and ISSUE_REPO in $LANE_FILE"
    exit 1
  fi
fi
if [ -n "$CREDENTIAL_HELPER" ] && [ ! -x "$CREDENTIAL_HELPER" ]; then
  say "ERROR: the credential helper $CREDENTIAL_HELPER is not there or not executable (it ships with #2518's minting); set CREDENTIAL_HELPER= to use git's own configuration"
  exit 1
fi

# Never a prompt: a unit has no terminal, and a prompt would hang the timer's run.
export GIT_TERMINAL_PROMPT=0
# The destination's credential: only the helper this repository ships, so a personal
# token in root's git configuration is never what pushes (#2490).
GIT=(git -C "$MIRROR_DIR")
if [ -n "$CREDENTIAL_HELPER" ]; then
  GIT+=(-c credential.helper= -c "credential.helper=$CREDENTIAL_HELPER")
fi

# One sync at a time: a slow push still running when the next timer fires must not
# race a second prune against it.
if command -v flock > /dev/null 2>&1; then
  lock="${MIRROR_LOCK:-}"
  [ -n "$lock" ] || { [ -w /run/lock ] && lock=/run/lock/e2e-mirror-sync.lock || lock=/tmp/e2e-mirror-sync.lock; }
  exec 9> "$lock"
  flock -n 9 || { say "another sync is still running; this one ends"; exit 0; }
else
  say "NOTE: no flock here, so nothing stops two syncs from overlapping"
fi

if [ ! -d "$MIRROR_DIR" ]; then
  say "creating the mirror at $MIRROR_DIR (heads and tags of $SOURCE_URL)"
  mkdir -p "$(dirname "$MIRROR_DIR")"
  git init -q --bare "$MIRROR_DIR" \
    && git -C "$MIRROR_DIR" remote add origin "$SOURCE_URL" \
    && git -C "$MIRROR_DIR" config --replace-all remote.origin.fetch '+refs/heads/*:refs/heads/*' \
    && git -C "$MIRROR_DIR" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*' \
    || { say "ERROR: could not create the mirror"; exit 1; }
fi

say "sync started (dry_run=$DRY_RUN) -> ${DEST_URL}"

# --------------------------------------------------------------------- 1. fetch
if ! fetch_out="$(git -C "$MIRROR_DIR" fetch --prune origin 2>&1)"; then
  printf '%s\n' "$fetch_out" | sed 's/^/  /'
  say "ABORTED: the fetch from the source failed; nothing was pushed (status=fetch_failed)"
  exit 1
fi

# An empty or emptied source (a fetch that succeeds and prunes everything) would make
# every destination ref an orphan, and the push would delete them all. The source always
# has main; without it, nothing is pushed (#2041 review).
if ! git -C "$MIRROR_DIR" rev-parse --verify --quiet refs/heads/main > /dev/null; then
  say "ABORTED: the mirror has no main after the fetch — an empty source would empty the destination; nothing was pushed (status=fetch_failed)"
  exit 1
fi

# ------------------------------------------------------------ 2. verify the destination
if ! remote_refs="$("${GIT[@]}" ls-remote --heads --tags "$DEST_URL" 2>&1)"; then
  printf '%s\n' "$remote_refs" | sed 's/^/  /' | tail -n 15
  say "ABORTED: listing the destination failed; nothing was pushed (status=verify_failed)"
  exit 1
fi

diverged="" orphans="" dest_only=""
while read -r sha ref; do
  [ -n "$sha" ] || continue
  case "$ref" in *'^{}') continue ;; esac   # an annotated tag's peeled line
  commit="$(git -C "$MIRROR_DIR" rev-parse --verify --quiet "${sha}^{commit}")"
  if [ -z "$commit" ]; then
    diverged="${diverged}  $ref -> $sha (a commit the mirror has never seen)"$'\n'
    continue
  fi
  if [ -z "$(git -C "$MIRROR_DIR" for-each-ref --contains="$commit" --count=1 --format='%(refname)' refs/heads refs/tags)" ]; then
    orphans="${orphans}  $ref -> $sha"$'\n'
  elif ! git -C "$MIRROR_DIR" rev-parse --verify --quiet "$ref" > /dev/null; then
    # A NAME the source does not have, at a commit it does: a branch or tag made on the
    # destination with no new commit. The push's --prune deletes it, as the laptop's
    # always did; it is named here so that is never silent (#2041 review).
    dest_only="${dest_only}  $ref -> $sha"$'\n'
  fi
done <<< "$remote_refs"

[ "$DRY_RUN" = "1" ] && will="would be pruned" || will="pruned"
if [ -n "$orphans" ]; then
  say "orphan refs on the destination ($will unless the run stops: they came from the source and were deleted there):"
  printf '%s' "$orphans"
fi
if [ -n "$dest_only" ]; then
  say "WARNING: refs on the destination that the source does not name ($will unless the run stops — a branch or tag created there at a commit the source has):"
  printf '%s' "$dest_only"
fi

if [ -n "$diverged" ]; then
  say "DIVERGENCE on the destination:"
  printf '%s' "$diverged"
  if [ "$ALLOW_OVERWRITE" != "1" ]; then
    say "ABORTED: recover that work on the source (oriontech-me/langflow-e2e) before syncing; to overwrite on purpose, ALLOW_OVERWRITE=1 (status=diverged)"
    exit 2
  fi
  say "ALLOW_OVERWRITE=1: pushing over the divergence above"
fi

if [ "$DRY_RUN" = "1" ]; then
  say "DRY_RUN=1: the verification passed; nothing was pushed (status=dry_run, main=$(git -C "$MIRROR_DIR" rev-parse --short refs/heads/main 2>/dev/null || echo none))"
  exit 0
fi

# ---------------------------------------------------------------------- 3. push
push_rc=0
push_out="$("${GIT[@]}" push --porcelain --prune "$DEST_URL" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' 2>&1)" || push_rc=$?
printf '%s\n' "$push_out" | sed 's/^/  /'
# Porcelain flags: ' ' fast-forward, '+' forced, '-' deleted, '*' new ('=' is up to
# date and '!' rejected, neither a change).
changed="$(printf '%s\n' "$push_out" | awk -F'\t' '/^To /{next} /^Done/{next} { f=substr($0,1,1); if (f=="*"||f=="+"||f=="-"||f==" ") c++ } END{print c+0}')"
main="$(git -C "$MIRROR_DIR" rev-parse --short refs/heads/main 2>/dev/null || echo none)"
if [ "$push_rc" != "0" ]; then
  say "the push failed (exit $push_rc); main=$main (status=error)"
  exit 3
fi
if [ "$changed" = "0" ]; then
  say "up to date; main=$main (status=up_to_date)"
else
  say "$changed ref(s) changed; main=$main (status=changes_applied)"
fi
exit 0
