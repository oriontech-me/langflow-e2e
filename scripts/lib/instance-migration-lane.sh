# shellcheck shell=bash
# Names, ports and fixture credentials of the @instance-migration lane (#2347).
#
# Sourced by start-, reset- and stop-langflow-instance-migration.sh, so the three
# scripts cannot disagree about which containers are the lane's. The specs read the
# same values through tests/helpers/instance-migration/lane-env.ts, whose defaults are
# pinned to this file by lane-env.test.ts: a default changed here and not there fails
# the unit lane instead of pointing the specs at a container that does not exist.
#
# Every value is overridable through the environment under the same name. Keep each
# default on one line of the form NAME="${NAME:-value}": the pin test parses exactly
# that shape.
#
# The credentials are FIXTURES, and are spelled so that a page, a response, the
# migration record or the downloaded support record can be searched for them as raw
# text. That is how the specs assert the secret boundary (the batch-1 Integrations
# technique): plant a sentinel, then assert its absence. Nothing here is a real secret
# and this repository is public.

# Containers and the network they share. The source reaches the target's database and
# bucket by these names, which is why the three live on one user-defined network.
IM_SOURCE_CONTAINER="${IM_SOURCE_CONTAINER:-langflow-instance-migration}"
IM_PG_CONTAINER="${IM_PG_CONTAINER:-langflow-instance-migration-pg}"
IM_S3_CONTAINER="${IM_S3_CONTAINER:-langflow-instance-migration-s3}"
IM_NETWORK="${IM_NETWORK:-langflow-instance-migration-net}"

# Host ports. Clear of 7860 (the shared runner), 7890-7892 (Enterprise) and 7893
# (serving identity). The source listens INSIDE the container on the same port it is
# published on, for the reason start-langflow-docker.sh gives (#2159).
IM_PORT="${IM_PORT:-7895}"
IM_PG_HOST_PORT="${IM_PG_HOST_PORT:-55895}"
IM_S3_HOST_PORT="${IM_S3_HOST_PORT:-58895}"

# The new instance a spec starts on the copy (#2354), from the settings the start step
# prints. It joins the lane's network, so it reaches the database and the bucket by the
# names those settings carry. It is not started by the start script: each test starts its
# own and removes it, and the reset, start and stop scripts remove one a test left behind.
IM_TARGET_CONTAINER="${IM_TARGET_CONTAINER:-langflow-instance-migration-target}"
IM_TARGET_PORT="${IM_TARGET_PORT:-7896}"

# The image BOTH Langflows run: the nightly plus the pgvector package, built by the start
# script. The new instance needs that package as much as the source did, to read the
# knowledge bases the copy moved into pgvector.
IM_DERIVED_IMAGE="${IM_DERIVED_IMAGE:-langflow-instance-migration:local}"

# Pinned companion images. SeaweedFS rather than MinIO: MinIO stopped publishing
# pullable images (minio/minio and quay.io/minio/minio both answer "not found"), and
# upstream Langflow's own CI moved to this exact image and command for its S3 tests
# (.github/workflows/ci.yml, "Start S3 server"). With no S3 config it accepts any
# credentials.
IM_PG_IMAGE="${IM_PG_IMAGE:-pgvector/pgvector:0.8.6-pg16}"
IM_S3_IMAGE="${IM_S3_IMAGE:-chrislusf/seaweedfs:4.47}"

# The target's empty PostgreSQL database.
IM_PG_DATABASE="${IM_PG_DATABASE:-langflow_target}"
IM_PG_USER="${IM_PG_USER:-langflow}"
IM_PG_PASSWORD="${IM_PG_PASSWORD:-e2e-im-sentinel-pg-password}"

# The target's bucket and keys.
IM_S3_BUCKET="${IM_S3_BUCKET:-langflow-migration}"
IM_S3_ACCESS_KEY_ID="${IM_S3_ACCESS_KEY_ID:-e2e-im-sentinel-s3-access-key}"
IM_S3_SECRET_ACCESS_KEY="${IM_S3_SECRET_ACCESS_KEY:-e2e-im-sentinel-s3-secret-key}"

# The source's LANGFLOW_SECRET_KEY: a valid Fernet key (32 url-safe base64 bytes; the
# bytes spell "e2e-im-sentinel-secret-key-fake!"). Known, so a spec can compute the
# fingerprint the "Hand over the secret key" step asks for, and search for the key
# itself as a sentinel.
IM_SECRET_KEY="${IM_SECRET_KEY:-ZTJlLWltLXNlbnRpbmVsLXNlY3JldC1rZXktZmFrZSE=}"

# Where the source keeps its migration record. This IS the image's default config
# directory; it is set explicitly so the reset script knows the path without starting a
# Python process inside the container to ask.
IM_CONFIG_DIR="${IM_CONFIG_DIR:-/app/data/.cache/langflow}"

# The seeded source data, by name, so a spec can find each piece through the API.
IM_SEED_FLOW_NAME="${IM_SEED_FLOW_NAME:-instance-migration-seed-flow}"
IM_SEED_FILE_NAME="${IM_SEED_FILE_NAME:-instance-migration-seed-file}"
IM_SEED_KB_NAME="${IM_SEED_KB_NAME:-instance-migration-seed-kb}"
IM_SEED_KB_CHUNKS="${IM_SEED_KB_CHUNKS:-3}"
