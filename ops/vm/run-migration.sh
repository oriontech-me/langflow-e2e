#!/usr/bin/env bash
# The migration routine: what e2e-routine-migration.service runs (stage 3, task 5).
#
# ## What it is
#
# One routine in place of the three Actions workflows it retires (migration-test,
# migration-fresh-install, migration-upgrade-with-flows). It tests the upgrade from the
# latest stable Langflow published below the target to the target, which is the
# upgrade most users make (scripts/resolve-migration-pair.mjs says why, and names the
# two real damages the old workflows never saw: 1.7.0's SQLite path, #11107, and the
# AUTO_LOGIN cascade on Postgres, #15326).
#
# ## The target
#
#   MIGRATION_TARGET=<version>   asked for: a weekly patch RC, from PyPI and Docker Hub
#   (unset)                      the version today's daily served, read from its
#                                run-metadata.json: the same build the daily judged
#
# No daily today and no MIGRATION_TARGET is `skipped`: the daily's own watchdog already
# says the daily is missing, and this routine has no target of its own.
#
# ## The twelve cells
#
#   database   sqlite | postgres (16)
#   mode       pip (one venv, upgraded in place) | docker (the published images)
#   scenario   fresh (the target alone) | upgrade (source, seeded, then the target)
#   + auth     AUTO_LOGIN off on the target, in the four upgrade cells
#
# pip+sqlite upgrades in the same venv with the default configuration: the default
# database lives inside the installed package (site-packages/langflow/langflow.db,
# measured on 1.12.4), so an install that drops or moves it is the 1.7.0 class of loss.
# docker+sqlite keeps the database in the config volume (LANGFLOW_SAVE_DB_IN_CONFIG_DIR).
# docker+postgres runs upstream's own docker_example compose file, as the Actions job
# did, with ports overridden so nothing binds outside this lane.
#
# The AUTO_LOGIN-off cells configure another superuser and verify by adopting the
# default account (ops/vm/migration/cell.py, adopt): it must be kept with its id. On
# Postgres the seed is adversarial: the default account's last_login_at is cleared
# before the upgrade, because auto-login stamps it (measured on 1.12.4) and #15326
# struck exactly the accounts that never signed in. A 1.12.x target predates the fix
# (release-1.13.0 only), so those cells can be red for a known defect; the report says
# #15326 beside them.
#
# ## Verdicts
#
# Each cell: green, red (the product: it would not start on the migrated data, or a
# check failed), failed (this machine: an install, a pull or a container that never
# came up for reasons of its own), blocked (only the credential check, when the
# provider probe says the account cannot pay). The routine: red if any cell is red,
# else failed if any failed, else blocked if any blocked, else green.
#
# ## Where it runs
#
#   ports     7920-7931 (one per cell), postgres 5470-5481, ollama 11464
#   work      /root/e2e-routines/migration/work, removed after
#   docker    containers, volumes and compose projects named e2e-migration-*, removed
#             after; the images it pulled, removed after (task 8 decides retention)
#
# Never `docker system prune`: the other lanes' images are not this routine's.
#
# ## What it does not cover, on purpose
#
#   - Other sources: only the latest stable below the target. An upgrade that skips
#     releases (1.10 -> 1.13) or starts from an rc is not tested.
#   - Downgrades, and moving a database from SQLite to Postgres.
#   - Other Postgres versions than 16, replicas, and a database shared by two instances.
#   - Branches with no published build: a target must be on PyPI and Docker Hub (a
#     second phase would build it, as the on-demand run does).
#   - The Enterprise edition, which has its own routine (stage 3, task 11).
#   - What only the UI shows: components flagged for update, the canvas. The checks are
#     the API's; the daily suite covers the UI on the target.
#   - The credential witness proves one Credential decrypts with one provider (OpenAI);
#     other providers' credentials are stored the same way and are not called.
set -uo pipefail

REPO="${E2E_ROUTINE_REPO:-/root/e2e-qa}"
# shellcheck source=lib/routine.sh
. "$REPO/ops/vm/lib/routine.sh"

