#!/usr/bin/env bash
# Usage: ./scripts/start-langflow-instance-migration.sh
#
# Starts the @instance-migration lane (#2347): a SOURCE Langflow with instance
# migration turned on, plus the two destinations a SQLite source copies into — an
# empty PostgreSQL database with pgvector, and an S3-compatible bucket. Then point the
# specs at it:
#
#   PW_INSTANCE_MIGRATION=1 npx playwright test --grep @instance-migration
#
# Instance migration (Settings > Migration) moves a whole instance — users, flows,
# files, knowledge bases — to a new one. It is NOT the schema/upgrade migration the
# e2e-routine-migration VM routine covers (#2193). No other lane can reach it:
#
#   - it is off by default: /api/v1/migration is mounted only when
#     LANGFLOW_FEATURE_INSTANCE_MIGRATION=true at process start;
#   - its pause is instance-global: while on, every non-GET request outside
#     /api/v1/migration/ and the login routes answers 503, so a worker sharing the
#     instance would fail mid-test;
#   - it needs destinations, and it needs ONE worker, because the destination
#     passwords live only in that worker's memory.
#
# What starts, all on one user-defined network so the source reaches the target by name:
#
#   ${IM_SOURCE_CONTAINER}  the nightly + the `pgvector` package, SQLite, flag on, one
#                          worker, a known LANGFLOW_SECRET_KEY, and seeded data
#   ${IM_PG_CONTAINER}      PostgreSQL 16 + pgvector, an EMPTY database, extension created
#   ${IM_S3_CONTAINER}      SeaweedFS's S3 gateway with one empty bucket
#
# Measured on 1.14.0.dev14 — see docs/instance-migration/instance-migration-lane.md for
# the contract and the decisions (why SeaweedFS and not MinIO, why the image gains one
# package, why the reset is a script and not a container per spec file).
#
# Knobs (names, ports and fixture credentials live in scripts/lib/instance-migration-lane.sh):
#   LANGFLOW_IMAGE            base image, default langflowai/langflow-nightly:latest
#   LANGFLOW_BIND_HOST        default 127.0.0.1 — the source publishes on loopback only,
#                             like start-langflow-source.sh: it runs auto-login with a known
#                             superuser and a known secret key. Set 0.0.0.0 to opt out.
#                             The database and the bucket are ALWAYS loopback-only.
#   LANGFLOW_READY_TIMEOUT_S  default 180 (a cold start measured 45 s here)
#
# Between tests, reset the migration and both destinations with
# ./scripts/reset-langflow-instance-migration.sh (~1.3 s); stop the whole lane with
# ./scripts/stop-langflow-instance-migration.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/instance-migration-lane.sh
. "${HERE}/lib/instance-migration-lane.sh"

BASE_IMAGE="${LANGFLOW_IMAGE:-langflowai/langflow-nightly:latest}"
# The name lives in the lane file: the new instance a spec starts on the copy runs it too.
DERIVED_IMAGE="${IM_DERIVED_IMAGE}"
# The pgvector package the knowledge base copy needs. The docs install it as
# `langflow[pgvector]` (pgvector>=0.4.2); pinned to the version measured here.
PGVECTOR_PACKAGE="${IM_PGVECTOR_PACKAGE:-pgvector==0.5.1}"
READY_TIMEOUT_S="${LANGFLOW_READY_TIMEOUT_S:-180}"
case "${READY_TIMEOUT_S}" in
  '' | *[!0-9]* | 0*) echo "LANGFLOW_READY_TIMEOUT_S must be a positive integer of seconds with no leading zero, got: '${READY_TIMEOUT_S}'" >&2; exit 1 ;;
esac

# One worker is a requirement of the feature, not a default of this script: destination
# passwords and keys are held in that worker's memory, and a request served by a second
# worker finds none. Refused rather than overridden, so nobody measures a lane that
# silently ran with the setting they asked for ignored.
if [ -n "${LANGFLOW_WORKERS:-}" ] && [ "${LANGFLOW_WORKERS}" != "1" ]; then
  echo "LANGFLOW_WORKERS=${LANGFLOW_WORKERS} is refused: instance migration needs ONE worker (destination secrets live in its memory)." >&2
  exit 1
