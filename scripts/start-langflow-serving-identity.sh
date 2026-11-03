#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-serving-identity.sh
#
# Starts the Langflow nightly configured for SERVING-PLANE END-USER IDENTITY —
# the `@serving` lane's instance (issue #1582, upstream #14443/#14550).
#
# The feature is OFF in every other lane and is turned on only by instance-global
# environment variables, so the cross-user memory boundary it provides cannot be
# asserted anywhere else. Point PLAYWRIGHT_BASE_URL here and run:
#
#   PW_SERVING_IDENTITY=1 npx playwright test --grep @serving
#
# THREE container states, because the interesting behaviour is not all in one:
#
#   (default)                    HEADER set, TRUST=true            -> identities isolate
#   LANGFLOW_SERVING_TRUST=0     HEADER set, TRUST=false           -> fail-closed AND fail-silent
#   LANGFLOW_SERVING_REQUIRED=1  HEADER set, TRUST=true, REQUIRED  -> identity-less request is 401
#
# Measured on 1.12.0.dev37 (see docs/serving/end-user-identity-lane.md):
#
#   default deployment (header unset)  a client-supplied header is IGNORED
#   HEADER + TRUST=true                alice::S / bob::S isolated, bare S empty,
#                                      anonymous run persists ZERO rows
#   HEADER + TRUST=false               every request becomes anon::<uuid> and
#                                      persists nothing — naming the header without
#                                      trusting it silently disables chat memory
#                                      instance-wide while runs still answer 200
#   ... + REQUIRED=true                no header -> 401 END_USER_IDENTITY_REQUIRED;
#                                      a whitespace-only value is refused too

set -euo pipefail

IMAGE="${LANGFLOW_IMAGE:-langflowai/langflow-nightly:latest}"
CONTAINER_NAME="${LANGFLOW_SERVING_CONTAINER:-langflow-serving-identity}"
PORT="${LANGFLOW_SERVING_PORT:-7893}"
HEADER_NAME="${LANGFLOW_SERVING_HEADER_NAME:-X-End-User-Id}"

# The two variant switches. Both default to the state the isolation specs need.
TRUST="true"
[ "${LANGFLOW_SERVING_TRUST:-1}" = "0" ] && TRUST="false"
REQUIRED="false"
[ "${LANGFLOW_SERVING_REQUIRED:-0}" = "1" ] && REQUIRED="true"

echo "Starting the serving-identity variant: ${IMAGE} on port ${PORT}"
echo "  header=${HEADER_NAME}  trust_proxy_headers=${TRUST}  end_user_required=${REQUIRED}"

case "${IMAGE}" in
*:latest)
  echo "Refreshing ${IMAGE} (moving tag)..."
  if ! docker pull "${IMAGE}"; then
    if docker image inspect "${IMAGE}" > /dev/null 2>&1; then
      echo "WARNING: could not refresh ${IMAGE} — starting the LOCAL copy, which may be stale."
    else
      echo "ERROR: could not pull ${IMAGE}, and no local copy exists to fall back to."
      exit 1
    fi
  fi
  ;;
esac

# Fake OAuth registrations, one per provider and Slack profile, as every lane
# configures them (#2301). The product ships none, which stops the Add/Reconnect
# wizard before consent and leaves every OAuth route unexercised; `oauth/start`
# calls no provider and a denied callback needs none, so a fake client id with a
# loopback redirect reaches every path short of a real consent. Canonical copy:
# scripts/lib/fake-oauth-registrations.json, which every copy is pinned to byte for
# byte by scripts/fake-oauth-registrations.test.mjs. INLINED rather than read from
# that file, because the VM lane pipes this script to `bash -s` on the target, where
# no file of this repo exists. Override with LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS='{}'
# to reproduce the product default (no registration).
DEFAULT_OAUTH_REGISTRATIONS='{"e2e-google":{"provider":"google","client_id":"e2e-fake-client.apps.googleusercontent.com","client_secret":"e2e-fake-google-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/google/callback","scopes":["openid","email","https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send"]},"e2e-microsoft":{"provider":"microsoft","client_id":"00000000-0000-4000-8000-0000000e2e01","client_secret":"e2e-fake-microsoft-client-secret","tenant":"00000000-0000-4000-8000-0000000e2e00","redirect_uri":"http://localhost/api/v1/connections/oauth/microsoft/callback","scopes":["offline_access","Calendars.Read","Calendars.ReadWrite","ChannelMessage.Send","ChatMessage.Send","Files.Read","Files.Read.All","Mail.Read","Mail.Send","Sites.Read.All"]},"e2e-slack-user":{"provider":"slack","client_id":"0000000000.0000000e2e","client_secret":"e2e-fake-slack-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/slack/callback","scopes":["canvases:write","channels:history","chat:write","groups:history","im:history","mpim:history","search:read"]},"e2e-slack-bot":{"provider":"slack","profile":"bot","client_id":"0000000000.0000000e2e","client_secret":"e2e-fake-slack-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/slack/callback","scopes":["app_mentions:read","channels:history","channels:read","chat:write","groups:history","groups:read","im:history","mpim:history","reactions:read","reactions:write","users:read"]}}'

