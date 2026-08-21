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
# LANGFLOW_EE_RBAC=1 starts the RBAC variant instead: authorization enforced,
# superuser bypass OFF, audit on, and its own Postgres. It is a second container
# on its own port, not a mode switch on the first, because RBAC is a property of
# the database as much as of the process — the bootstrap writes role assignments
# at startup and there is no way back to an unenforced instance.
#
# LANGFLOW_EE_BYPASS=1 starts a THIRD variant, identical to the RBAC one in every
# knob but LANGFLOW_AUTHZ_SUPERUSER_BYPASS, which is true. It exists so the flag
# the whole @authz area gates on can be measured instead of assumed: with it on
# the superuser stops being subject to resource policy, and nothing else changes
# — a role-less peer on the same instance is still refused by every guard.
# Differing in exactly one variable is the point; a variant that also dropped the
# RBAC bootstrap would confound "the flag exempted the superuser" with "nothing
# granted it anything".
#
# Two corrections to what the design notes assumed, both measured on 1.12.0:
# Redis is NOT required (policy invalidation resolves to None and stays active
# without it; only multi-replica convergence needs one), and three variables the
# notes omitted are load-bearing — LANGFLOW_AUTHZ_AUDIT_ENABLED, plus
# LANGFLOW_RBAC_BOOTSTRAP_ENABLED and _ADMIN_USERNAME, without which the
# instance comes up enforcing with no roles assigned to anybody, including the
# superuser. The set below is the product's own recipe, taken from its air-gap
# certification harness rather than guessed.
#
# Usage:
#   ./scripts/start-langflow-enterprise.sh                    # build if needed, then run
#   ./scripts/start-langflow-enterprise.sh --rebuild          # force a rebuild
#   LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText ./scripts/start-langflow-enterprise.sh
#   LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh # RBAC variant, port 7891
#   LANGFLOW_EE_BYPASS=1 ./scripts/start-langflow-enterprise.sh # bypass variant, port 7892
set -euo pipefail

EE_REPO="${LANGFLOW_EE_REPO:-$HOME/langflow-project/IBM-Langflow}"
IMAGE="${LANGFLOW_EE_IMAGE:-langflow-enterprise:local}"
RBAC="${LANGFLOW_EE_RBAC:-0}"
BYPASS="${LANGFLOW_EE_BYPASS:-0}"
# Shared by both authorization variants; each still gets its own Postgres
# container, so the network only provides name resolution.
EE_NETWORK="${LANGFLOW_EE_NETWORK:-langflow-ee-net}"
# The bypass variant IS an authorization instance, so it takes the whole RBAC
# path and flips one knob. Resolved here rather than at the docker run, so the
# container, port and database it gets cannot drift from the ones the spec's skip
# message names.
SUPERUSER_BYPASS=false
if [ "${BYPASS}" = "1" ]; then
  RBAC=1
  SUPERUSER_BYPASS=true
  CONTAINER_NAME="${LANGFLOW_EE_CONTAINER:-langflow-ee-bypass}"
  PORT="${LANGFLOW_EE_PORT:-7892}"
  PG_CONTAINER="${LANGFLOW_EE_PG_CONTAINER:-pg-ee-bypass}"
  PG_PORT="${LANGFLOW_EE_PG_PORT:-5448}"
  PG_DB=langflow_bypass
elif [ "${RBAC}" = "1" ]; then
  CONTAINER_NAME="${LANGFLOW_EE_CONTAINER:-langflow-ee-rbac}"
  PORT="${LANGFLOW_EE_PORT:-7891}"
  PG_CONTAINER="${LANGFLOW_EE_PG_CONTAINER:-pg-ee-rbac}"
  PG_PORT="${LANGFLOW_EE_PG_PORT:-5447}"
  PG_DB=langflow_rbac
else
  CONTAINER_NAME="${LANGFLOW_EE_CONTAINER:-langflow-ee-runner}"
  # 7860/7861 belong to the OSS runner and 7870 is often taken by a parallel
  # session; the EE lane gets its own port so both can run side by side.
  PORT="${LANGFLOW_EE_PORT:-7890}"