fi

BIND_HOST="${LANGFLOW_BIND_HOST:-127.0.0.1}"
BIND_HOST="${BIND_HOST#[}"
BIND_HOST="${BIND_HOST%]}"
case "${BIND_HOST}" in
  *:*) BIND_ADDR="[${BIND_HOST}]" ;;
  *) BIND_ADDR="${BIND_HOST}" ;;
esac
case "${BIND_HOST}" in
  0.0.0.0 | ::) PROBE_HOST="localhost" ;;
  *) PROBE_HOST="${BIND_ADDR}" ;;
esac
BASE_URL="http://${PROBE_HOST}:${IM_PORT}"

echo "Starting the @instance-migration lane: source ${BASE_IMAGE} on ${BIND_HOST}:${IM_PORT}"

case "${BASE_IMAGE}" in
*:latest)
  echo "Refreshing ${BASE_IMAGE} (moving tag)..."
  if ! docker pull "${BASE_IMAGE}"; then
    if docker image inspect "${BASE_IMAGE}" > /dev/null 2>&1; then
      echo "WARNING: could not refresh ${BASE_IMAGE} — starting the LOCAL copy, which may be stale."
    else
      echo "ERROR: could not pull ${BASE_IMAGE}, and no local copy exists to fall back to."
      exit 1
    fi
  fi
  ;;
esac

# The nightly ships without the `pgvector` package, so the destination test answers
# `pgvector_package_missing` and the knowledge base copy can never run (measured on
# 1.14.0.dev14). The image gains exactly that package and nothing else — what the docs
# tell an operator to install. Rebuilt on every start, so it always sits on the base
# just pulled; an unchanged base makes it a cache hit.
echo "Building ${DERIVED_IMAGE} (${BASE_IMAGE} + ${PGVECTOR_PACKAGE})..."
printf 'ARG BASE\nFROM ${BASE}\nRUN python -m pip install --no-cache-dir "%s"\n' "${PGVECTOR_PACKAGE}" \
  | docker build -q --build-arg "BASE=${BASE_IMAGE}" -t "${DERIVED_IMAGE}" - > /dev/null

# ONLY this lane's containers. Never the shared `langflow-e2e-runner`, which
# start-langflow-docker.sh removes by default whatever port it is given. The new instance
# a test started on the copy goes too: it would sit on a database this start replaces.
for name in "${IM_TARGET_CONTAINER}" "${IM_SOURCE_CONTAINER}" "${IM_PG_CONTAINER}" "${IM_S3_CONTAINER}"; do
  docker rm -f "${name}" > /dev/null 2>&1 || true
done
docker network inspect "${IM_NETWORK}" > /dev/null 2>&1 || docker network create "${IM_NETWORK}" > /dev/null

SIBLINGS="$(docker ps --filter 'name=langflow-' --format '{{.Names}}' \
  | grep -v -e "^${IM_SOURCE_CONTAINER}$" -e "^${IM_PG_CONTAINER}$" -e "^${IM_S3_CONTAINER}$" \
    -e "^${IM_TARGET_CONTAINER}$" || true)"
if [ -n "${SIBLINGS}" ]; then
  echo "NOTE: other Langflow containers are already running:"
  echo "${SIBLINGS}" | sed 's/^/  /'
  echo "  Each costs ~1.5 GiB. On a small Docker VM the kernel SIGKILLs one"
  echo "  (Exited 137) and the specs pointed at it fail with connection refused."
fi

docker run -d \
  --name "${IM_PG_CONTAINER}" \
  --network "${IM_NETWORK}" \
  -p "127.0.0.1:${IM_PG_HOST_PORT}:5432" \
  -e POSTGRES_USER="${IM_PG_USER}" \
  -e POSTGRES_PASSWORD="${IM_PG_PASSWORD}" \
  -e POSTGRES_DB="${IM_PG_DATABASE}" \
  "${IM_PG_IMAGE}" > /dev/null

