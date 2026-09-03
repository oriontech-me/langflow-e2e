#!/usr/bin/env bash
# Put the target's source clone ON the commit the CI is testing, and make sure the
# build in it belongs to that commit.
#
# ## Why this is a separate script
#
# scripts/start-langflow-source.sh promises, in its own header and in three places in
# its code, NOT to touch the clone: a source checkout on a shared VM is also somebody's
# working tree, and a lane that silently moves HEAD makes every later run
# unattributable. It refuses to build the frontend for the same reason. Those refusals
# are correct and this script does not weaken them — it is the one place allowed to
# move the clone and to build in it, invoked deliberately, announcing what it did.
#
# So the division is: this script owns the clone's POSITION and its BUILD; the starter
# owns the instance. The starter then only has to ask whether the build in front of it
# belongs to HEAD, which is a question it can answer without touching anything.
#
# ## Why this exists at all
#
# The daily compares a VM verdict with the Actions one, and that comparison is only
# about the ENVIRONMENT if both sides run the same product. Nothing enforced that:
# Actions pulls `langflow-nightly:latest` on every run, while a source clone sits
# wherever someone last left it. On 2026-09-03 that was `release-1.12.0` built on
# 08-25, against a CI on 1.13.0.dev1 — a full release cycle and nine days. Every
# difference between the two arrives in the divergence list as "a real failure only
# Actions saw", which is a changelog wearing an environment's clothes.
#
# scripts/resolve-target-version.mjs answers WHICH commit (and why the published image
# decides it, not the git tag). This script is the other half: obeying that answer.
#
# ## Why the commit, and never `main`
#
# TARGET_SHA is the preferred input because upstream's nightly DELETES AND RECREATES
# its tag names, so `v1.13.0.dev1` can point somewhere new after the 1.13.0.dev1 image
# shipped — the resolver says so in its own header. TARGET_REF is carried for the log
# and the stamp, and is used as a target only when no sha is available at all.
#
# What the registry digest does and does not settle, because the distinction decides
# how much this placement is worth. The digest picks the VERSION STRING: the resolver
# matches `latest`'s digest against the other published tags. The COMMIT is then looked
# up by TAG NAME in the git ref listing — the very mapping that drifts. So a sha handed
# to this script is commit parity only as far as that tag was trustworthy when it was
# read, and when the tag cannot be found the resolver reports an EMPTY sha rather than
# a wrong one. A caller must not turn that emptiness into a checkout of the tag name:
# that asks for the ref the resolver has just said it could not find, and the refusal
# below then costs a whole run. scripts/run-e2e.sh does not prepare without a sha for
# exactly that reason (see target_preparation_plan there). Handed a ref by hand, this
# script obeys it — the operator is the one making the claim then.
#
# `main` is refused outright. It is not what the nightly builds — upstream resolves
# the newest `release-X.Y.Z` branch — so a clone on `main` tests something the CI
# never tests, which is the exact failure this script exists to remove. A typo that
# lands on `main` must not be indistinguishable from success.
#
# ## Why the build stamp
#
# `LANGFLOW_SRC_REF` in the starter left a debt the starter's own header describes: a
# checkout moves the backend, and the PREVIOUS build's `index.html` stays where it is.
# The backend then serves an old UI against a new backend and every spec passes or
# fails for reasons nobody can attribute — a green run against the wrong build, which
# is the worst outcome a scheduled lane has.
#
# The existence of assets is not evidence that they belong to HEAD. The stamp is: it
# records the commit they were built from, next to the clone so it survives a reboot
# (a stamp under /tmp would make every reboot look like a stale build). And it is
# REMOVED BEFORE the build starts, never after it fails — an interrupted build must
# leave "unknown", because a stamp that outlives the assets it describes is worse than
# no stamp at all: it is a confident wrong answer.
#
# ## Why deps and frontend are timed apart
#
# Because the number decides where this script gets invoked from. If the frontend is
# the whole cost, the rebuild becomes its own step, fired when the resolution changes;
# if it is minutes, it fits at the head of every run. That is a measurement, not an
# opinion, so the script reports the two halves separately every time it runs.
#
# ## Usage
#
#   TARGET_SHA=964a1eb1... TARGET_REF=v1.13.0.dev1 TARGET_BRANCH=release-1.13.0 \
#     LANGFLOW_SRC_REPO=$HOME/langflow ./scripts/prepare-target-source.sh
#
#   PREPARE_SKIP_BUILD=1 ...    # move the clone, report what a build would do
#   PREPARE_FORCE_REBUILD=1 ... # rebuild even when the stamp agrees with HEAD
#   PREPARE_FETCH=0 ...         # offline: use what the clone already has
#
# Human progress goes to stderr; stdout carries ONLY `key=value` lines, so a caller
# can capture the summary without parsing prose:
#
#   prepared_sha=<sha>  prepared_ref=<ref>  moved=yes|no
#   rebuilt=yes|no  rebuild_reason=<why>  deps_s=<n>  frontend_s=<n>  total_s=<n>
#
# Environment (all optional except the target):
#   LANGFLOW_SRC_REPO       the clone to prepare
#   LANGFLOW_SRC_REMOTE     remote to fetch from (default: origin)
#   TARGET_SHA/_REF/_BRANCH what to move to; SHA wins, BRANCH only aids the fetch
#   LANGFLOW_SRC_FRONTEND_DIR  where the built UI is served from
#   LANGFLOW_SRC_STAMP_FILE    where the build stamp lives
#   PREPARE_FETCH, PREPARE_ALLOW_DIRTY, PREPARE_FORCE_REBUILD, PREPARE_SKIP_BUILD
set -euo pipefail

