#!/usr/bin/env bash
# Start a local Langflow Enterprise (EE) instance for the @enterprise lane.
#
# Mirrors scripts/start-langflow-docker.sh, with three deliberate differences:
#
#   1. It BUILDS instead of pulling. The EE image lives in an IBM private
#      registry we cannot pull from, so the only reachable image is one built
#      from a local clone of the EE repository.
#   2. It runs password-first (LANGFLOW_AUTO_LOGIN=false). That is the EE
#      image default, baked into its Dockerfile — overriding it would test a
#      configuration the product never ships.
#   3. It parameterises the four governance knobs. EE owns catalog and model
#      provider policy through the environment (EnvironmentCatalogPolicyService),
#      so a policy state is a CONTAINER, not an API call: the admin write APIs
#      answer "managed externally" here.
#
# Usage:
#   ./scripts/start-langflow-enterprise.sh                    # build if needed, then run
#   ./scripts/start-langflow-enterprise.sh --rebuild          # force a rebuild
#   LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText ./scripts/start-langflow-enterprise.sh
set -euo pipefail

EE_REPO="${LANGFLOW_EE_REPO:-$HOME/langflow-project/IBM-Langflow}"
IMAGE="${LANGFLOW_EE_IMAGE:-langflow-enterprise:local}"
CONTAINER_NAME="${LANGFLOW_EE_CONTAINER:-langflow-ee-runner}"
# 7860/7861 belong to the OSS runner and 7870 is often taken by a parallel
# session; the EE lane gets its own port so both can run side by side.
PORT="${LANGFLOW_EE_PORT:-7890}"
# Stable base64 key: a rotating one invalidates stored credentials between
# restarts, which surfaces as a generic 400 on API key creation.
SECRET_KEY="${LANGFLOW_SECRET_KEY:-ZTJlLWVudGVycHJpc2UtbG9jYWwtc2VjcmV0LWtleS0wMDE=}"
# Two passwords, because EE uses two. BOOTSTRAP_PASSWORD is what the container
# is seeded with; EE_PASSWORD is what the suite logs in with after the forced
# rotation below. The EE minimum is 8 characters.
BOOTSTRAP_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}"
EE_PASSWORD="${LANGFLOW_EE_PASSWORD:-Langflow123!}"

if [ "${1:-}" = "--rebuild" ]; then
  REBUILD=1
else
  REBUILD=0
fi

if [ ! -d "${EE_REPO}" ]; then
  echo "ERROR: EE repo not found at ${EE_REPO}" >&2
  echo "Clone the Langflow Enterprise repository there, or set LANGFLOW_EE_REPO." >&2
  exit 2
fi

if [ "${REBUILD}" = "1" ] || ! docker image inspect "${IMAGE}" > /dev/null 2>&1; then
  echo "Building ${IMAGE} from ${EE_REPO} (this takes ~20 min on a cold cache)..."
  DOCKER_BUILDKIT=1 docker build -t "${IMAGE}" "${EE_REPO}"
fi

docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true

echo "Starting Langflow Enterprise: ${IMAGE} on port ${PORT}..."

# LANGFLOW_ACCESS_SECURE / _REFRESH_SECURE default to true in the EE image. Over
# plain HTTP on localhost a Secure cookie is never stored, so login succeeds and
# every subsequent request is anonymous — the session dies silently.
#
# LANGFLOW_PUBLIC_URL is mandatory: the shipped Compose file declares it with
# `:?`, and the backend uses it as the canonical browser-visible origin.
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:7860" \
  -e LANGFLOW_AUTO_LOGIN=false \
  -e LANGFLOW_SSO_ENABLED=true \
  -e LANGFLOW_NEW_USER_IS_ACTIVE=true \
  -e LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  -e LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  -e LANGFLOW_SECRET_KEY="${SECRET_KEY}" \
  -e LANGFLOW_PUBLIC_URL="http://localhost:${PORT}" \
  -e LANGFLOW_ACCESS_SECURE=false \
  -e LANGFLOW_REFRESH_SECURE=false \
  -e LANGFLOW_DEACTIVATE_TRACING=true \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}" \
  -e LANGFLOW_WORKERS="${LANGFLOW_WORKERS:-1}" \
  -e LANGFLOW_MODEL_PROVIDER_ALLOWLIST="${LANGFLOW_MODEL_PROVIDER_ALLOWLIST:-}" \
  -e LANGFLOW_CATALOG_COMPONENT_BLOCKLIST="${LANGFLOW_CATALOG_COMPONENT_BLOCKLIST:-}" \
  -e LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST="${LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST:-}" \
  -e LANGFLOW_MODEL_BLOCKLIST="${LANGFLOW_MODEL_BLOCKLIST:-}" \
  "${IMAGE}" > /dev/null

echo "Waiting for Langflow Enterprise to become healthy..."
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/health_check" > /dev/null 2>&1; then
    echo "Langflow Enterprise is up at http://localhost:${PORT}"
    curl -sf "http://localhost:${PORT}/api/v1/version" 2>/dev/null || true
    echo
    # EE forces a password change for the env-bootstrapped superuser
    # (sso_auth_service.py, reason="bootstrap_superuser"): every authenticated
    # endpoint answers 403 must_change_password until it is done. Doing it here
    # keeps the instance usable by the suite the moment this script returns.
    if ! curl -sf -X POST "http://localhost:${PORT}/api/v1/login" \
         -H 'Content-Type: application/x-www-form-urlencoded' \
         -d "username=${LANGFLOW_SUPERUSER:-langflow}&password=${EE_PASSWORD}" > /dev/null 2>&1; then
      BOOTSTRAP_TOKEN="$(curl -sf -X POST "http://localhost:${PORT}/api/v1/login" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -d "username=${LANGFLOW_SUPERUSER:-langflow}&password=${BOOTSTRAP_PASSWORD}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')"
      if [ -n "${BOOTSTRAP_TOKEN}" ]; then
        curl -sf -X POST "http://localhost:${PORT}/api/v1/account/force-password-change" \
          -H "Authorization: Bearer ${BOOTSTRAP_TOKEN}" \
          -H 'Content-Type: application/json' \
          -d "{\"current_password\":\"${BOOTSTRAP_PASSWORD}\",\"new_password\":\"${EE_PASSWORD}\"}" \
          > /dev/null && echo "Superuser password rotated to the EE lane password."
      fi
    fi

    echo "Sign in with ${LANGFLOW_SUPERUSER:-langflow} / ${EE_PASSWORD}"
    echo "Policy in force:"
    echo "  components blocked : ${LANGFLOW_CATALOG_COMPONENT_BLOCKLIST:-<none>}"
    echo "  templates blocked  : ${LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST:-<none>}"
    echo "  providers approved : ${LANGFLOW_MODEL_PROVIDER_ALLOWLIST:-<all>}"
    echo "  models blocked     : ${LANGFLOW_MODEL_BLOCKLIST:-<none>}"
    exit 0
  fi
  sleep 5
done

echo "ERROR: Langflow Enterprise did not become healthy in 300s." >&2
docker logs --tail 40 "${CONTAINER_NAME}" >&2 || true
exit 1