docker run -d \
  --name "${IM_S3_CONTAINER}" \
  --network "${IM_NETWORK}" \
  -p "127.0.0.1:${IM_S3_HOST_PORT}:8333" \
  "${IM_S3_IMAGE}" server -s3 -s3.port=8333 > /dev/null

# Fake OAuth registrations, one per provider and Slack profile, as every lane
# configures them (#2301). Canonical copy: scripts/lib/fake-oauth-registrations.json,
# pinned byte for byte by scripts/fake-oauth-registrations.test.mjs. Override with
# LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS='{}' to reproduce the product default.
DEFAULT_OAUTH_REGISTRATIONS='{"e2e-google":{"provider":"google","client_id":"e2e-fake-client.apps.googleusercontent.com","client_secret":"e2e-fake-google-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/google/callback","scopes":["openid","email","https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send"]},"e2e-microsoft":{"provider":"microsoft","client_id":"00000000-0000-4000-8000-0000000e2e01","client_secret":"e2e-fake-microsoft-client-secret","tenant":"00000000-0000-4000-8000-0000000e2e00","redirect_uri":"http://localhost/api/v1/connections/oauth/microsoft/callback","scopes":["offline_access","Calendars.Read","Calendars.ReadWrite","ChannelMessage.Send","ChatMessage.Send","Files.Read","Files.Read.All","Mail.Read","Mail.Send","Sites.Read.All"]},"e2e-slack-user":{"provider":"slack","client_id":"0000000000.0000000e2e","client_secret":"e2e-fake-slack-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/slack/callback","scopes":["canvases:write","channels:history","chat:write","groups:history","im:history","mpim:history","search:read"]},"e2e-slack-bot":{"provider":"slack","profile":"bot","client_id":"0000000000.0000000e2e","client_secret":"e2e-fake-slack-client-secret","redirect_uri":"http://localhost/api/v1/connections/oauth/slack/callback","scopes":["app_mentions:read","channels:history","channels:read","chat:write","groups:history","groups:read","im:history","mpim:history","reactions:read","reactions:write","users:read"]}}'

# The env block mirrors scripts/start-langflow-docker.sh — every variable there is a
# decision with an issue behind it, and diverging would make this lane behave unlike
# every other for reasons unrelated to instance migration. Pinned by
# start-langflow-instance-migration.test.mjs, which reads that script's block at test
# time. The four lines after LANGFLOW_WORKERS are this lane's own.
docker run -d \
  --name "${IM_SOURCE_CONTAINER}" \
  --network "${IM_NETWORK}" \
  -p "${BIND_ADDR}:${IM_PORT}:${IM_PORT}" \
  -e LANGFLOW_PORT="${IM_PORT}" \
  -e LANGFLOW_AUTO_LOGIN=true \
  -e LANGFLOW_SUPERUSER="${LANGFLOW_SUPERUSER:-langflow}" \
  -e LANGFLOW_SUPERUSER_PASSWORD="${LANGFLOW_SUPERUSER_PASSWORD:-langflow123}" \
  -e LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-true}" \
  -e LANGFLOW_WORKER_TIMEOUT \
  -e LANGFLOW_SQLITE_PRAGMAS \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS="${LANGFLOW_ALLOW_CUSTOM_COMPONENTS:-true}" \
  -e LANGFLOW_A2A_ENABLED="${LANGFLOW_A2A_ENABLED:-true}" \
  -e LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS="${LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS:-$DEFAULT_OAUTH_REGISTRATIONS}" \
  -e LANGFLOW_SSRF_ALLOWED_HOSTS="${LANGFLOW_SSRF_ALLOWED_HOSTS:-172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,lf-self.localhost}" \
  -e LANGFLOW_KB_ALLOWED_FOLDER_ROOTS="${LANGFLOW_KB_ALLOWED_FOLDER_ROOTS:-~/.cache/langflow}" \
  -e LANGFLOW_WORKERS=1 \
  -e LANGFLOW_FEATURE_INSTANCE_MIGRATION=true \
  -e LANGFLOW_SECRET_KEY="${IM_SECRET_KEY}" \
  -e LANGFLOW_CONFIG_DIR="${IM_CONFIG_DIR}" \
  "${DERIVED_IMAGE}" > /dev/null

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# The destinations come up while the source boots (~45 s), so their readiness is free.
echo "Preparing the destinations..."
# Asked over TCP, not the socket: the image's entrypoint first runs a TEMPORARY server
# that listens on the socket only, before the database exists, and `pg_isready` on the
# socket says yes to it — measured, the extension was then refused with `database
# "langflow_target" does not exist`. The final server is the first one on TCP.
EXTENSION_OK=false
for _ in $(seq 1 60); do
  if docker exec "${IM_PG_CONTAINER}" pg_isready -q -h 127.0.0.1 -U "${IM_PG_USER}" -d "${IM_PG_DATABASE}" > /dev/null 2>&1 \
     && docker exec "${IM_PG_CONTAINER}" psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${IM_PG_USER}" -d "${IM_PG_DATABASE}" \
          -c 'CREATE EXTENSION IF NOT EXISTS vector' > /dev/null 2>&1; then
    EXTENSION_OK=true
    break
  fi
  sleep 1