REPO="${LANGFLOW_SRC_REPO:-$HOME/langflow-project/langflow}"
REMOTE="${LANGFLOW_SRC_REMOTE:-origin}"
TARGET_SHA="${TARGET_SHA:-}"
TARGET_REF="${TARGET_REF:-}"
TARGET_BRANCH="${TARGET_BRANCH:-}"
FRONTEND_DIR="${LANGFLOW_SRC_FRONTEND_DIR:-${REPO}/src/backend/base/langflow/frontend}"
STAMP_FILE="${LANGFLOW_SRC_STAMP_FILE:-${REPO}/.langflow-e2e-build-stamp}"
DO_FETCH="${PREPARE_FETCH:-1}"
ALLOW_DIRTY="${PREPARE_ALLOW_DIRTY:-0}"
FORCE_REBUILD="${PREPARE_FORCE_REBUILD:-0}"
SKIP_BUILD="${PREPARE_SKIP_BUILD:-0}"

# uv lives in ~/.local/bin and cron does not load it — the trap that the orchestrator
# already exports a PATH for. Repeated here because this script is also invoked by
# hand over `ssh <host> 'bash -s'`, where the same non-interactive shell applies.
export PATH="${HOME}/.local/bin:${PATH}"

say() { echo "$*" >&2; }
emit() { echo "$*"; }
die() { echo "ERROR: $*" >&2; exit 2; }

# --- What we were asked to become ----------------------------------------------
[ -n "${TARGET_SHA}" ] || [ -n "${TARGET_REF}" ] \
  || die "neither TARGET_SHA nor TARGET_REF was given. This script does not pick a