main() {
  routine_start migration
  # Visibility, decided 2026-10-05: red goes to the destination's issue and to Slack;
  # green closes the issue quietly.
  ROUTINE_ISSUE=1
  ROUTINE_SLACK=red

  MIG_WORK="$RT_STATE/work"
  MIG_PY="${MIGRATION_PYTHON:-3.13}"
  MIG_OLLAMA_PORT=11464
  MIG_CELLS="${MIGRATION_CELLS:-all}"
  local budget="${MIGRATION_WAIT_BUDGET_S:-3600}"

  routine_wait_turn "$budget"

  # --- the target and the source ----------------------------------------------------
  local target="${MIGRATION_TARGET:-}"
  if [ -z "$target" ]; then
    target="$(migration_daily_version)"
    [ -n "$target" ] || routine_end skipped "no daily ran today and no MIGRATION_TARGET was given: there is no target to migrate to"
  fi
  routine_set TARGET "$target"
  local pypi="$RT_STATE/pypi-langflow.json" pair
  curl -fsS --max-time 60 https://pypi.org/pypi/langflow/json -o "$pypi" \
    || routine_end failed "could not read Langflow's release list from PyPI"
  pair="$(node "$REPO/scripts/resolve-migration-pair.mjs" --target "$target" --pypi-json "$pypi")" \
    || routine_end failed "no migration pair for $target: $(printf '%s' "$pair" | migration_json error)"
  MIG_TARGET="$target"
  MIG_SOURCE="$(printf '%s' "$pair" | migration_json source)"
  MIG_TARGET_IMAGE="$(printf '%s' "$pair" | migration_json target_image)"
  MIG_SOURCE_IMAGE="$(printf '%s' "$pair" | migration_json source_image)"
  routine_set SOURCE "$MIG_SOURCE"
  routine_set TARGET_IMAGE "$MIG_TARGET_IMAGE"
  routine_set SOURCE_IMAGE "$MIG_SOURCE_IMAGE"
  echo "pair: $MIG_SOURCE -> $MIG_TARGET ($MIG_SOURCE_IMAGE -> $MIG_TARGET_IMAGE)"
  local skipped
  skipped="$(printf '%s' "$pair" | migration_json skipped)"
  [ -z "$skipped" ] || [ "$skipped" = "[]" ] || echo "passed over: $skipped"

  # --- what every cell shares -------------------------------------------------------
  rm -rf "${MIG_WORK:?}"; mkdir -p "$MIG_WORK"
  migration_clear_docker
  # Only the provider key the credential witness needs: the routine never sources the
  # whole secrets file, so no publishing token reaches a Langflow it starts.
  OPENAI_API_KEY="$(migration_secret OPENAI_API_KEY)"
  export OPENAI_API_KEY
  export CREDENTIAL_VERDICT_FILE="$MIG_WORK/credential-verdict.json"
  if [ -n "$OPENAI_API_KEY" ]; then
    # The probe writes its file only for a blocking verdict (exit 1); exit 0 with no
    # file is a live account. Anything else decided nothing, and must not read as live.
    local prc=0
    python3 "$REPO/tests/github-workflows/migration/provider_credentials.py" --probe \
      --phase "pre-flight/vm-migration" --job api --marker "$CREDENTIAL_VERDICT_FILE" || prc=$?
    if [ "$prc" != 0 ] && [ ! -f "$CREDENTIAL_VERDICT_FILE" ]; then
      printf '{"verdict": "inconclusive", "reason": "the probe ended with status %s and no verdict"}\n' "$prc" > "$CREDENTIAL_VERDICT_FILE"
    fi
    echo "provider probe: $( [ -f "$CREDENTIAL_VERDICT_FILE" ] && migration_json verdict < "$CREDENTIAL_VERDICT_FILE" || echo live)"
  fi
  local ollama_out
  ollama_out="$(cd "$REPO" && OLLAMA_PORT=$MIG_OLLAMA_PORT bash scripts/start-ollama-source.sh 8>&- 2>&1)" \
    || routine_end failed "the local ollama did not start: $(printf '%s' "$ollama_out" | tail -n 1)"
  MIG_OLLAMA_HOST="$(printf '%s\n' "$ollama_out" | sed -n 's/^OLLAMA_HOST_IP=//p')"
  MIG_OLLAMA_URL="http://$MIG_OLLAMA_HOST:$MIG_OLLAMA_PORT"
  echo "ollama: $MIG_OLLAMA_URL"

  # --- the cells --------------------------------------------------------------------
  MIG_RESULTS="$MIG_WORK/cells.tsv"; : > "$MIG_RESULTS"
  local i=0 db mode scen auth
  for db in sqlite postgres; do
    for mode in pip docker; do
      for scen in fresh upgrade; do
        for auth in on off; do
          [ "$scen" = fresh ] && [ "$auth" = off ] && continue
          migration_cell "$i" "$db" "$mode" "$scen" "$auth"
          i=$((i + 1))
        done
      done
    done
  done

  migration_conclude
}