done
[ "${EXTENSION_OK}" = "true" ] \
  || fail "PostgreSQL did not accept CREATE EXTENSION vector — see: docker logs ${IM_PG_CONTAINER}"
BUCKET_OK=false
for _ in $(seq 1 60); do
  if printf 's3.bucket.create -name %s\n' "${IM_S3_BUCKET}" \
      | docker exec -i "${IM_S3_CONTAINER}" weed shell 2>/dev/null | grep -q "created bucket ${IM_S3_BUCKET}"; then
    BUCKET_OK=true
    break
  fi
  sleep 1
done
[ "${BUCKET_OK}" = "true" ] || fail "SeaweedFS did not create the bucket ${IM_S3_BUCKET} — see: docker logs ${IM_S3_CONTAINER}"

echo "Waiting for the source to be ready (up to ${READY_TIMEOUT_S}s)..."
READY=false
for i in $(seq 1 "${READY_TIMEOUT_S}"); do
  if curl -sf "${BASE_URL}/health_check" > /dev/null 2>&1; then
    echo "Source ready after ${i}s"
    READY=true
    break
  fi
  sleep 1
done
if [ "${READY}" != "true" ]; then
  docker logs "${IM_SOURCE_CONTAINER}" 2>&1 | tail -40
  fail "the source did not start in ${READY_TIMEOUT_S}s (container ${IM_SOURCE_CONTAINER})."
fi

# SHADOW CHECK, as in start-langflow-serving-identity.sh: a process bound to the same
# port on loopback wins over docker's publish for localhost, and each reading alone
# looks healthy. Compare what answers over HTTP with what the container runs.
VERSION="$(curl -sf "${BASE_URL}/api/v1/version" 2>/dev/null || true)"
CONTAINER_VERSION="$(docker exec "${IM_SOURCE_CONTAINER}" \
  python -c "import importlib.metadata as m; print(m.version('langflow'))" 2>/dev/null | tr -d '[:space:]')"
if [ -z "${CONTAINER_VERSION}" ] || ! printf '%s' "${VERSION}" | grep -q "${CONTAINER_VERSION}"; then
  echo "ERROR: port ${IM_PORT} is SHADOWED — ${BASE_URL} is not this container." >&2
  echo "  the container runs langflow '${CONTAINER_VERSION}'" >&2
  echo "  ${BASE_URL} answers '${VERSION}'" >&2
  echo "  Find the impostor with: lsof -nP -iTCP:${IM_PORT} -sTCP:LISTEN" >&2
  echo "  then pick a free port: IM_PORT=<free> ./scripts/start-langflow-instance-migration.sh" >&2
  exit 1
