#!/usr/bin/env bash
# Usage: ./scripts/reset-langflow-instance-migration.sh
#
# Puts the @instance-migration lane back where a test can start a migration from the
# first step (#2347), without restarting anything. Called between tests by
# tests/helpers/instance-migration/reset-instance-migration.ts.
#
# What a migration leaves behind, and where each piece lives (measured on 1.14.0.dev14):
#
#   the migration record   ${IM_CONFIG_DIR}/migrations/migration.json — every step,
#                          decision and acceptance, AND the pause: the pause is a field
#                          of this record, and a missing record reads as "not paused"
#   the runs               ${IM_CONFIG_DIR}/migrations/runs/ — one status and one event
#                          log per step, plus the lock files beside them
#   the copies' children   `python -m langflow <command>` processes a run starts
#   the target database    a copy into a non-empty database is refused, so it must be
#                          emptied — DROP and CREATE, with the vector extension again
#   the bucket             the files copy writes under the bucket's prefix
#
# What it does NOT reset, on purpose:
#
#   - the source's own data. A migration does not write to the source (the knowledge
#     base copy leaves the source row on `sqlite`; measured), so the seed survives. What
#     a spec adds to the source itself is that spec's to clean up.
#   - the destination secrets the worker holds in memory (code: `_secrets` in
#     api/v1/migration.py). The reset record names no destination, so no step can use
#     them until a destination is saved again, which replaces them. A spec that asserts
#     what a RESTART forgets has to restart the source itself: `docker restart` costs
#     ~36 s here, which is why it is not part of every reset.
#
# Why a reset and not one container per spec file: measured, this script takes ~1.3 s,
# while recreating the source to healthy takes ~45 s and loses the seed with the
# container's SQLite database. See docs/instance-migration/instance-migration-lane.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/instance-migration-lane.sh
. "${HERE}/lib/instance-migration-lane.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

for name in "${IM_SOURCE_CONTAINER}" "${IM_PG_CONTAINER}" "${IM_S3_CONTAINER}"; do
  [ "$(docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null || true)" = "true" ] \
    || fail "${name} is not running — start the lane with ./scripts/start-langflow-instance-migration.sh"
done

START_NS="$(date +%s%N 2>/dev/null || true)"

# 0. The new instance a spec started on the copy (#2354). It holds connections to the
#    database this script is about to drop, it serves a copy that is about to stop
#    existing, and a test that died with it up would leave its name and port taken for the
#    next one. Removed only when it is there: `docker rm -f` exits 0 for a container that
#    is not (#2090), so the inspect is what tells the two apart. Stopping a Langflow takes
#    seconds idle and measured ~90 s on a loaded machine.
if docker container inspect "${IM_TARGET_CONTAINER}" > /dev/null 2>&1; then
  docker rm -f "${IM_TARGET_CONTAINER}" > /dev/null \
    || fail "could not remove the new instance ${IM_TARGET_CONTAINER}."
fi

# 1. Stop any run still going. A run's child would otherwise keep writing to the target
#    this script is about to empty, and its reader would write the run's files back into
#    a folder this script is about to remove. The server itself is `langflow run`; only a
#    run's children are started as `python -m langflow <command>`. The image has no ps or
#    pkill, so /proc is read directly — matching the first THREE arguments only, because
#    this very shell's cmdline holds the pattern as text (the first version matched the
#    whole cmdline, found itself, and killed itself).
docker exec "${IM_SOURCE_CONTAINER}" sh -c '
children() {
  for dir in /proc/[0-9]*; do
    [ "${dir#/proc/}" = "$$" ] && continue
    args="$(tr "\0" "\n" < "$dir/cmdline" 2>/dev/null | head -n 3 | tr "\n" " ")" || continue
    case "$args" in *python*" -m langflow ") echo "${dir#/proc/}" ;; esac
  done
}
pids="$(children)"
[ -z "$pids" ] && exit 0
kill -TERM $pids 2>/dev/null || true
for _ in $(seq 1 50); do
  [ -z "$(children)" ] && exit 0
  sleep 0.2
done
kill -KILL $(children) 2>/dev/null || true
sleep 0.5
[ -z "$(children)" ]
' || fail "a migration run in ${IM_SOURCE_CONTAINER} would not stop."

# 2. The record, the runs and their locks — the whole folder the feature owns.
docker exec "${IM_SOURCE_CONTAINER}" rm -rf "${IM_CONFIG_DIR}/migrations" \
  || fail "could not remove ${IM_CONFIG_DIR}/migrations in ${IM_SOURCE_CONTAINER}."

# 3. An empty target database, with the extension the knowledge base copy needs.
docker exec "${IM_PG_CONTAINER}" psql -q -v ON_ERROR_STOP=1 -U "${IM_PG_USER}" -d postgres \
  -c "DROP DATABASE IF EXISTS ${IM_PG_DATABASE} WITH (FORCE)" \
  -c "CREATE DATABASE ${IM_PG_DATABASE}" > /dev/null \
  || fail "could not recreate the database ${IM_PG_DATABASE}."
docker exec "${IM_PG_CONTAINER}" psql -q -v ON_ERROR_STOP=1 -U "${IM_PG_USER}" -d "${IM_PG_DATABASE}" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' > /dev/null \
  || fail "could not create the vector extension in ${IM_PG_DATABASE}."

# 4. An empty bucket: deleting it removes every object under it in one step.
printf 's3.bucket.delete -name %s\ns3.bucket.create -name %s\n' "${IM_S3_BUCKET}" "${IM_S3_BUCKET}" \
  | docker exec -i "${IM_S3_CONTAINER}" weed shell > /dev/null 2>&1 || true

# Verify each part instead of trusting the commands above: a reset that half-worked is
# exactly the cross-test leak it exists to prevent.
docker exec "${IM_SOURCE_CONTAINER}" test ! -e "${IM_CONFIG_DIR}/migrations/migration.json" \
  || fail "the migration record is still there."
TABLES="$(docker exec "${IM_PG_CONTAINER}" psql -At -U "${IM_PG_USER}" -d "${IM_PG_DATABASE}" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "${TABLES}" = "0" ] || fail "the target database still holds ${TABLES} table(s)."
EXTENSION="$(docker exec "${IM_PG_CONTAINER}" psql -At -U "${IM_PG_USER}" -d "${IM_PG_DATABASE}" \
  -c "SELECT count(*) FROM pg_extension WHERE extname = 'vector'")"
[ "${EXTENSION}" = "1" ] || fail "the vector extension is missing from ${IM_PG_DATABASE}."
LISTING="$(printf 's3.bucket.list\n' | docker exec -i "${IM_S3_CONTAINER}" weed shell 2>/dev/null || true)"
printf '%s\n' "${LISTING}" | grep -Eq "^[[:space:]]*${IM_S3_BUCKET}[[:space:]]" \
  || fail "the bucket ${IM_S3_BUCKET} was not recreated."
OBJECTS="$(printf 'fs.ls /buckets/%s\n' "${IM_S3_BUCKET}" | docker exec -i "${IM_S3_CONTAINER}" weed shell 2>/dev/null \
  | grep -cv -e '^[[:space:]]*$' -e '^>' || true)"
[ "${OBJECTS}" = "0" ] || fail "the bucket ${IM_S3_BUCKET} still lists ${OBJECTS} entr(ies)."

END_NS="$(date +%s%N 2>/dev/null || true)"
case "${START_NS}${END_NS}" in
  *N* | '') echo "Reset the instance migration lane." ;;
  *) echo "Reset the instance migration lane in $(((END_NS - START_NS) / 1000000)) ms." ;;
esac
