#!/usr/bin/env bash
# A git credential helper that answers for the destination with a freshly minted GitHub
# App installation token (#2518), so the QA VM's clone can pull over HTTPS once it
# leaves temporary mode: the destination takes no SSH, and a stored token would expire
# within the hour.
#
# Installed by ops/runbooks/destination-unreachable.md, for the destination host only:
#   git config --global credential.https://<ISSUE_HOST>.helper \
#     '/root/e2e-qa/scripts/git-credential-destination.sh'
#
# git calls it as `<helper> get` with the request on stdin (protocol=, host=, ...). It
# answers only `get`, only for the lane's ISSUE_HOST over https, and only when the App
# path is configured; otherwise it prints nothing, which tells git to try the next
# helper or to fail as it would without one. `store` and `erase` are ignored: the token
# is never written anywhere.
#
# Inputs: the App's three variables and ISSUE_HOST, read from the same files the daily
# reads (E2E_SECRETS, default /root/.e2e-secrets; E2E_LANE, default /root/.e2e-lane).
set -uo pipefail

[ "${1:-}" = "get" ] || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

protocol="" host=""
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    protocol=*) protocol="${line#protocol=}" ;;
    host=*) host="${line#host=}" ;;
  esac
done

for f in "${E2E_SECRETS:-/root/.e2e-secrets}" "${E2E_LANE:-/root/.e2e-lane}"; do
  # shellcheck disable=SC1090
  [ -r "$f" ] && . "$f"
done
[ "$protocol" = "https" ] && [ -n "${ISSUE_HOST:-}" ] && [ "$host" = "$ISSUE_HOST" ] || exit 0

# shellcheck source=lib/destination-token.sh
. "$REPO/scripts/lib/destination-token.sh"
# Only a MINTED token: with no App configured, answering with the static token would
# put a personal credential into git as well, which is what the App replaces.
[ -n "${GITHUB_APP_ID:-}" ] || exit 0
GITHUB_TOKEN="" GH_TOKEN=""
destination_token_refresh "$REPO" || exit 0
printf 'username=x-access-token\npassword=%s\n' "$GITHUB_TOKEN"