fi
# Stable key, and a VALID Fernet one. Stable because a rotating key invalidates
# stored credentials between restarts; valid because Langflow encrypts API keys
# with Fernet, which requires exactly 32 url-safe base64-encoded bytes and
# rejects anything else.
#
# The previous value was a base64-encoded sentence — 35 bytes decoded — so every
# API key creation on this lane answered `400 Fernet key must be 32 url-safe
# base64-encoded bytes`, on both the default and the RBAC container. It read as
# a per-request failure rather than as a container that could not mint a key at
# all, which is why it survived: nothing here created one until the authorization
# matrix needed a scoped key as a subject.
#
# Derived deterministically (sha256 of a fixed string) so it stays stable without
# being a magic literal nobody can regenerate.
SECRET_KEY="${LANGFLOW_SECRET_KEY:-viJDyKIlkdxWMbwIICjJdRMUKUf80sGJafyWKoWbMU4=}"
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

# One Enterprise container at a time, on a small Docker VM. Starting the bypass
# variant beside the RBAC one had the kernel SIGKILL the RBAC container — it
# reads as `Exited (137)` on a container nobody touched, and the specs pointed at
# it fail with connection refused, attributed to whatever step was running. Warn
# rather than refuse: the ceiling is the VM's, not this script's, and a bigger
# host runs both fine.
SIBLINGS="$(docker ps --filter 'name=langflow-ee-' --format '{{.Names}}' \
  | grep -v "^${CONTAINER_NAME}$" || true)"
if [ -n "${SIBLINGS}" ]; then
  echo "WARNING: another Enterprise container is already running:"
  echo "${SIBLINGS}" | sed 's/^/  /'
  echo "  On an 8 GB Docker VM two EE instances plus the OSS runners do not fit, and"
  echo "  the kernel picks one to SIGKILL (Exited 137). Stop the sibling first if the"
  echo "  instance you are starting is the one you need:"
  echo "${SIBLINGS}" | sed 's/^/    docker stop /'
fi

# RBAC needs Postgres. Not a preference: the bootstrap writes role assignments
# and policy rules at startup, and the enforcement path reads them back on every
# request, so the database is part of the fixture rather than storage under it.
# A fresh one per start, because an instance that already carries assignments
# cannot answer "what can a user with no role do".
# Expanded below as ${AUTHZ_ARGS[@]+"${AUTHZ_ARGS[@]}"}, not "${AUTHZ_ARGS[@]}".
# macOS ships bash 3.2, where `set -u` treats an empty array's expansion as an
# unbound variable and aborts — so the plain form would break the NON-RBAC path,
# which every existing @enterprise spec depends on.
AUTHZ_ARGS=()
if [ "${RBAC}" = "1" ]; then
  # A dedicated network, so the two containers reach each other by NAME.
  #
  # This is not tidiness. The first version passed Postgres's container IP in
  # LANGFLOW_DATABASE_URL, and the default bridge reassigns IPs freely: after
  # other containers churned, `docker start langflow-ee-rbac` came back up
  # pointed at an address that now belonged to ANOTHER session's Postgres and
  # died with `password authentication failed for user "langflow"` — an error
  # that reads as wrong credentials rather than as the wrong host. The lucky part
  # is that it failed at all: a neighbour using these same throwaway credentials
  # would have been silently attached to, and the instance would have enforced
  # against somebody else's database. The default bridge has no DNS, hence a
  # user-defined network rather than just using the name.
  docker network inspect "${EE_NETWORK}" > /dev/null 2>&1 \
    || docker network create "${EE_NETWORK}" > /dev/null

  echo "Starting Postgres for the RBAC variant (${PG_CONTAINER} on ${PG_PORT})..."
  docker rm -f "${PG_CONTAINER}" > /dev/null 2>&1 || true
  docker run -d --name "${PG_CONTAINER}" -p "${PG_PORT}:5432" \
    --network "${EE_NETWORK}" \
    -e POSTGRES_USER=langflow -e POSTGRES_PASSWORD=langflow \
    -e "POSTGRES_DB=${PG_DB}" postgres:16-alpine > /dev/null
  PG_READY=0
  for _ in $(seq 1 30); do
    if docker exec "${PG_CONTAINER}" pg_isready -U langflow > /dev/null 2>&1; then
      PG_READY=1
      break
    fi
    sleep 2
  done
  if [ "${PG_READY}" -ne 1 ]; then
    echo "ERROR: ${PG_CONTAINER} never became ready; the RBAC instance would come up on SQLite" >&2
    exit 3
  fi
  # The container NAME, not localhost and not an IP: Langflow reaches Postgres
  # from inside Docker, where the published host port does not exist — and an IP
  # baked in at `docker run` time is stale the moment the bridge reassigns it.
  AUTHZ_ARGS=(
    --network "${EE_NETWORK}"
    -e "LANGFLOW_DATABASE_URL=postgresql://langflow:langflow@${PG_CONTAINER}:5432/${PG_DB}"
    -e LANGFLOW_AUTHZ_ENABLED=true
    # false on the RBAC variant: with it true the superuser is exempt from
    # resource policy and the instance reports itself as enforcing while
    # enforcing nothing for the only account the lane has. true on the bypass
    # variant, which exists to measure exactly that difference — measured, it is
    # one cell: the superuser's resource-policy answer. Every non-superuser
    # answer is unchanged.
    -e "LANGFLOW_AUTHZ_SUPERUSER_BYPASS=${SUPERUSER_BYPASS}"
    -e LANGFLOW_AUTHZ_AUDIT_ENABLED=true
    # The bootstrap is what gives ANY account a role, superuser included. With
    # it off the instance enforces against an empty assignment table and every
    # request is denied, which reads as a broken image rather than a missing flag.
    -e LANGFLOW_RBAC_BOOTSTRAP_ENABLED=true
    -e "LANGFLOW_RBAC_BOOTSTRAP_ADMIN_USERNAME=${LANGFLOW_SUPERUSER:-langflow}"
  )