# --- one cell ---------------------------------------------------------------------------

# migration_cell <index> <db> <pip|docker> <fresh|upgrade> <on|off>
# Appends "<cell>\t<verdict>\t<detail>" to $MIG_RESULTS. Never exits the routine.
migration_cell() {
  local idx="$1" db="$2" mode="$3" scen="$4" auth="$5"
  local cell="$db-$mode-$scen"
  [ "$auth" = off ] && cell="$cell-autologin-off"
  case " $MIG_CELLS " in *" all "* | *" $cell "*) ;; *) return 0 ;; esac
  local port=$((7920 + idx)) pg=$((5470 + idx))
  local dir="$MIG_WORK/$cell"; mkdir -p "$dir"
  MC_PID=""; MC_CELL="$cell"; MC_DIR="$dir"; MC_PORT="$port"; MC_PG="$pg"; MC_DB="$db"; MC_MODE="$mode"
  MC_URL="http://127.0.0.1:$port"
  echo "--- cell $cell (port $port) ---"
  local first="$MIG_SOURCE"; [ "$scen" = fresh ] && first="$MIG_TARGET"
  local verdict detail

  # The source (or, fresh, the target), always with auto-login on: that is how the
  # instance being upgraded was used.
  if ! migration_up "$first" on; then
    # The SOURCE not starting on a clean database is not the target's fault: the
    # routine met a release it cannot run here. The fresh target not starting is red.
    local why="$MC_UP_VERDICT"; [ "$scen" = upgrade ] && why=failed
    migration_record "$cell" "$why" "$first: $MC_UP_WHY"; migration_down; return 0
  fi
  if ! python3 "$REPO/ops/vm/migration/cell.py" seed --url "$MC_URL" --state "$dir/state.json" \
       --ollama "$MIG_OLLAMA_URL" --version "$first" > "$dir/seed.log" 2>&1; then
    cat "$dir/seed.log"
    # A seed that fails on the SOURCE is not the target's fault: the routine's own
    # tooling met a version it does not speak, which is this machine's problem.
    if [ "$scen" = upgrade ]; then migration_record "$cell" failed "the seed failed on $first: $(tail -n 1 "$dir/seed.log")"
    else migration_record "$cell" red "the seed failed on the fresh $first: $(tail -n 1 "$dir/seed.log")"; fi
    migration_down; return 0
  fi
  cat "$dir/seed.log"

  if [ "$scen" = upgrade ]; then
    migration_stop_langflow
    if [ "$auth" = off ] && [ "$db" = postgres ]; then
      # Adversarial: the default account as #15326 found it, never signed in.
      migration_psql "UPDATE \"user\" SET last_login_at = NULL WHERE username = 'langflow';" \
        || { migration_record "$cell" failed "could not clear last_login_at for the adversarial seed"; migration_down; return 0; }
    fi
    if ! migration_up "$MIG_TARGET" "$auth"; then
      migration_record "$cell" "$MC_UP_VERDICT" "$MIG_TARGET on the migrated data: $MC_UP_WHY"; migration_down; return 0
    fi
  fi

  local login=auto; [ "$auth" = off ] && login=adopt
  local rc=0
  LANGFLOW_SUPERUSER="$MC_SU" LANGFLOW_SUPERUSER_PASSWORD="$MC_SU_PW" \
    python3 "$REPO/ops/vm/migration/cell.py" verify --url "$MC_URL" --state "$dir/state.json" \
      --login "$login" --ollama "$MIG_OLLAMA_URL" > "$dir/verify.log" 2>&1 || rc=$?
  cat "$dir/verify.log"
  local fails blocked
  fails="$(grep -E '^CHECK [^ ]+ fail' "$dir/verify.log" | cut -d' ' -f2 | tr '\n' ' ')"
  blocked="$(grep -E '^CHECK [^ ]+ blocked' "$dir/verify.log" | cut -d' ' -f2 | tr '\n' ' ')"
  if [ "$rc" = 3 ]; then verdict=red; detail="$MIG_TARGET stopped answering during the checks"
  elif [ -n "$fails" ]; then verdict=red; detail="failed: ${fails% }"
  elif [ "$rc" != 0 ]; then verdict=red; detail="verify ended with status $rc: $(tail -n 1 "$dir/verify.log")"
  elif [ -n "$blocked" ]; then verdict=blocked; detail="blocked: ${blocked% }"
  else verdict=green; detail="$(grep -c '^CHECK ' "$dir/verify.log") checks"; fi
  if [ "$verdict" = red ] && [ "$auth" = off ] && migration_before_15326 "$MIG_TARGET"; then
    detail="$detail (known: the target predates langflow-ai/langflow#15326)"
  fi
  migration_record "$cell" "$verdict" "$detail"
  migration_down
}