target: scripts/resolve-target-version.mjs does, from the published image, and being
told is the whole point — a script that guesses is a script that can guess \`main\`."

# Refused for all three inputs, not just the checkout target: TARGET_BRANCH steers the
# fetch, and fetching `main` to then check out a commit "reachable from it" is the same
# mistake wearing a different flag.
for value in "${TARGET_SHA}" "${TARGET_REF}" "${TARGET_BRANCH}"; do
  case "${value}" in
    main | master | refs/heads/main | refs/heads/master)
      die "refusing to prepare the target from '${value}'. Upstream's nightly builds the
newest release-X.Y.Z branch, never ${value}, so a clone there tests something the CI
never tests — and the divergence list would fill with product changelog."
      ;;
  esac
done

[ -d "${REPO}" ] || die "no clone at ${REPO}. Set LANGFLOW_SRC_REPO."
git -C "${REPO}" rev-parse --git-dir > /dev/null 2>&1 || die "${REPO} is not a git clone."

# --- Refuse to start work that cannot finish ------------------------------------
# Checked BEFORE the checkout, not before the build. A missing npm discovered after
# the move leaves the clone on the new commit with the old build and no stamp, which
# is a state the starter has to refuse — so the machine ends up neither where it was
# nor where it was going, over a tool that was never there.
if [ "${SKIP_BUILD}" != "1" ]; then
  command -v npm > /dev/null 2>&1 \
    || die "npm is not on PATH, and the frontend build needs it. On a non-interactive
shell (cron, \`ssh host 'bash -s'\`) a node installed through a version manager is
often absent — check with \`ssh <host> 'command -v npm'\`, not from a login shell."
  command -v uv > /dev/null 2>&1 \
    || die "uv is not on PATH, and it is the only thing that builds this clone: the
root dependencies resolve through [tool.uv.sources] workspace = true, which pip does
not read. It usually lives in ~/.local/bin, which cron does not load."
fi

# --- A shared clone may hold somebody's work ------------------------------------
DIRTY_COUNT="$(git -C "${REPO}" status --porcelain | grep -vcF "$(basename "${STAMP_FILE}")" || true)"
if [ "${DIRTY_COUNT}" -gt 0 ] && [ "${ALLOW_DIRTY}" != "1" ]; then
  say "$(git -C "${REPO}" status --short | head -20)"
  die "${REPO} has ${DIRTY_COUNT} modified path(s). Moving HEAD would discard or
strand them, and a lane that does that silently makes every later run unattributable.
Clean the tree, or set PREPARE_ALLOW_DIRTY=1 if you know those changes are disposable."
fi

BEFORE_SHA="$(git -C "${REPO}" rev-parse HEAD)"
BEFORE_REF="$(git -C "${REPO}" rev-parse --abbrev-ref HEAD)"
# A clone this script has already prepared is DETACHED, and `rev-parse --abbrev-ref`
# answers "HEAD" there — so the naive hint reads `checkout HEAD`, which reverts
# nothing. Found by running it on the target, not by reading it: the second run is the
# one that hits it, and the second run is every run after adoption. The commit is
# always a usable answer; a branch name is only preferable when there is one.
BEFORE_POS="${BEFORE_SHA}"
[ "${BEFORE_REF}" != "HEAD" ] && BEFORE_POS="${BEFORE_REF}"
say "before: ${BEFORE_REF} @ ${BEFORE_SHA:0:10}"
say "revert with: git -C ${REPO} checkout ${BEFORE_POS}"

# --- Fetch, then insist the target actually exists -------------------------------
if [ "${DO_FETCH}" = "1" ]; then
  say "fetching ${REMOTE} (tags included)..."
  git -C "${REPO}" fetch --quiet --tags "${REMOTE}" \
    || die "fetch from ${REMOTE} failed. Nothing has been moved."
fi

target_exists() {
  git -C "${REPO}" cat-file -e "${1}^{commit}" 2> /dev/null
}

WANT="${TARGET_SHA:-${TARGET_REF}}"
if ! target_exists "${WANT}"; then
  # One retry, and only through the branch that was named. Upstream recreates nightly
  # tags, so a tag fetch can legitimately miss a commit the branch still carries.
  if [ -n "${TARGET_BRANCH}" ] && [ "${DO_FETCH}" = "1" ]; then
    say "${WANT} is not in the clone; fetching ${TARGET_BRANCH}..."
    git -C "${REPO}" fetch --quiet "${REMOTE}" \
      "refs/heads/${TARGET_BRANCH}:refs/remotes/${REMOTE}/${TARGET_BRANCH}" \
      || die "fetch of ${TARGET_BRANCH} failed. Nothing has been moved."
  fi
fi
target_exists "${WANT}" \
  || die "${WANT} does not exist in ${REPO}, even after fetching. Refusing to fall
back to anything else: the point of being handed a commit is that no other commit is
an acceptable substitute."

WANT_SHA="$(git -C "${REPO}" rev-parse "${WANT}^{commit}")"

# --- Move, and verify the move ---------------------------------------------------
MOVED=no
if [ "${WANT_SHA}" != "${BEFORE_SHA}" ]; then
  say "checking out ${TARGET_REF:-${WANT_SHA:0:10}} (detached at ${WANT_SHA:0:10})..."
  # Detached on purpose: a named local branch would suggest the clone tracks something
  # and invites a later `git pull` to move it out from under a run.
  git -C "${REPO}" checkout --quiet --detach "${WANT_SHA}" || die "checkout failed."
  MOVED=yes
else
  say "already at ${WANT_SHA:0:10}; no checkout needed."
fi
ACTUAL_SHA="$(git -C "${REPO}" rev-parse HEAD)"
[ "${ACTUAL_SHA}" = "${WANT_SHA}" ] \
  || die "HEAD is ${ACTUAL_SHA} after checking out ${WANT_SHA}. Refusing to continue:
building against a commit nobody asked for is how a green run against the wrong
product happens."

# --- Does the build in front of us belong to this commit? -------------------------
stamped_sha() {
  [ -f "${STAMP_FILE}" ] || return 1
  # `cut` on the first `=` only: a value that contains one must not be truncated.
  grep -m1 '^sha=' "${STAMP_FILE}" 2> /dev/null | sed 's/^sha=//' || return 1
}

REBUILD_REASON=""
STAMPED="$(stamped_sha || true)"
if [ "${FORCE_REBUILD}" = "1" ]; then
  REBUILD_REASON="PREPARE_FORCE_REBUILD=1"
elif [ ! -f "${FRONTEND_DIR}/index.html" ]; then
  REBUILD_REASON="no frontend build at ${FRONTEND_DIR}"
elif [ -z "${STAMPED}" ]; then
  # The state every existing clone is in the first time this runs: assets exist and
  # nothing says which commit they came from. Treated as stale, deliberately — the
  # alternative is to trust assets of unknown origin, which is the debt itself.
  REBUILD_REASON="the build carries no stamp, so its commit is unknown"
elif [ "${STAMPED}" != "${ACTUAL_SHA}" ]; then
  REBUILD_REASON="the build belongs to ${STAMPED:0:10}, HEAD is ${ACTUAL_SHA:0:10}"
fi

DEPS_S=0
FRONTEND_S=0
REBUILT=no
START_S="$(date +%s)"

if [ -n "${REBUILD_REASON}" ] && [ "${SKIP_BUILD}" = "1" ]; then
  say "a rebuild is needed (${REBUILD_REASON}) but PREPARE_SKIP_BUILD=1 was set."
  say "the clone has been moved and its build does NOT match HEAD; the starter will refuse."
elif [ -n "${REBUILD_REASON}" ]; then
  say "rebuilding: ${REBUILD_REASON}"
  # The stamp dies FIRST. Every failure path below leaves the clone with no claim
  # about its build, which is the honest state and the one the starter refuses.
  rm -f "${STAMP_FILE}"

  T="$(date +%s)"
  if make -C "${REPO}" -n install_backend > /dev/null 2>&1; then
    say "deps: make install_backend"
    make -C "${REPO}" install_backend >&2 || die "install_backend failed."
  else
    say "deps: uv sync (no install_backend target in this Makefile)"
    ( cd "${REPO}" && uv sync ) >&2 || die "uv sync failed."
  fi
  DEPS_S=$(( $(date +%s) - T ))
  say "deps: ${DEPS_S}s"

  T="$(date +%s)"
  say "frontend: make install_frontend build_frontend"
  make -C "${REPO}" install_frontend >&2 || die "install_frontend failed."
  make -C "${REPO}" build_frontend >&2 || die "build_frontend failed."
  FRONTEND_S=$(( $(date +%s) - T ))
  say "frontend: ${FRONTEND_S}s"

  # Verified before it is claimed. `make` exiting 0 is not the same as the served
  # directory existing: build_frontend copies into a path that upstream can move.
  [ -f "${FRONTEND_DIR}/index.html" ] \
    || die "the build reported success but there is no ${FRONTEND_DIR}/index.html.
No stamp has been written, so the starter will refuse rather than serve no UI."

  printf 'sha=%s\nref=%s\nbuilt=deps+frontend\nfrontend_dir=%s\nat=%s\n' \
    "${ACTUAL_SHA}" "${TARGET_REF:-${WANT_SHA}}" "${FRONTEND_DIR}" \
    "$(date -u +%FT%TZ)" > "${STAMP_FILE}"
  REBUILT=yes
  say "stamped ${STAMP_FILE}"
else
  say "the build already belongs to ${ACTUAL_SHA:0:10}; nothing to rebuild."
fi

TOTAL_S=$(( $(date +%s) - START_S ))

emit "prepared_sha=${ACTUAL_SHA}"
emit "prepared_ref=${TARGET_REF:-${WANT_SHA}}"
emit "moved=${MOVED}"
emit "rebuilt=${REBUILT}"
emit "rebuild_reason=${REBUILD_REASON:-none}"
emit "deps_s=${DEPS_S}"
emit "frontend_s=${FRONTEND_S}"
emit "total_s=${TOTAL_S}"
