#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-pip.sh [branch_or_version]
# Example: ./scripts/start-langflow-pip.sh main
#          ./scripts/start-langflow-pip.sh 1.3.0
#          ./scripts/start-langflow-pip.sh git+https://github.com/langflow-ai/langflow.git@feat/my-feature

set -euo pipefail

TARGET="${1:-${LANGFLOW_VERSION:-langflow}}"
PORT="${LANGFLOW_PORT:-7860}"
PID_FILE="/tmp/langflow-e2e.pid"

echo "Installing Langflow: ${TARGET}..."
if [[ "${TARGET}" == git+* ]] || [[ "${TARGET}" == *"github.com"* ]]; then
  pip install "${TARGET}" --quiet
elif [[ "${TARGET}" =~ ^[0-9] ]]; then
  pip install "langflow==${TARGET}" --quiet
else
  pip install langflow --quiet
fi

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

echo "Starting Langflow on port ${PORT}..."
# LANGFLOW_DEACTIVATE_TRACING=true below is the same deliberate decision the Docker
# start script carries: local spend is out of scope for reports/token-history.jsonl,
# because a trace nobody can attribute to a key is not a measurement (#1300, #1183).
# Reasoning in reports/README.md — update it if this flag ever changes.
LANGFLOW_AUTO_LOGIN=true \
LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
LANGFLOW_DEACTIVATE_TRACING=true \
LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS="${LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS:-$DEFAULT_OAUTH_REGISTRATIONS}" \
LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16}" \
LANGFLOW_KB_ALLOWED_FOLDER_ROOTS="${LANGFLOW_KB_ALLOWED_FOLDER_ROOTS:-~/.cache/langflow,~/Library/Caches/langflow}" \
  langflow run --host 0.0.0.0 --port "${PORT}" --no-open-browser \
    --workers "${LANGFLOW_WORKERS:-1}" &
# LANGFLOW_A2A_ENABLED defaults to true: the product default is OFF, A2A's router
# is always mounted, and a per-request guard 404s every /api/v1/a2a/* route while
# the flag is off — so a spec written against a disabled server passes while
# testing nothing (#1240; surface scoped in #1195). Set it to false to reproduce
# the disabled state deliberately.
# LANGFLOW_SSRF_ALLOWED_HOSTS mirrors the Docker start script and all four CI
# lanes: the SSRF guard blocks private addresses, so without it a self-hosted
# echo endpoint (ECHO_BASE_URL) or any private-network service is refused locally
# while working in CI, silently. Loopback stays OUT of the list on purpose —
# specs use an SSRF-blocked loopback fetch as a deterministic error generator and
# security/ssrf-url-validation.spec.ts asserts that refusal.
# LANGFLOW_KB_ALLOWED_FOLDER_ROOTS is the knowledge-base `folder` connector's
# allow-list (empty refuses every walk), set to Langflow's config directory — where
# flow-scoped uploads land — as every lane sets it, so memory-base-ingestion.spec.ts
# can ingest a folder it owns (#2043). Both platformdirs locations, because this
# starter runs on Linux (~/.cache/langflow) and macOS (~/Library/Caches/langflow);
# the spec reads the roots back from the server and uses the one holding its folder.
# --workers defaults to 1: Langflow's own default is (2*cpu)+1 workers, each
# holding the full in-memory state, which exhausts memory on a constrained dev
# box and gets a worker SIGKILLed mid-build (ERR_EMPTY_RESPONSE / node run never
# completes — see #773). Override with LANGFLOW_WORKERS on a beefier machine.
echo $! > "${PID_FILE}"

echo "Waiting for Langflow to be ready (up to 120s)..."
for i in $(seq 1 24); do
  if curl -sf "http://localhost:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow ready after $((i * 5))s (PID: $(cat ${PID_FILE}))"
    exit 0
  fi
  echo "  Waiting... ($((i * 5))s)"
  sleep 5
done

echo "ERROR: Langflow did not start in time."
kill "$(cat ${PID_FILE})" 2>/dev/null || true
exit 1