# Start one version for the current cell. Sets MC_UP_VERDICT (red|failed) and MC_UP_WHY
# on failure: an install or a pull that fails is this machine's; a version that is in
# place and does not answer is the product's.
migration_up() {
  local version="$1" auth="$2"
  MC_SU="langflow"; MC_SU_PW=""
  if [ "$auth" = off ]; then MC_SU="migration-admin"; MC_SU_PW="Admin-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  MC_LOG="$MC_DIR/langflow-$version.log"
  case "$MC_MODE" in
    pip) migration_up_pip "$version" "$auth" ;;
    docker) migration_up_docker "$version" "$auth" ;;
  esac || return 1
  # 240 s: the slowest start measured was 30 s (1.12.4, pip, 2026-10-06), and a first
  # start on migrated data runs the schema migrations too. Overridable for the tests only.
  local i wait_s="${MIGRATION_UP_WAIT_S:-240}"
  for i in $(seq 1 $((wait_s / 2))); do
    curl -fsS --max-time 3 "$MC_URL/health_check" > /dev/null 2>&1 && { echo "up: $version after $((i * 2))s"; return 0; }
    sleep 2
  done
  MC_UP_VERDICT=red; MC_UP_WHY="did not answer /health_check in ${wait_s}s: $(migration_log_tail)"
  return 1
}

migration_up_pip() {
  local version="$1" auth="$2" venv="$MC_DIR/venv"
  [ -d "$venv" ] || uv venv -q -p "$MIG_PY" "$venv" 8>&- \
    || { MC_UP_VERDICT=failed; MC_UP_WHY="uv could not create a Python $MIG_PY venv"; return 1; }
  # --prerelease=allow for a dev or rc target; the extra brings the Postgres driver to
  # both versions, as the Actions job installed it.
  # psycopg[binary] beside it: the extra brings psycopg without a driver, and this machine
  # has no libpq (the Actions runner had one), so Postgres cells failed to connect at all.
  local extra=(); [ "$MC_DB" = postgres ] && extra=("psycopg[binary]")
  if ! uv pip install -q -p "$venv/bin/python" --prerelease=allow "langflow[postgresql]==$version" ${extra[@]+"${extra[@]}"} > "$MC_DIR/install-$version.log" 2>&1 8>&-; then
    MC_UP_VERDICT=failed; MC_UP_WHY="pip install failed: $(tail -n 1 "$MC_DIR/install-$version.log")"; return 1
  fi
  if [ "$MC_DB" = postgres ] && ! migration_pg_up; then return 1; fi
  (
    export HOME="$MC_DIR/home"; mkdir -p "$HOME"
    # How the witness flows reach the local ollama: the process environment is the
    # unified model's runtime fallback, and needs no provider setup through the API.
    export OLLAMA_BASE_URL="$MIG_OLLAMA_URL"
    # The SSRF guard blocks private addresses; this one host, and nothing else, is ours.
    export LANGFLOW_SSRF_ALLOWED_HOSTS="$MIG_OLLAMA_HOST"
    unset LANGFLOW_DATABASE_URL
    [ "$MC_DB" = postgres ] && export LANGFLOW_DATABASE_URL="postgresql://langflow:langflow@127.0.0.1:$MC_PG/langflow"
    if [ "$auth" = off ]; then
      export LANGFLOW_AUTO_LOGIN=false LANGFLOW_SUPERUSER="$MC_SU" LANGFLOW_SUPERUSER_PASSWORD="$MC_SU_PW"
    fi
    exec "$venv/bin/langflow" run --host 127.0.0.1 --port "$MC_PORT" --backend-only
  ) >> "$MC_LOG" 2>&1 8>&- &
  MC_PID=$!
  return 0
}