fi
echo "Reachable at ${BASE_URL}: ${VERSION}"

TOKEN="$(curl -sf "${BASE_URL}/api/v1/auto_login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" \
  || fail "auto_login did not answer with a token."
AUTH="Authorization: Bearer ${TOKEN}"

# The flag is read back from what the server MOUNTED, never from the -e line: an env var
# Langflow does not bind is ignored in silence, and an unmounted router answers 404
# exactly as a disabled one does.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H "${AUTH}" "${BASE_URL}/api/v1/migration")"
[ "${STATUS}" = "200" ] || fail "GET /api/v1/migration answered ${STATUS}, so the migration routes are not mounted."

# --- seed --------------------------------------------------------------------------
# Without a local file and a local knowledge base, Langflow marks both copy steps
# `skipped`, and the two copies the lane exists for become unreachable. One of each,
# plus a flow. The file and the knowledge base row go through the API, as a user would
# create them; only the vectors do not, because ingesting real ones needs an embedding
# provider and its key.
echo "Seeding the source..."
FLOW_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "${AUTH}" -H 'Content-Type: application/json' \
  "${BASE_URL}/api/v1/flows/" -d "{\"name\":\"${IM_SEED_FLOW_NAME}\",\"data\":{\"nodes\":[],\"edges\":[]}}")"
[ "${FLOW_STATUS}" = "201" ] || fail "seeding the flow answered ${FLOW_STATUS}."

SEED_DIR="$(mktemp -d)"
trap 'rm -rf "${SEED_DIR}"' EXIT
printf 'instance-migration seed file\n' > "${SEED_DIR}/${IM_SEED_FILE_NAME}.txt"
FILE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "${AUTH}" \
  -F "file=@${SEED_DIR}/${IM_SEED_FILE_NAME}.txt" "${BASE_URL}/api/v2/files")"
case "${FILE_STATUS}" in 200 | 201) ;; *) fail "seeding the file answered ${FILE_STATUS}." ;; esac

# The create path records the embedding model and calls no provider, so no key is needed.
KB_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "${AUTH}" -H 'Content-Type: application/json' \
  "${BASE_URL}/api/v1/knowledge_bases/" \
  -d "{\"name\":\"${IM_SEED_KB_NAME}\",\"embedding_provider\":\"OpenAI\",\"embedding_model\":\"text-embedding-3-small\"}")"
[ "${KB_STATUS}" = "201" ] || fail "seeding the knowledge base answered ${KB_STATUS}."

# Deterministic vectors through the app's own store, the way upstream's migration
# rehearsal seeds them (scripts/migration_rehearsal/seed_instance.py — the idea, not the
# code). The row's `chunks` is set to the store's count, so the source check "vector
# counts" passes and a copy that drops chunks is visible as a count. The server keeps
# its SQLite database in the package directory, which a fresh Python process does not
# resolve to on its own: the path is read from the server and handed over, and the
# database service is created BEFORE the lfx imports, or the session opens an empty
# database and finds no knowledge base at all.
DB_PATH="$(curl -sf -H "${AUTH}" "${BASE_URL}/api/v1/migration" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance"]["database"]["path"])')"
docker exec -i -e LANGFLOW_DATABASE_URL="sqlite:///${DB_PATH}" "${IM_SOURCE_CONTAINER}" \
  python - "${IM_SEED_KB_NAME}" "${IM_SEED_KB_CHUNKS}" > "${SEED_DIR}/vectors.log" 2>&1 <<'PY' \
  || { cat "${SEED_DIR}/vectors.log" >&2; fail "seeding the knowledge base vectors failed."; }
import asyncio
import sys

KB_NAME, CHUNKS, DIM = sys.argv[1], int(sys.argv[2]), 8


