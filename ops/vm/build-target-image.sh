#!/usr/bin/env bash
# Builds the Langflow image a declared-target run measures: one branch of upstream,
# pinned to the commit it pointed at when asked, built with the nightly's own
# Dockerfile, and labelled with that commit so run-e2e.sh can check it
# (TARGET_DECLARED_SHA, #2111).
#
# Usage:
#   ops/vm/build-target-image.sh <branch>
#
# On success it prints the three things a declared run needs, and nothing else on
# stdout:
#
#   target_ref=<branch>
#   target_sha=<40-hex commit>
#   target_version=<[project].version of that commit's pyproject.toml>
#   image=<repository>:<first 12 of the commit>
#   build_s=<seconds the docker build took>
#
# so a caller runs it as
#
#   eval "$(ops/vm/build-target-image.sh release-1.13.0)" &&
#     TARGET_KIND=image LANGFLOW_IMAGE="$image" TARGET_DECLARED_SHA="$target_sha" \
#     TARGET_DECLARED_VERSION="$target_version" TARGET_DECLARED_REF="$target_ref" \
#     ./scripts/run-e2e.sh
#
# Every refusal and failure goes to stderr as one line, with its own exit status, so a
# caller can tell "nothing was built because you asked for something wrong" from "the
# build itself failed" without parsing text:
#
#   2  refused: not a branch name, or not a branch of upstream (a fork is never one)
#   3  upstream unreachable, or the commit could not be fetched
#   4  the commit has no readable [project].version, or no nightly Dockerfile
#   5  docker build failed (the log is kept and named)
#   6  the built image does not carry the commit it was built from
#   7  this machine cannot run the build (python3 without tomllib, i.e. older than 3.11)
#
# Only branches of UPSTREAM_REPO_URL, which is langflow-ai/langflow unless overridden
# (the tests point it at a local repository). Building a branch runs its code on this
# machine next to the provider keys, and on upstream only maintainers create branches;
# a fork is anyone's code, so there is no way to name one here: the name is resolved
# only under refs/heads/ of that one repository.
#
# The build context lives under BUILD_ROOT, /root by default. The docker snap's CLI
# cannot read a build context under /var/tmp (measured 2026-09-30) and /tmp is private
# to the snap, so both are refused rather than failing inside docker with "no such
# file". The source tree is removed on every exit; the image is the caller's to remove
# after its run, and so is the build cache (`docker builder prune -af`), which saved
# about 20 s per build for about 9 GB when it was measured.
main() {
  set -uo pipefail
  local branch="${1:-}"
  local upstream="${UPSTREAM_REPO_URL:-https://github.com/langflow-ai/langflow}"
  local build_root="${BUILD_ROOT:-/root/target-builds}"
  local image_repo="${IMAGE_REPO:-langflow-ondemand}"
  local docker="${DOCKER:-docker}"
  local dockerfile="docker/build_and_push.Dockerfile"

  refuse() { echo "build-target-image: $2" >&2; exit "$1"; }

  # --- The name: a branch, and only a branch -----------------------------------
  [ -n "$branch" ] || refuse 2 "no branch named. Usage: build-target-image.sh <branch>"
  case "$branch" in
    -*) refuse 2 "'$branch' is not a branch name (it starts with '-')." ;;
    *:*) refuse 2 "'$branch' names a fork or a remote ('owner:branch'). Only branches of $upstream are built." ;;
    refs/* | pull/*) refuse 2 "'$branch' is a ref, not a branch name. Name the branch itself, e.g. release-1.13.0." ;;
  esac
  git check-ref-format "refs/heads/$branch" || refuse 2 "'$branch' is not a valid branch name."
  # Narrower than git allows (git accepts `;`, `$`, `&` in a ref), and exactly what
  # run-e2e.sh accepts as TARGET_DECLARED_REF: the output is meant for `eval`, and a
  # name this script built but the run then refused would waste the build.
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || refuse 2 "'$branch' has characters this lane does not accept in a branch name (letters, digits, '.', '_', '/', '-')."

  # Only the snap's CLI has this blind spot, so only the snap is refused it: a plain
  # docker reads /tmp fine, and so do the tests. The snap's `docker` is a link to
  # /usr/bin/snap, which is what resolving it shows.
  local docker_bin
  docker_bin="$(readlink -f "$(command -v "$docker" 2>/dev/null)" 2>/dev/null || true)"
  if [ "${docker_bin##*/}" = "snap" ] || [[ "$docker_bin" == /snap/* ]]; then
    case "$build_root" in
      /tmp | /tmp/* | /var/tmp | /var/tmp/*) refuse 2 "BUILD_ROOT=$build_root: the docker snap cannot read a build context there. Use a directory under /root." ;;
    esac
  fi

  # --- The commit: resolved once, and everything after uses it -----------------
  # The branch can move during a five-minute build, and the image must describe one
  # commit. ls-remote patterns match on the tail of a ref, so the exact name is
  # filtered rather than trusted.
  local listing sha
  listing="$(git ls-remote --heads "$upstream" "refs/heads/$branch")" \
    || refuse 3 "could not list the branches of $upstream."
  sha="$(printf '%s\n' "$listing" | awk -v ref="refs/heads/$branch" '$2 == ref { print $1 }')"
  [ -n "$sha" ] || refuse 2 "'$branch' is not a branch of $upstream. A fork's branch is never one, and a deleted or mistyped branch is not either."
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse 3 "$upstream answered '$sha' for $branch, which is not a commit."

  # The pyproject is read with tomllib, which exists from Python 3.11. Checked before
  # anything is fetched, so an old interpreter on the machine is not reported as every
  # branch having "no readable version".
  python3 -c 'import tomllib' 2>/dev/null \
    || refuse 7 "python3 on this machine has no tomllib (it needs 3.11 or later: $(python3 --version 2>&1 || echo 'no python3')). This is the machine, not the branch."

  # One directory PER RUN, not per commit: two requests for the same branch close
  # together would otherwise share a tree, and the second one's cleanup would delete
  # what the first one's docker build is still reading. The log is per run for the
  # same reason, and sits beside the tree so it survives the tree's removal.
  mkdir -p "$build_root" || refuse 3 "cannot create $build_root."
  local src
  src="$(mktemp -d "$build_root/src-${sha:0:12}-XXXXXX")" || refuse 3 "cannot create a build directory under $build_root."
  # GLOBAL, not the local above: the EXIT trap runs after main has returned, when a
  # local is out of scope and `rm -rf ""` removes nothing. That is how the first
  # version of this left every successful build's source tree behind.
  BUILD_TARGET_SRC="$src"
  trap 'rm -rf "${BUILD_TARGET_SRC:-}"' EXIT
  git init -q "$src" || refuse 3 "cannot create $src."
  git -C "$src" fetch -q --depth 1 "$upstream" "$sha" \
    || refuse 3 "could not fetch $sha from $upstream."
  git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD || refuse 3 "could not check out $sha."
  [ "$(git -C "$src" rev-parse HEAD)" = "$sha" ] || refuse 3 "the checkout is not at $sha."

  # --- What the commit says it is -------------------------------------------------
  local version
  version="$(python3 -c '
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    print(tomllib.load(f)["project"]["version"])
' "$src/pyproject.toml" 2>/dev/null)" || version=""
  [ -n "$version" ] || refuse 4 "$branch @ ${sha:0:12} has no readable [project].version in pyproject.toml."
  [[ "$version" =~ ^[0-9A-Za-z.+!-]+$ ]] || refuse 4 "$branch @ ${sha:0:12} declares a version run-e2e.sh cannot accept: '$version'."
  [ -f "$src/$dockerfile" ] || refuse 4 "$branch @ ${sha:0:12} has no $dockerfile, so it cannot be built the way the nightly is. The branch may predate it."
  # The build asks for the stage the nightly builds. A Dockerfile without it would fail
  # inside docker and read as status 5, a build failure, when the commit simply cannot
  # be built this way.
  grep -qiE '^[[:space:]]*FROM[[:space:]].*[[:space:]]AS[[:space:]]+full[[:space:]]*$' "$src/$dockerfile" \
    || refuse 4 "$branch @ ${sha:0:12}: $dockerfile has no 'full' stage, which is what the nightly builds. The branch may predate it."

  # --- The build ---------------------------------------------------------------------
  local image="$image_repo:${sha:0:12}"
  local log="$build_root/build-${sha:0:12}-${src##*-}.log"
  local start=$SECONDS
  echo "build-target-image: building $branch @ ${sha:0:12} (version $version) as $image; log: $log" >&2
  if ! "$docker" build -f "$src/$dockerfile" --target full \
      --label "org.langflow.sha=$sha" --label "org.langflow.ref=$branch" \
      -t "$image" "$src" > "$log" 2>&1; then
    tail -n 15 "$log" >&2
    refuse 5 "docker build of $branch @ ${sha:0:12} failed after $((SECONDS - start))s. This is a build failure, not a test result; the full log is $log."
  fi
  local build_s=$((SECONDS - start))

  local label
  label="$("$docker" image inspect --format '{{index .Config.Labels "org.langflow.sha"}}' "$image" 2>/dev/null)" || label=""
  [ "$label" = "$sha" ] || refuse 6 "$image carries org.langflow.sha='$label', not $sha."

  printf 'target_ref=%s\ntarget_sha=%s\ntarget_version=%s\nimage=%s\nbuild_s=%s\n' \
    "$branch" "$sha" "$version" "$image" "$build_s"
  return 0
}

main "$@"
