#!/usr/bin/env bash
# The on-demand run: what e2e-on-demand.service runs.
#
# ## What it is
#
# One @stable run against ONE BRANCH OF UPSTREAM, built into an image on this machine,
# answered for one request. It joins the two pieces that already work by hand:
# ops/vm/build-target-image.sh (the image of the branch's commit, labelled with it) and
# run-e2e.sh's declared target (#2111), which refuses to call green a run that served
# anything but that commit.
#
# It has NO consequence. It opens no issue, removes no @stable, posts nothing to Slack or
# to the platform, and writes no line into the official ledger. As in the shadow, the
# switches being off is the mechanism, and behind them the publishing credentials are
# unset and gh points at an empty config, so a switch flipped by mistake fails for want
# of a credential instead of speaking for a run nobody scheduled.
#
# ## The request is data, never a command
#
# $STATE/request.env holds KEY=VALUE lines. It is PARSED, never sourced: whoever can
# write a request can ask for a run, and nothing more. Every key is known and every
# value is checked against the shape it must have; anything else refuses the request.
#
#   ONDEMAND_ID            required  [A-Za-z0-9._-], at most 64: names the request and
#                                    its result; a result already on file refuses it
#   ONDEMAND_REF           required  a branch of upstream (build-target-image.sh decides
#                                    whether it is one; a fork never is)
#   ONDEMAND_PROVIDER      optional  the provider the agent specs run against, instead
#                                    of the day's rotation (DECLARED_MODEL_PROVIDER)
#   ONDEMAND_MODEL         optional  a model of that provider (DECLARED_MODEL_ID)
#   ONDEMAND_REQUESTED_BY  optional  who asked; carried into the result, never trusted
#
# The request is consumed when it is read -- moved to $STATE/requests/<id>.env -- so
# each start answers exactly one request, and the result says how.
#
# ## The result
#
# $STATE/results/<id>.env, written whole and then renamed, KEY=VALUE, one per line,
# values with no newline. Like the request it is meant to be parsed, not sourced.
# STATUS is one of:
#
#   refused       nothing was built: a malformed request, the daily's window, a branch
#                 that is not upstream's, another run holding the lock
#   build_failed  the commit could not be built the nightly's way, or built wrong
#   failed        the machine could not do its part (upstream unreachable, no
#                 tomllib), or the suite did not get as far as a results.json
#   done          the suite ran; VERDICT says green or red, and RUN_ID finds it
#
# and the exit status follows it: 0 done/green, 1 done/red, 2 refused, 3 failed,
# 4 build_failed.
#
# ## The daily has priority, always
#
#   - A run does not START on a weekday from 07:30 to 08:40 UTC: it takes about 25
#     minutes, and the daily starts at 08:00 and is followed by the shadow.
#   - It does not start while the daily or the shadow is active, or while a shadow
#     request is waiting to be picked up, whatever the clock says.
#   - A run already going when the daily starts is stopped by run-daily.sh, the way the
#     shadow is.
#
# ## Where it runs, so no lane touches another
#
# Disjoint from BOTH other lanes on every resource a run owns, because run-e2e.sh's
# hygiene clears only its own ports and the backend containers are named by port alone
# (langflow-e2e-lane-<port>):
#
#   ports     7890-7893, echo 8100, ollama 11454  (official 7870-7873/8080/11434,
#                                                  shadow   7880-7883/8090/11444)
#   suite     its own worktree, detached at the commit the clone holds, removed after
#   image     langflow-ondemand:<commit>, removed after, with the build cache
#   ledger    a fresh COPY of the official ledger per run, removed after: the triage
#             summary reads recurrence against the daily's history, and the official
#             file never receives a line from a run that is not the daily
#   runs      $STATE/runs
#   logs      /var/log/e2e-on-demand
#
# ## Cleanup is not optional
#
# On every exit, including a stop by the daily: the four backend containers removed and
# checked gone, echo and ollama stopped on this lane's ports, every langflow-ondemand
# image removed, the build cache pruned (`docker builder prune -af`, never `docker system
# prune`, which would take the other lanes' images), the worktree and the ledger copy
# removed. A cleanup that could not confirm the containers gone says so in the result.
main() {
  set -uo pipefail
  export HOME="${HOME:-/root}"
  export PATH="$HOME/.local/bin:$PATH"

  # Overridable ONLY so the refusals and the isolation can be exercised without the
  # machine.
  local REPO="${E2E_ONDEMAND_REPO:-/root/e2e-qa}"
  local STATE="${E2E_ONDEMAND_STATE:-/root/e2e-on-demand}"
  local LOG_DIR="${E2E_ONDEMAND_LOG_DIR:-/var/log/e2e-on-demand}"
  local SECRETS="${E2E_ONDEMAND_SECRETS:-/root/.e2e-secrets}"
  local OFFICIAL_LEDGER="${E2E_ONDEMAND_OFFICIAL_LEDGER:-${XDG_STATE_HOME:-$HOME/.local/state}/langflow-e2e}"
  local SHADOW_STATE="${E2E_SHADOW_STATE:-/root/e2e-shadow}"
  # "<ISO weekday 1-7> <HHMM>", UTC. Tests only: the window is otherwise the clock's.
  local NOW="${E2E_ONDEMAND_NOW:-$(date -u '+%u %H%M')}"

  mkdir -p "$LOG_DIR" "$STATE/requests" "$STATE/results"
  local STAMP LOG
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  LOG="$LOG_DIR/$STAMP.log"
  exec >>"$LOG" 2>&1
  ln -sfn "$LOG" "$LOG_DIR/latest.log"
  echo "=== on-demand start $STAMP ==="

  # Globals, not locals: the EXIT trap runs after main has returned, when a local is out
  # of scope (build-target-image.sh lost its cleanup to exactly that).
  OD_STATE="$STATE"; OD_REPO="$REPO"; OD_LOG="$LOG"
  OD_ID=""; OD_REF=""; OD_PROVIDER=""; OD_MODEL=""; OD_BY=""
  OD_STATUS=""; OD_REASON=""; OD_EXIT=""; OD_VERDICT=""
  OD_RUN_ID=""; OD_SUITE_SHA=""; OD_WT=""; OD_LEDGER=""
  OD_TARGET_SHA=""; OD_TARGET_VERSION=""; OD_BUILD_S=""; OD_IMAGE=""
  OD_STARTED="$STAMP"; OD_CLEANING=0; OD_TOUCHED=0; OD_PARSE_ERR=""; OD_LOG_DIR="$LOG_DIR"

  # --- one run at a time ------------------------------------------------------------
  # Before the request is read: a second start while one runs must not consume the
  # next request and answer it "busy". systemd already joins a second start of a
  # oneshot to the running job; this covers the script run by hand.
  command -v flock > /dev/null 2>&1 || { echo "FATAL: flock is not on this machine, and without it two runs could share it"; exit 3; }
  exec 9> "$STATE/lock"
  flock -n 9 || { echo "REFUSED: another on-demand run holds $STATE/lock — the request is left for when it ends"; exit 2; }

  # --- the request: parsed, consumed, checked ---------------------------------------
  local REQ="$STATE/request.env"
  [ -r "$REQ" ] || { echo "REFUSED: no request at $REQ"; exit 2; }
  local raw
  raw="$(cat "$REQ")" || { echo "FATAL: cannot read $REQ"; exit 3; }
  # Consumed before it is judged, so a malformed request is not met again by the next
  # start. Kept under a name of its own for whoever asks why it was refused -- with the
  # PID in it: two refusals in the same second shared the stamp on the qa (2026-10-01),
  # and the second one's copy replaced the first's.
  local KEPT="$STATE/requests/unparsed-$STAMP-$$.env"
  mv -f "$REQ" "$KEPT"

  ondemand_parse_request "$raw" || ondemand_refuse "the request is malformed: $OD_PARSE_ERR" "$KEPT"
  # Before anything is written under the id: a second request with it must not replace
  # the first one's request or result.
  [ ! -e "$STATE/results/$OD_ID.env" ] || ondemand_refuse "request $OD_ID was already answered — an id names one run" "$KEPT"
  mv -f "$KEPT" "$STATE/requests/$OD_ID.env"
  echo "request: id=$OD_ID ref=$OD_REF provider=${OD_PROVIDER:-<rotation>} model=${OD_MODEL:-<default>} by=${OD_BY:-<unnamed>}"
  # From here on every exit writes the result for this id.
  trap ondemand_finish EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT

  # --- the daily's window -----------------------------------------------------------
  local dow="${NOW%% *}" hm="${NOW##* }"
  if [ "$dow" -le 5 ] && [ "$((10#$hm))" -ge 730 ] && [ "$((10#$hm))" -lt 840 ]; then
    ondemand_refuse "the daily's window is closed (weekdays 07:30-08:40 UTC, now $hm on day $dow)"
  fi
  local unit st
  for unit in e2e-daily.service e2e-shadow.service; do
    st="$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || true)"
    case "$st" in
      activating | active | reloading | deactivating) ondemand_refuse "$unit is $st — the daily lane has priority" ;;
    esac
  done
  [ ! -e "$SHADOW_STATE/request.env" ] || ondemand_refuse "a shadow request is waiting at $SHADOW_STATE/request.env — the shadow is about to start"

  # --- leftovers of a run that was killed rather than finished ----------------------
  # Past every refusal: a request refused while the daily runs must not touch docker.
  OD_TOUCHED=1
  ondemand_clear_images

  # --- the suite: the clone's commit, in a worktree of its own ----------------------
  # The commit the last daily left the clone on, so the comparison with the daily reads
  # the same suite. Not pulled: the clone is the daily's, and its pull is the daily's.
  OD_SUITE_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || OD_SUITE_SHA=""
  [[ "$OD_SUITE_SHA" =~ ^[0-9a-f]{40}$ ]] || ondemand_fail 3 failed "the clone at $REPO has no commit to run"
  OD_WT="$STATE/wt"
  git -C "$REPO" worktree prune
  if [ -e "$OD_WT" ]; then
    git -C "$REPO" worktree remove --force "$OD_WT" 2>/dev/null || rm -rf "$OD_WT"
    git -C "$REPO" worktree prune
  fi
  git -C "$REPO" worktree add -q --detach "$OD_WT" "$OD_SUITE_SHA" || ondemand_fail 3 failed "could not create the worktree at $OD_WT"
  echo "suite at: $(git -C "$OD_WT" log --oneline -1)"
  # The provider keys that decide which spec files enter the suite are read from the
  # working copy's .env (#1764): linked, as the shadow does, so all lanes read one file.
  [ -f "$REPO/.env" ] && ln -sfn "$REPO/.env" "$OD_WT/.env"

  # --- the image of the branch's commit ---------------------------------------------
  local built rc=0 build_err="$STATE/build-stderr.$$" said
  # 9>&- on everything that can leave a process behind: a daemon that inherited the
  # lock's descriptor would hold the lock after this run, and refuse every next one.
  #
  # Its stderr is kept apart and then copied to the log: the script's own reason is its
  # last `build-target-image:` line, and the RESULT has to carry it. "See the line above"
  # pointed at a line only the log had (qa, 2026-10-01), and the result is what the
  # platform will show.
  built="$(BUILD_ROOT="$STATE/builds" "$OD_WT/ops/vm/build-target-image.sh" "$OD_REF" 9>&- 2> "$build_err")" || rc=$?
  cat "$build_err" 2>/dev/null
  said="$(grep '^build-target-image: ' "$build_err" 2>/dev/null | tail -n 1)"
  said="${said#build-target-image: }"
  rm -f "$build_err"
  case "$rc" in
    0) ;;
    2) ondemand_refuse "build refused (status 2): ${said:-no reason given}" ;;
    3 | 7) ondemand_fail 3 failed "build could not do its part (status $rc), the machine or the network, not the branch: ${said:-no reason given}" ;;
    *) ondemand_fail 4 build_failed "build failed (status $rc), not a test result: ${said:-no reason given}" ;;
  esac
  # Read by name, never evaluated: the script's output is the one thing here that came
  # from somewhere a request can influence.
  local line
  while IFS= read -r line; do
    case "$line" in
      target_ref=*) [ "${line#target_ref=}" = "$OD_REF" ] || ondemand_fail 4 build_failed "the build answered for '${line#target_ref=}', not $OD_REF" ;;
      target_sha=*) OD_TARGET_SHA="${line#target_sha=}" ;;
      target_version=*) OD_TARGET_VERSION="${line#target_version=}" ;;
      image=*) OD_IMAGE="${line#image=}" ;;
      build_s=*) OD_BUILD_S="${line#build_s=}" ;;
    esac
  done <<< "$built"
  [[ "$OD_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$OD_IMAGE" =~ ^langflow-ondemand:[0-9a-f]{12}$ ]] && [ -n "$OD_TARGET_VERSION" ] \
    || ondemand_fail 4 build_failed "the build's answer is incomplete: sha='$OD_TARGET_SHA' image='$OD_IMAGE' version='$OD_TARGET_VERSION'"
  echo "built: $OD_REF @ ${OD_TARGET_SHA:0:12}, version $OD_TARGET_VERSION, ${OD_BUILD_S}s, as $OD_IMAGE"

  # --- credentials: the provider keys, and nothing that can publish -----------------
  if [ -r "$SECRETS" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS"
  else
    ondemand_fail 3 failed "$SECRETS is missing or unreadable"
  fi
  unset SOURCE_PUSH_TOKEN GH_TOKEN GITHUB_TOKEN QA_E2E_AUTOMATION_TOKEN SUPABASE_SERVICE_ROLE_KEY SLACK_WEBHOOK_URL
  unset GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  mkdir -p "$STATE/no-gh-login"
  export GH_CONFIG_DIR="$STATE/no-gh-login"

  # --- the ledger: a copy, fresh for this run ---------------------------------------
  OD_LEDGER="$STATE/ledger-$OD_ID"
  rm -rf "$OD_LEDGER"
  mkdir -p "$OD_LEDGER"
  if [ -d "$OFFICIAL_LEDGER" ]; then
    cp -p "$OFFICIAL_LEDGER"/*.jsonl "$OFFICIAL_LEDGER"/*.json "$OD_LEDGER"/ 2>/dev/null || true
  fi

  # --- the run ------------------------------------------------------------------------
  OD_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
  export RUN_ID="$OD_RUN_ID"
  export TARGET_SSH=local
  export TARGET_KIND=image
  export LANGFLOW_IMAGE="$OD_IMAGE"
  export TARGET_DECLARED_SHA="$OD_TARGET_SHA" TARGET_DECLARED_VERSION="$OD_TARGET_VERSION" TARGET_DECLARED_REF="$OD_REF"
  export DECLARED_MODEL_PROVIDER="$OD_PROVIDER" DECLARED_MODEL_ID="$OD_MODEL"
  export BASE_PORT=7890 SHARDS=4 ECHO_PORT=8100 OLLAMA_PORT=11454
  export WORKFLOW_ID=on-demand-stable
  export LEDGER_DIR="$OD_LEDGER"
  export RUNS_ROOT="$STATE/runs"
  export CREATE_ISSUE=0 AUTO_REMOVE=0 NOTIFY_SLACK=0 NOTIFY_SLACK_ALWAYS=0 POST_QA_PLATFORM=0
  export CHECK_MIRROR=0
  unset LANGFLOW_SRC_RUN_CMD LANGFLOW_SRC_FRONTEND_DIR TARGET_VENV PREPARE_TARGET
  mkdir -p "$RUNS_ROOT"

  ( cd "$OD_WT" && ./scripts/run-e2e.sh ) 9>&-
  rc=$?
  echo "=== run end, exit=$rc ==="
  # The suite reached a verdict only if it wrote one. run-e2e.sh exits 1 for a red day
  # and for a run that died in preflight alike; the file is what tells them apart.
  if [ -f "$RUNS_ROOT/$OD_RUN_ID/results.json" ]; then
    OD_STATUS=done
    if [ "$rc" = "0" ]; then OD_VERDICT=green; OD_EXIT=0; else OD_VERDICT=red; OD_EXIT=1; fi
    OD_REASON="the suite ran (run-e2e.sh exit $rc)"
  else
    OD_STATUS=failed; OD_EXIT=3
    OD_REASON="run-e2e.sh exited $rc without a results.json — the suite never reached a verdict; see $OD_LOG"
  fi
  exit "$OD_EXIT"
}

# Parses the request into the OD_* globals. On a malformed one, sets OD_PARSE_ERR and
# fails. Not called in $( ): the globals it sets would be lost with the subshell.
# Never sources, never evaluates: each line is split at its first '=' and the key must
# be one of five.
ondemand_parse_request() {
  local raw="$1" line key value seen=" "
  OD_ID=""; OD_REF=""; OD_PROVIDER=""; OD_MODEL=""; OD_BY=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | '#'*) continue ;; esac
    case "$line" in *=*) ;; *) OD_PARSE_ERR="a line is not KEY=VALUE: '${line:0:80}'"; return 1 ;; esac
    key="${line%%=*}"; value="${line#*=}"
    case "$seen" in *" $key "*) OD_PARSE_ERR="$key is given twice"; return 1 ;; esac
    seen="$seen$key "
    case "$key" in
      ONDEMAND_ID)
        [[ "$value" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { OD_PARSE_ERR="ONDEMAND_ID must be 1-64 of [A-Za-z0-9._-]: '${value:0:80}'"; return 1; }
        OD_ID="$value" ;;
      ONDEMAND_REF)
        [[ "$value" =~ ^[A-Za-z0-9._/-]{1,200}$ ]] || { OD_PARSE_ERR="ONDEMAND_REF has characters a branch name here cannot: '${value:0:80}'"; return 1; }
        OD_REF="$value" ;;
      ONDEMAND_PROVIDER)
        [[ "$value" =~ ^[a-z0-9-]{0,40}$ ]] || { OD_PARSE_ERR="ONDEMAND_PROVIDER has characters a provider name cannot: '${value:0:80}'"; return 1; }
        OD_PROVIDER="$value" ;;
      ONDEMAND_MODEL)
        [[ "$value" =~ ^[A-Za-z0-9._:/-]{0,120}$ ]] || { OD_PARSE_ERR="ONDEMAND_MODEL has characters a model id cannot: '${value:0:80}'"; return 1; }
        OD_MODEL="$value" ;;
      ONDEMAND_REQUESTED_BY)
        [[ "$value" =~ ^[A-Za-z0-9._@+-]{0,128}$ ]] || { OD_PARSE_ERR="ONDEMAND_REQUESTED_BY has characters a login cannot: '${value:0:80}'"; return 1; }
        OD_BY="$value" ;;
      *) OD_PARSE_ERR="unknown key '${key:0:40}'"; return 1 ;;
    esac
  done <<< "$raw"
  [ -n "$OD_ID" ] || { OD_PARSE_ERR="ONDEMAND_ID is missing"; return 1; }
  [ -n "$OD_REF" ] || { OD_PARSE_ERR="ONDEMAND_REF is missing"; return 1; }
  if [ -n "$OD_MODEL" ] && [ -z "$OD_PROVIDER" ]; then
    OD_PARSE_ERR="ONDEMAND_MODEL needs ONDEMAND_PROVIDER: a model is declared for a provider"; return 1
  fi
  return 0
}

# A refusal: nothing ran, or nothing more will. Before the request has an id there is
# no result to write, so the refusal is the log line alone.
ondemand_refuse() {
  echo "REFUSED: $1"
  [ -n "${2:-}" ] && echo "         the request is kept at $2"
  OD_STATUS=refused; OD_EXIT=2; OD_REASON="$1"
  exit 2
}

ondemand_fail() {
  echo "FAILED ($2): $3"
  OD_EXIT="$1"; OD_STATUS="$2"; OD_REASON="$3"
  exit "$1"
}

# Every langflow-ondemand image, whatever commit: this lane builds them and no other
# lane uses them, so none is anyone else's. Never `docker system prune`.
ondemand_clear_images() {
  local ids
  ids="$(docker images -q langflow-ondemand 2>/dev/null | sort -u)"
  [ -z "$ids" ] || { echo "removing langflow-ondemand image(s): $(echo "$ids" | tr '\n' ' ')"; echo "$ids" | xargs docker rmi -f > /dev/null 2>&1 || true; }
}

# The EXIT trap: cleanup, then the result. Runs once, even if a signal arrives during it.
ondemand_finish() {
  local code=$?
  [ "$OD_CLEANING" = "0" ] || return 0
  OD_CLEANING=1
  trap '' TERM INT
  if [ -z "$OD_STATUS" ]; then
    # An exit nobody classified: a signal (the daily stopping this run), or a bug.
    OD_STATUS=failed; OD_EXIT=3
    case "$code" in
      143) OD_REASON="stopped by SIGTERM — the daily lane starting, or systemctl stop" ;;
      130) OD_REASON="interrupted" ;;
      *) OD_REASON="ended with status $code before a verdict" ;;
    esac
  fi

  local cleanup=ok
  if [ "$OD_TOUCHED" = "1" ]; then
  echo "--- cleanup ---"
  local port left
  for port in 7890 7891 7892 7893; do
    docker rm -f "langflow-e2e-lane-$port" > /dev/null 2>&1 || true
  done
  left="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^langflow-e2e-lane-789[0-3]$' || true)"
  if [ -n "$left" ]; then
    cleanup=incomplete
    echo "ERROR: container(s) still present after removal: $(echo "$left" | tr '\n' ' ')"
  fi
  if [ -n "$OD_WT" ] && [ -d "$OD_WT/scripts" ]; then
    ( cd "$OD_WT"; ECHO_PORT=8100 bash scripts/stop-echo-source.sh; OLLAMA_PORT=11454 bash scripts/stop-ollama-source.sh ) 2>&1 | sed 's/^/    /' || true
  fi
  ondemand_clear_images
  docker builder prune -af > /dev/null 2>&1 || echo "WARNING: docker builder prune failed — the build cache may be left"
  if [ -n "$OD_WT" ] && [ -e "$OD_WT" ]; then
    git -C "$OD_REPO" worktree remove --force "$OD_WT" 2>/dev/null || rm -rf "$OD_WT"
    git -C "$OD_REPO" worktree prune 2>/dev/null || true
  fi
  [ -z "$OD_LEDGER" ] || rm -rf "$OD_LEDGER"
  echo "cleanup: $cleanup"
  fi

  if [ -n "$OD_ID" ]; then
    local res="$OD_STATE/results/$OD_ID.env" tmp
    tmp="$res.tmp"
    {
      ondemand_kv ONDEMAND_ID "$OD_ID"
      ondemand_kv STATUS "$OD_STATUS"
      ondemand_kv VERDICT "$OD_VERDICT"
      ondemand_kv REASON "$OD_REASON"
      ondemand_kv EXIT "$OD_EXIT"
      ondemand_kv RUN_ID "$OD_RUN_ID"
      ondemand_kv TARGET_REF "$OD_REF"
      ondemand_kv TARGET_SHA "$OD_TARGET_SHA"
      ondemand_kv TARGET_VERSION "$OD_TARGET_VERSION"
      ondemand_kv BUILD_S "$OD_BUILD_S"
      ondemand_kv SUITE_SHA "$OD_SUITE_SHA"
      ondemand_kv PROVIDER "$OD_PROVIDER"
      ondemand_kv MODEL "$OD_MODEL"
      ondemand_kv REQUESTED_BY "$OD_BY"
      ondemand_kv CLEANUP "$cleanup"
      ondemand_kv STARTED "$OD_STARTED"
      ondemand_kv FINISHED "$(date -u +%Y%m%dT%H%M%SZ)"
      ondemand_kv LOG "$OD_LOG"
    } > "$tmp" && mv -f "$tmp" "$res"
    echo "result: $res (status=$OD_STATUS${OD_VERDICT:+ verdict=$OD_VERDICT})"
  fi
  find "$OD_LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +30 -delete 2>/dev/null || true
  # build-target-image.sh keeps each build's log beside the source tree it removes; a
  # month of them is the same retention as this lane's own logs.
  find "$OD_STATE/builds" -maxdepth 1 -name 'build-*.log' -type f -mtime +30 -delete 2>/dev/null || true
  echo "=== on-demand end, exit=$OD_EXIT ==="
  exit "$OD_EXIT"
}

# One KEY=VALUE line, the value on one line whatever it held.
ondemand_kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n\r' '  ')"; }

main "$@"
exit $?