def unit_vector(i: int) -> list[float]:
    # Unit length, as real embeddings are. Raw values make the copy refuse with
    # `kb_metric_change` (the source ranks by l2, pgvector by cosine, and only unit
    # vectors rank the same under both) — a decision a spec may want to reach on
    # purpose, never one the seed should force on every run.
    raw = [((i * 7 + j * 13) % 100 + 1) / 100 for j in range(DIM)]
    norm = sum(x * x for x in raw) ** 0.5
    return [x / norm for x in raw]


async def main() -> None:
    from langflow.services.deps import get_db_service, session_scope

    get_db_service()
    from langflow.services.database.models.knowledge_base import KnowledgeBaseRecord
    from langflow.services.knowledge_base_storage.runtime import storage_root
    from lfx.base.knowledge_bases.backends import IngestedDocument, SQLiteBackend, SQLiteStorageContext
    from sqlmodel import select

    async with session_scope() as session:
        rows = [row for row in (await session.exec(select(KnowledgeBaseRecord))).all() if row.name == KB_NAME]
        if len(rows) != 1:
            raise SystemExit(f"expected one knowledge base named {KB_NAME!r}, found {len(rows)}")
        kb = rows[0]
        backend = SQLiteBackend(
            kb.name,
            user_id=kb.user_id,
            storage_context=SQLiteStorageContext(storage_root(), kb.user_id, kb.id, kb.storage_generation),
            create=True,
        )
        await backend.ensure_ready()
        await backend.add_embedded_documents(
            [
                IngestedDocument(
                    f"instance-migration seed chunk {i}",
                    {"source": "instance-migration-seed.txt", "chunk_index": i},
                    unit_vector(i),
                    id=f"seed-{i:03d}",
                )
                for i in range(CHUNKS)
            ]
        )
        kb.chunks = CHUNKS
        session.add(kb)
        await session.commit()
        count = await backend.count()
        if count != CHUNKS:
            raise SystemExit(f"the store holds {count} vectors, expected {CHUNKS}")
        print(f"SEEDED {count}")


asyncio.run(main())
PY
grep -q "^SEEDED ${IM_SEED_KB_CHUNKS}$" "${SEED_DIR}/vectors.log" \
  || { cat "${SEED_DIR}/vectors.log" >&2; fail "the vector seed did not confirm ${IM_SEED_KB_CHUNKS} vectors."; }

# Read the seed back from the page's own source of truth: both copies must now be
# reachable steps, not `skipped`.
SKIPPED="$(curl -sf -H "${AUTH}" "${BASE_URL}/api/v1/migration" | python3 -c '
import json, sys
state = json.load(sys.stdin)
print(" ".join(s["id"] for s in state["steps"] if s["state"] == "skipped"))')"
[ -z "${SKIPPED}" ] || fail "after seeding, these steps are still skipped: ${SKIPPED}"
echo "Seeded: flow '${IM_SEED_FLOW_NAME}', file '${IM_SEED_FILE_NAME}', knowledge base '${IM_SEED_KB_NAME}' (${IM_SEED_KB_CHUNKS} vectors)."

echo
echo "The lane is up. Destinations, as the source reaches them (type these into the page):"
echo "  database  postgresql://${IM_PG_USER}:<IM_PG_PASSWORD>@${IM_PG_CONTAINER}:5432/${IM_PG_DATABASE}"
echo "  bucket    ${IM_S3_BUCKET} at http://${IM_S3_CONTAINER}:8333"
echo "and as this host reaches them (for assertions):"
echo "  database  127.0.0.1:${IM_PG_HOST_PORT}   bucket  http://127.0.0.1:${IM_S3_HOST_PORT}"
echo
echo "Reset between tests:  ./scripts/reset-langflow-instance-migration.sh"
echo "Run the lane with:"
echo "  PLAYWRIGHT_BASE_URL=${BASE_URL} PW_INSTANCE_MIGRATION=1 npx playwright test --grep @instance-migration"