migration_up_docker() {
  local version="$1" auth="$2" image
  image="$MIG_SOURCE_IMAGE"; [ "$version" = "$MIG_TARGET" ] && image="$MIG_TARGET_IMAGE"
  if ! docker pull -q "$image" > /dev/null 2>> "$MC_LOG"; then
    MC_UP_VERDICT=failed; MC_UP_WHY="docker pull $image failed: $(migration_log_tail)"; return 1
  fi
  local name="e2e-migration-$MC_CELL" envs=(-e LANGFLOW_CONFIG_DIR=/app/langflow -e LANGFLOW_HOST=0.0.0.0 -e "OLLAMA_BASE_URL=$MIG_OLLAMA_URL" -e "LANGFLOW_SSRF_ALLOWED_HOSTS=$MIG_OLLAMA_HOST")
  if [ "$auth" = off ]; then
    envs+=(-e LANGFLOW_AUTO_LOGIN=false -e "LANGFLOW_SUPERUSER=$MC_SU" -e "LANGFLOW_SUPERUSER_PASSWORD=$MC_SU_PW")
  else
    # Explicit: the published images default to auto-login OFF (measured 2026-10-06),
    # unlike a pip install. The instance being upgraded was used with it on.
    envs+=(-e LANGFLOW_AUTO_LOGIN=true -e LANGFLOW_SUPERUSER_PASSWORD=unused-with-auto-login)
  fi
  if [ "$MC_DB" = sqlite ]; then
    docker rm -f "$name" > /dev/null 2>&1
    docker run -d --name "$name" -p "127.0.0.1:$MC_PORT:7860" -v "$name-data:/app/langflow" \
      -e LANGFLOW_SAVE_DB_IN_CONFIG_DIR=true "${envs[@]}" "$image" >> "$MC_LOG" 2>&1 \
      || { MC_UP_VERDICT=failed; MC_UP_WHY="docker run failed: $(migration_log_tail)"; return 1; }
  else
    migration_compose "$image" "$auth" || return 1
  fi
  ( docker logs -f "$name" >> "$MC_LOG" 2>&1 & ) 8>&-
  return 0
}

# upstream's docker_example compose, fetched once per run, with an override that keeps
# every port on this lane's loopback and drops postgres' host port.
migration_compose() {
  local image="$1" auth="$2" c="$MIG_WORK/compose"
  if [ ! -f "$c/docker-compose.yml" ]; then
    mkdir -p "$c"
    curl -fsS --max-time 60 -o "$c/docker-compose.yml" \
      https://raw.githubusercontent.com/langflow-ai/langflow/main/docker_example/docker-compose.yml \
      || { MC_UP_VERDICT=failed; MC_UP_WHY="could not fetch upstream's docker_example compose file"; return 1; }
  fi
  local env_auto="true"; [ "$auth" = off ] && env_auto="false"
  cat > "$MC_DIR/override.yml" <<EOF
services:
  langflow:
    image: $image
    pull_policy: never
    container_name: e2e-migration-$MC_CELL
    ports: !override
      - "127.0.0.1:$MC_PORT:7860"
    environment:
      - OLLAMA_BASE_URL=$MIG_OLLAMA_URL
      - LANGFLOW_SSRF_ALLOWED_HOSTS=$MIG_OLLAMA_HOST
      - LANGFLOW_AUTO_LOGIN=$env_auto
      - LANGFLOW_SUPERUSER=$MC_SU
  postgres:
    container_name: e2e-migration-$MC_CELL-pg
    ports: !override
      - "127.0.0.1:$MC_PG:5432"
EOF
  local pw="${MC_SU_PW:-unused-with-auto-login}"
  if ! LANGFLOW_SUPERUSER_PASSWORD="$pw" docker compose -p "e2e-migration-$MC_CELL" \
       -f "$c/docker-compose.yml" -f "$MC_DIR/override.yml" up -d >> "$MC_LOG" 2>&1 8>&-; then
    MC_UP_VERDICT=failed; MC_UP_WHY="docker compose up failed: $(migration_log_tail)"; return 1
  fi
}