fi

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
  ${AUTHZ_ARGS[@]+"${AUTHZ_ARGS[@]}"} \
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
    #
    # The probe is an AUTHENTICATED route, never `login`. Login is not gated by
    # must_change_password — it mints a token for a user who may not use it — so
    # a login probe answers "the password works", which is a different question.
    # With LANGFLOW_EE_PASSWORD set to the bootstrap password (the
    # credential-lifecycle spec needs exactly that, so the rotation is still
    # pending when it runs) the login succeeds, the script concludes the
    # rotation already happened, and returns an instance answering 403 on every
    # authenticated route.
    ROTATION_TOKEN="$(curl -sf -X POST "http://localhost:${PORT}/api/v1/login" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -d "username=${LANGFLOW_SUPERUSER:-langflow}&password=${EE_PASSWORD}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)"
    ROTATION_PENDING=1
    if [ -n "${ROTATION_TOKEN}" ] && curl -sf \
         -H "Authorization: Bearer ${ROTATION_TOKEN}" \
         "http://localhost:${PORT}/api/v1/users/whoami" > /dev/null 2>&1; then
      ROTATION_PENDING=0
    fi
    # Rotating to the password the container was seeded with is not a rotation,
    # and asking for it is how the credential-lifecycle spec asks for an
    # instance that has NOT rotated yet. Say so rather than attempting a change
    # whose acceptance would silently consume the state that spec needs.
    if [ "${EE_PASSWORD}" = "${BOOTSTRAP_PASSWORD}" ]; then
      ROTATION_PENDING=0
      echo "Forced rotation left PENDING: LANGFLOW_EE_PASSWORD equals the bootstrap password."
      echo "Every authenticated route will answer 403 must_change_password until something rotates it."
    fi
    if [ "${ROTATION_PENDING}" -eq 1 ]; then
      BOOTSTRAP_TOKEN="$(curl -sf -X POST "http://localhost:${PORT}/api/v1/login" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -d "username=${LANGFLOW_SUPERUSER:-langflow}&password=${BOOTSTRAP_PASSWORD}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true)"
      if [ -n "${BOOTSTRAP_TOKEN}" ]; then
        curl -sf -X POST "http://localhost:${PORT}/api/v1/account/force-password-change" \
          -H "Authorization: Bearer ${BOOTSTRAP_TOKEN}" \
          -H 'Content-Type: application/json' \
          -d "{\"current_password\":\"${BOOTSTRAP_PASSWORD}\",\"new_password\":\"${EE_PASSWORD}\"}" \
          > /dev/null && echo "Superuser password rotated to the EE lane password."
      fi
    fi

    echo "Sign in with ${LANGFLOW_SUPERUSER:-langflow} / ${EE_PASSWORD}"
    if [ "${BYPASS}" = "1" ]; then
      echo "BYPASS variant: authorization ENFORCED, superuser bypass ON, audit ON."
      echo "  database : postgres ${PG_CONTAINER} (host port ${PG_PORT})"
      echo "  verify   : GET /api/v1/authz/status -> authz_enabled true, superuser_bypass true"
      echo "  note     : the @authz specs that need an ENFORCING superuser skip here, by design."
    elif [ "${RBAC}" = "1" ]; then
      echo "RBAC variant: authorization ENFORCED, superuser bypass OFF, audit ON."
      echo "  database : postgres ${PG_CONTAINER} (host port ${PG_PORT})"
      echo "  verify   : GET /api/v1/authz/status -> authz_enabled true, superuser_bypass false"
    fi
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
