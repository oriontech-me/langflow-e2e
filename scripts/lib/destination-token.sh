# shellcheck shell=bash
# Sourced, never run. The destination credential, minted from a GitHub App (#2518).
#
#   . scripts/lib/destination-token.sh
#   destination_token_refresh "$REPO_DIR" || true
#
# Every consumer on the QA VM reads GITHUB_TOKEN / GH_TOKEN from the environment, loaded
# from /root/.e2e-secrets. A GitHub App installation token expires one hour after it is
# minted, so a token stored there cannot last: the App's private key is stored instead,
# and this mints a token into those two names right before it is used.
#
# The App path takes over ONLY when all three inputs are present:
#   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE
# and the destination host is known (ISSUE_HOST, from the lane file, or
# GITHUB_APP_API_URL). With none of them, nothing changes: the static token keeps
# working while temporary mode lasts (ops/runbooks/destination-unreachable.md). With
# only some, it says which are missing and leaves the static token in place.
#
# A mint that fails leaves the environment as it was and returns the minter's exit code
# (2 configuration, 3 refused, 4 no answer), with the cause on stderr; an incomplete App
# (some of the three inputs, not all) returns 5. The caller decides what each costs;
# this never exits the caller. A configured App that answers 2 or 3 is broken, not
# absent, and a caller that would otherwise fall through to "no token" must treat it so
# (review of #2518: the daily's preflight stops on it, the alarm counts it as down).
#
# destination_token_drop unsets the two names again when THIS mint put them there, so a
# minted token lives only between its mint and its use, and is not inherited by what
# runs in between (the suite, Langflow, the flows it runs). A static token is left alone.
destination_token_refresh() {
  local repo="${1:-${REPO_DIR:-.}}" token rc=0 have=0 name
  for name in GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY_FILE; do
    [ -n "${!name:-}" ] && have=$((have + 1))
  done
  [ "$have" -eq 0 ] && return 0
  if [ "$have" -lt 3 ]; then
    local missing=""
    for name in GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY_FILE; do
      [ -n "${!name:-}" ] || missing="${missing:+$missing, }$name"
    done
    echo "WARNING: the GitHub App credential is incomplete (missing: $missing); the static token, if any, stays in use." >&2
    return 5
  fi
  token="$(GITHUB_APP_ID="$GITHUB_APP_ID" GITHUB_APP_INSTALLATION_ID="$GITHUB_APP_INSTALLATION_ID" \
    GITHUB_APP_PRIVATE_KEY_FILE="$GITHUB_APP_PRIVATE_KEY_FILE" GITHUB_APP_API_URL="${GITHUB_APP_API_URL:-}" \
    ISSUE_HOST="${ISSUE_HOST:-}" node "$repo/scripts/mint-app-token.mjs")" || rc=$?
  if [ "$rc" != "0" ] || [ -z "$token" ]; then
    [ "$rc" != "0" ] || rc=4
    echo "WARNING: could not mint the destination token from the GitHub App (exit $rc, cause above); the environment is unchanged." >&2
    return "$rc"
  fi
  GITHUB_TOKEN="$token"
  GH_TOKEN="$token"
  DESTINATION_TOKEN_MINTED=1
  export GITHUB_TOKEN GH_TOKEN
  return 0
}

destination_token_drop() {
  [ "${DESTINATION_TOKEN_MINTED:-0}" = "1" ] || return 0
  unset GITHUB_TOKEN GH_TOKEN
  DESTINATION_TOKEN_MINTED=0
}