# A Postgres 16 for a pip cell, on the cell's port, data in a named volume.
migration_pg_up() {
  local name="e2e-migration-$MC_CELL-pg"
  docker inspect "$name" > /dev/null 2>&1 && return 0
  docker run -d --name "$name" -p "127.0.0.1:$MC_PG:5432" -v "$name:/var/lib/postgresql/data" \
    -e POSTGRES_USER=langflow -e POSTGRES_PASSWORD=langflow -e POSTGRES_DB=langflow postgres:16-trixie >> "$MC_LOG" 2>&1 \
    || { MC_UP_VERDICT=failed; MC_UP_WHY="postgres did not start: $(migration_log_tail)"; return 1; }
  local i
  for i in $(seq 1 30); do
    docker exec "$name" pg_isready -U langflow > /dev/null 2>&1 && return 0
    sleep 1
  done
  MC_UP_VERDICT=failed; MC_UP_WHY="postgres did not become ready in 30s"; return 1
}

migration_psql() {
  docker exec -i "e2e-migration-$MC_CELL-pg" psql -v ON_ERROR_STOP=1 -U langflow -d langflow -c "$1"
}

# Stop Langflow, keep the data: the venv and its package database, the volumes.
migration_stop_langflow() {
  case "$MC_MODE" in
    pip)
      # Nothing to stop when the install failed before a start: under set -u an unset
      # pid ended the whole routine with no verdict.
      [ -n "${MC_PID:-}" ] || return 0
      kill "$MC_PID" 2> /dev/null
      local i; for i in $(seq 1 30); do kill -0 "$MC_PID" 2> /dev/null || break; sleep 1; done
      kill -9 "$MC_PID" 2> /dev/null; MC_PID="" ;;
    docker)
      if [ "$MC_DB" = sqlite ]; then docker rm -f "e2e-migration-$MC_CELL" > /dev/null 2>&1
      else docker compose -p "e2e-migration-$MC_CELL" -f "$MIG_WORK/compose/docker-compose.yml" -f "$MC_DIR/override.yml" rm -sf langflow > /dev/null 2>&1; fi ;;
  esac
}

# Everything the cell owned, gone, so the next cell starts clean.
migration_down() {
  migration_stop_langflow
  docker rm -f "e2e-migration-$MC_CELL" "e2e-migration-$MC_CELL-pg" > /dev/null 2>&1
  if [ -f "$MC_DIR/override.yml" ]; then
    docker compose -p "e2e-migration-$MC_CELL" -f "$MIG_WORK/compose/docker-compose.yml" -f "$MC_DIR/override.yml" down -v > /dev/null 2>&1
  fi
  docker volume rm -f "e2e-migration-$MC_CELL-data" "e2e-migration-$MC_CELL-pg" > /dev/null 2>&1
  rm -rf "${MC_DIR:?}/venv"
}

migration_record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ')" >> "$MIG_RESULTS"
  echo "cell $1: $2 — $3"
}

# --- the routine's verdict ---------------------------------------------------------------

migration_conclude() {
  local red failed blocked green total
  total="$(wc -l < "$MIG_RESULTS" | tr -d ' ')"
  red="$(awk -F'\t' '$2=="red"{print $1}' "$MIG_RESULTS" | tr '\n' ' ')"
  failed="$(awk -F'\t' '$2=="failed"{print $1}' "$MIG_RESULTS" | tr '\n' ' ')"
  blocked="$(awk -F'\t' '$2=="blocked"{print $1}' "$MIG_RESULTS" | tr '\n' ' ')"
  green="$(awk -F'\t' '$2=="green"' "$MIG_RESULTS" | wc -l | tr -d ' ')"
  routine_set CELLS_GREEN "$green/$total"
  routine_set RED_CELLS "${red% }"
  routine_set FAILED_CELLS "${failed% }"
  routine_set BLOCKED_CELLS "${blocked% }"

  # The detail the issue shows: the table, and whether the red set changed since the
  # last red day -- inside one open issue, a new cause must not read as more of the old.
  local detail="$RT_STATE/results/$RT_STAMP.md" prev
  prev="$(migration_previous_red)"
  {
    echo "Migration \`$MIG_SOURCE\` → \`$MIG_TARGET\` (images \`$MIG_SOURCE_IMAGE\` → \`$MIG_TARGET_IMAGE\`)."
    echo
    if [ -n "$red" ] && [ -n "$prev" ] && [ "${red% }" != "$prev" ]; then
      echo "**The red cells changed since the last red day** (were: \`$prev\`)."
      echo
    fi
    echo "| Cell | Verdict | Detail |"
    echo "|---|---|---|"
    awk -F'\t' '{gsub(/\|/,"\\|",$3); printf "| %s | %s | %s |\n", $1, $2, $3}' "$MIG_RESULTS"
  } > "$detail"
  routine_set DETAIL "$detail"

  [ "$total" -gt 0 ] || routine_end failed "no cell ran (MIGRATION_CELLS='$MIG_CELLS')"
  if [ -n "$red" ]; then routine_end red "$(echo $red | wc -w | tr -d ' ') of $total cells red: ${red% }"; fi
  if [ -n "$failed" ]; then routine_end failed "$(echo $failed | wc -w | tr -d ' ') of $total cells could not run: ${failed% }"; fi
  if [ -n "$blocked" ]; then routine_end blocked "credential check blocked in: ${blocked% }"; fi
  routine_end green "$total of $total cells green, $MIG_SOURCE → $MIG_TARGET"
}