# ONLY our own container. Never the shared `langflow-e2e-runner`:
# `start-langflow-docker.sh` hardcodes that name and removes it regardless of
# LANGFLOW_PORT, so "I only changed the port" is exactly how a parallel session's
# instance and its database get destroyed. This script cannot do that.
docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true

# Warn, don't refuse — the ceiling is the VM's, not this script's, and a bigger
# host runs several fine. Same trade as start-langflow-enterprise.sh.
SIBLINGS="$(docker ps --filter 'name=langflow-' --format '{{.Names}}' \
  | grep -v "^${CONTAINER_NAME}$" || true)"
if [ -n "${SIBLINGS}" ]; then
  echo "NOTE: other Langflow containers are already running:"
  echo "${SIBLINGS}" | sed 's/^/  /'
  echo "  Each costs ~1.5 GiB. On a small Docker VM the kernel SIGKILLs one"
  echo "  (Exited 137) and the specs pointed at it fail with connection refused."
fi

# The env block below mirrors scripts/start-langflow-docker.sh verbatim — every
# variable there is a decision with an issue behind it (ALLOW_CUSTOM_COMPONENTS
# #668, A2A_ENABLED #1240, SSRF_ALLOWED_HOSTS, WORKERS #773, DEACTIVATE_TRACING
# per reports/README.md). Diverging here would make this lane behave differently
# from every other for reasons unrelated to serving identity.
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:7860" \
  -e LANGFLOW_AUTO_LOGIN=true \
  -e LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  -e LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  -e LANGFLOW_DEACTIVATE_TRACING=true \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}" \
  -e LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
  -e LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS="${LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS:-$DEFAULT_OAUTH_REGISTRATIONS}" \
  -e LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,lf-self.localhost}" \
  -e LANGFLOW_KB_ALLOWED_FOLDER_ROOTS="${LANGFLOW_KB_ALLOWED_FOLDER_ROOTS:-~/.cache/langflow}" \
  -e LANGFLOW_WORKERS="${LANGFLOW_WORKERS:-1}" \
  -e LANGFLOW_SERVING_END_USER_HEADER="${HEADER_NAME}" \
  -e LANGFLOW_SERVING_TRUST_PROXY_HEADERS="${TRUST}" \
  -e LANGFLOW_SERVING_END_USER_REQUIRED="${REQUIRED}" \
  "${IMAGE}" > /dev/null

echo "Waiting for Langflow to be ready (up to 120s)..."
for i in $(seq 1 24); do
  if curl -sf "http://localhost:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after $((i * 5))s"
    VERSION="$(curl -sf "http://localhost:${PORT}/api/v1/version" 2>/dev/null || true)"
    [ -n "${VERSION}" ] && echo "Reachable at localhost:${PORT}: ${VERSION}"

    # SHADOW CHECK — the failure this exists for cost a whole measurement pass
    # once (see the port-shadowing note in the team notes). A process bound to
    # 127.0.0.1:${PORT} WINS over docker's 0.0.0.0 publish for localhost
    # connections, so the container starts fine, `docker port` looks right, and
    # every request goes to somebody else's Langflow. The tell is that the two
    # readings disagree: what answers over HTTP versus what the container itself
    # reports. Compare them, because each alone looks healthy.
    CONTAINER_VERSION="$(docker exec "${CONTAINER_NAME}" \
      python -c "import json,importlib.metadata as m; print(m.version('langflow'))" 2>/dev/null \
      | tr -d '[:space:]')"
    if [ -n "${CONTAINER_VERSION}" ] && [ -n "${VERSION}" ] \
       && ! printf '%s' "${VERSION}" | grep -q "${CONTAINER_VERSION}"; then
      echo
      echo "ERROR: port ${PORT} is SHADOWED — localhost:${PORT} is not this container."
      echo "  the container runs langflow ${CONTAINER_VERSION}"
      echo "  localhost:${PORT} answers  ${VERSION}"
      echo
      echo "  A bind on 127.0.0.1 beats docker's 0.0.0.0 publish for localhost, so"
      echo "  the container is healthy and simply unreachable. Find the impostor:"
      echo "    lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
      echo "  then pick a free port (this does not touch the other process):"
      echo "    LANGFLOW_SERVING_PORT=<free> ./scripts/start-langflow-serving-identity.sh"
      exit 1
    fi

    # Read the settings back OUT of the process, never trust the -e flags: an
    # env var Langflow does not bind is ignored in silence, and a variant that
    # configures nothing looks exactly like one that works.
    echo "Configured serving identity (read from the running process):"
    docker exec "${CONTAINER_NAME}" python -c "
from lfx.services.settings.base import Settings
s = Settings()
for k in ('serving_end_user_header', 'serving_trust_proxy_headers', 'serving_end_user_required'):
    print(f'  {k} = {getattr(s, k)!r}')
" 2>/dev/null | grep -v Warning || echo "  WARNING: could not read the settings back — verify before trusting a run."

    echo
    echo "Run the lane with:"
    echo "  PLAYWRIGHT_BASE_URL=http://localhost:${PORT} PW_SERVING_IDENTITY=1 npx playwright test --grep @serving"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
docker logs "${CONTAINER_NAME}"
exit 1