# RED_CELLS of the newest earlier result that was red, or nothing.
migration_previous_red() {
  local f
  for f in $(ls -1 "$RT_STATE"/results/*.env 2> /dev/null | sort -r); do
    [ "$f" = "$RT_STATE/results/$RT_STAMP.env" ] && continue
    grep -qx 'STATUS=red' "$f" || continue
    sed -n 's/^RED_CELLS=//p' "$f" | tail -n 1
    return 0
  done
}

# --- helpers ----------------------------------------------------------------------------

routine_cleanup() {
  [ -n "${MIG_WORK:-}" ] || return 0
  migration_clear_docker
  ( cd "$REPO" && OLLAMA_PORT="$MIG_OLLAMA_PORT" bash scripts/stop-ollama-source.sh ) > /dev/null 2>&1 || true
  pkill -f "langflow run --host 127.0.0.1 --port 79(2[0-9]|3[01])" 2> /dev/null || true
  # The images this run pulled: retention is task 8's decision, and until then a day's
  # pulls do not accumulate.
  local img
  for img in "${MIG_SOURCE_IMAGE:-}" "${MIG_TARGET_IMAGE:-}"; do
    [ -n "$img" ] && docker rmi "$img" > /dev/null 2>&1 || true
  done
  rm -rf "${MIG_WORK:?}"/*/venv
  echo "cleanup: containers, volumes, ollama and venvs removed"
}

# Every container, compose project and volume this routine names, whatever cell left it.
migration_clear_docker() {
  local ids
  ids="$(docker ps -aq --filter name=^e2e-migration- 2> /dev/null)"
  [ -z "$ids" ] || docker rm -f $ids > /dev/null 2>&1
  ids="$(docker volume ls -q --filter name=^e2e-migration- 2> /dev/null)"
  [ -z "$ids" ] || docker volume rm -f $ids > /dev/null 2>&1
  return 0
}

# The version today's daily served, from its run-metadata.json.
migration_daily_version() {
  local runs="${MIGRATION_DAILY_RUNS:-$REPO/runs}" today d v=""
  today="$(date -u +%Y%m%d)"
  for d in "$runs/$today"T*/; do
    [ -f "$d/run-metadata.json" ] || continue
    v="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("langflow_version",""))' "$d/run-metadata.json" 2> /dev/null)"
  done
  printf '%s\n' "$v"
}

migration_before_15326() {
  python3 -c 'import sys,re; m=re.match(r"(\d+)\.(\d+)",sys.argv[1]); sys.exit(0 if m and (int(m[1]),int(m[2]))<(1,13) else 1)' "$1"
}

migration_json() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(json.dumps(v) if isinstance(v,(list,dict)) else ("" if v is None else v))' "$1"; }

# One key from the secrets file, read without sourcing it.
migration_secret() {
  sed -n "s/^\(export \)\{0,1\}$1=//p" "${E2E_ROUTINE_SECRETS:-/root/.e2e-secrets}" 2> /dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"
}

# The last lines of the cell's Langflow log, without the terminal colours its logger
# writes even to a file, so the issue's table reads as text.
migration_log_tail() { tail -n 3 "$MC_LOG" 2> /dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | tr '\n' ' ' | cut -c1-300; }

main "$@"
