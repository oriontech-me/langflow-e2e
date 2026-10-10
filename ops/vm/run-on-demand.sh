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
#   ONDEMAND_AREAS         optional  area tags, space-separated ("@mcp @api"): the run
#                                    is @stable AND any of them (run-e2e.sh's
#                                    STABLE_AREAS); empty is the whole @stable
#   ONDEMAND_RETRIES       optional  Playwright retries, 0 to 5 (run-e2e.sh's RETRIES);
#                                    empty is the suite's default, as the daily runs
#   ONDEMAND_SUITE_REF     optional  a branch or tag of langflow-e2e to run instead of
#                                    the commit the daily left the clone on; fetched
#                                    from the clone's origin (the mirror), and refused
#                                    when it is not there or is older than SUITE_FLOOR
#
# A suite ref is TRUSTED CODE. Its run-e2e.sh, config and specs run as root on this
# machine, so they reach anything on it: /root/.e2e-secrets (publishing tokens
# included: the run's environment drops them, a file read does not), the worker's
# platform token, the git credentials for the mirror, the daily's clone with this
# executor in it, and the units -- all of which they could change for the next run
# or the next daily. Before it, only the mirror's main ran here as root. Accepted on
# 2026-10-09: the code comes from the GHES mirror, and whoever can push a branch
# there can already change the main the daily runs as root (on GitHub, main has no
# branch protection either); and only an admin can ask for a run.
#
# The provider pre-check is the clone's, not the suite ref's: with no model declared,
# it asks the clone's candidates, so a suite branch that changes CANDIDATE_PREFS is
# checked against the old list (a refusal needs every candidate turned down the same
# way, which a retired model, named in its own error, does not give).
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
#   refused       the request cannot be served as asked: malformed (when it still
#                 names a usable id), the daily's window, areas the suite cannot
#                 narrow to (it predates STABLE_AREAS) or that select no @stable test
#                 -- the latter after the build, a suite ref the mirror does
#                 not have or that is older than SUITE_FLOOR, a declared provider whose
#                 key or model the provider turned down when asked before the build
#                 (scripts/probe-declared-model.mjs), a branch that is not upstream's,
#                 or a declared provider collect-models did not find active -- the
#                 one refusal that comes after the build
#   build_failed  the commit could not be built the nightly's way, or built wrong
#   failed        the machine could not do its part (upstream unreachable, no
#                 tomllib, a build status the script does not use), the run says
#                 nothing about the declared target (it served another version, or
#                 the version could not be checked), the suite never wrote a
#                 results.json, or the run was killed before answering
#   done          the suite ran; VERDICT says green or red, and RUN_ID finds it
#
# and the exit status follows it: 0 done/green, 1 done/red, 2 refused, 3 failed,
# 4 build_failed. REASON carries the words of whoever decided: the build script's
# refusal, or run-e2e.sh's own verdict lines.
#
# An id already answered is refused in the log only, so the first answer stands. A
# start that finds another run holding the lock writes no result and leaves the
# request in place: there is one request slot, and the queue is the platform's. A
# request consumed by a run that was killed before answering it (SIGKILL, OOM, a
# reboot) is answered `failed` by the next start.
#
# ## The daily has priority, always
#
#   - A run does not START on a weekday from 07:30 to 08:40 UTC, and the daily starts
#     at 08:00 and is followed by the shadow. A run takes about 30 minutes (5:40 of
#     build and 24 of suite on the qa, 2026-10-01), so one started after about 07:25
#     will usually be stopped by the daily: the window guards the daily, not the run.
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
#   ports     7910-7913, echo 8100, ollama 11454  (official 7870-7873/8080/11434,
#                                                  shadow   7880-7883/8090/11444)
#             Not 7890-7893: those are the Enterprise scripts' and serving-identity's
#             defaults in this repository, and the machine has an Enterprise image.
#   suite     its own worktree, detached at the commit the clone holds (or the suite
#             ref's, fetched into refs/on-demand/suite), both removed after
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
# image removed, the build cache pruned, the worktree, the ledger copy and the suite
# ref's lane ref removed.
# `docker builder prune -af` is MACHINE-WIDE: it takes any build cache on the qa, not
# only this lane's. No other lane builds today; one that starts to must change this.
# Never `docker system prune`, which would take the other lanes' images. A cleanup that could not confirm the containers gone says so in the result.
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
  local HEAVY_LOCK="${E2E_HEAVY_LOCK:-/run/lock/e2e-heavy.lock}"
  # "<ISO weekday 1-7> <HHMM>", UTC. Tests only: the window is otherwise the clock's.
  local NOW="${E2E_ONDEMAND_NOW:-$(date -u '+%u %H%M')}"
  local said
  # The oldest suite this executor can run: a requested suite ref must contain it.
  # 1ba92b40 (2026-10-02) is where run-e2e.sh passes LANGFLOW_HOSTS_FILE to the
  # containers; before it the SSRF spec fails on every run here (#2181), and the
  # declared target and provider it also relies on are older still (#2111). Tests only
  # override it, as they have no such commit.
  local SUITE_FLOOR="${E2E_ONDEMAND_SUITE_FLOOR:-1ba92b4079d656ddec051c6ef871e8f4e0cbb632}"

  mkdir -p "$LOG_DIR" "$STATE/requests" "$STATE/results"
  local STAMP LOG
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  LOG="$LOG_DIR/$STAMP.log"
  exec >>"$LOG" 2>&1
  echo "=== on-demand start $STAMP ==="

  # Globals, not locals: the EXIT trap runs after main has returned, when a local is out
  # of scope (build-target-image.sh lost its cleanup to exactly that).
  OD_STATE="$STATE"; OD_REPO="$REPO"; OD_LOG="$LOG"
  OD_ID=""; OD_REF=""; OD_PROVIDER=""; OD_MODEL=""; OD_BY=""; OD_SUITE_REF=""; OD_AREAS=""; OD_RETRIES=""
  OD_STATUS=""; OD_REASON=""; OD_EXIT=""; OD_VERDICT=""
  OD_RUN_ID=""; OD_SUITE_SHA=""; OD_WT=""; OD_LEDGER=""
  OD_TARGET_SHA=""; OD_TARGET_VERSION=""; OD_BUILD_S=""; OD_IMAGE=""
  OD_USED_PROVIDER=""; OD_USED_MODEL=""
  OD_STARTED="$STAMP"; OD_HEAVY_LOCK=""; OD_CLEANING=0; OD_TOUCHED=0; OD_PARSE_ERR=""; OD_LOG_DIR="$LOG_DIR"
  # What can publish, unset wherever the secrets file is read: the provider pre-check and
  # the run.
  OD_PUBLISHING=(SOURCE_PUSH_TOKEN GH_TOKEN GITHUB_TOKEN QA_E2E_AUTOMATION_TOKEN SUPABASE_SERVICE_ROLE_KEY SLACK_WEBHOOK_URL GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN)

  # --- one run at a time ------------------------------------------------------------
  # Before the request is read: a second start while one runs must not consume the
  # next request and answer it "busy". systemd already joins a second start of a
  # oneshot to the running job; this covers the script run by hand.
  command -v flock > /dev/null 2>&1 || { echo "FATAL: flock is not on this machine, and without it two runs could share it"; exit 3; }
  exec 9> "$STATE/lock"
  # The request is left where it is, and nothing picks it up by itself: systemd joins a
  # start of a running oneshot to its job, so it is answered by the next start after
  # this run ends. One slot, on purpose -- the queue is the platform's (phase 5).
  flock -n 9 || { echo "REFUSED: another on-demand run holds $STATE/lock — the request is left in place, unanswered; start the unit again once that run ends"; exit 2; }
  # Only now, so a start refused by the lock does not hide the running run's log.
  ln -sfn "$LOG" "$LOG_DIR/latest.log"

  # --- requests a killed run consumed and never answered ----------------------------
  # Under the lock, so none of them belongs to a run still going. Its EXIT trap is what
  # writes a result, and SIGKILL, an OOM kill or a reboot never runs it.
  local orphan oid
  for orphan in "$STATE"/requests/*.env; do
    [ -e "$orphan" ] || continue
    oid="${orphan##*/}"; oid="${oid%.env}"
    case "$oid" in unparsed-*) continue ;; esac
    [ -e "$STATE/results/$oid.env" ] && continue
    {
      ondemand_kv ONDEMAND_ID "$oid"
      ondemand_kv STATUS failed
      ondemand_kv VERDICT ""
      ondemand_kv REASON "interrupted: the run that took this request was killed before it could answer (SIGKILL, an OOM kill or a reboot); answered by the next start, which clears what it left"
      ondemand_kv EXIT 3
      ondemand_kv CLEANUP "by the next run"
      ondemand_kv FINISHED "$STAMP"
      ondemand_kv LOG "$LOG"
    } > "$STATE/results/$oid.env.tmp" && mv -f "$STATE/results/$oid.env.tmp" "$STATE/results/$oid.env"
    echo "answered orphaned request $oid: failed (interrupted)"
  done

  # --- the request: judged in the slot, consumed only once it can be answered ------
  # Signals are caught from here on. Under bash's default action a SIGTERM -- the
  # daily's `systemctl stop` -- ends the script with no trap at all, and a request
  # already moved out of the slot was left with no answer (#2127 review). So the
  # request is parsed WHERE IT IS, and the EXIT trap that answers it is armed before it
  # moves: an exit before the move leaves it in the slot for the next start, and every
  # exit after it writes the result.
  trap 'exit 143' TERM
  trap 'exit 130' INT
  local REQ="$STATE/request.env"
  [ -r "$REQ" ] || { echo "REFUSED: no request at $REQ"; exit 2; }
  local raw parsed=1
  raw="$(cat "$REQ")" || { echo "FATAL: cannot read $REQ"; exit 3; }
  ondemand_parse_request "$raw" || parsed=0
  if [ "$parsed" = "0" ]; then
    # Whoever asked polls results/<id>.env, so a malformed request that still names a
    # usable id, once, is answered there. One that names none has no result to poll.
    OD_ID="$(printf '%s\n' "$raw" | tr -d '\r' | grep -E '^ONDEMAND_ID=' | sed 's/^ONDEMAND_ID=//')"
    [[ "$OD_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || OD_ID=""
  fi
  # Requests with no result to write are consumed into a copy of their own, kept for
  # whoever asks why -- with the PID in the name: two refusals in the same second
  # shared the stamp on the qa (2026-10-01), and the second copy replaced the first.
  local KEPT="$STATE/requests/unparsed-$STAMP-$$.env"
  if [ -n "$OD_ID" ] && [ -e "$STATE/results/$OD_ID.env" ]; then
    # Refused in the log only, so the first answer stands.
    mv -f "$REQ" "$KEPT"
    local answered="$OD_ID"; OD_ID=""
    ondemand_refuse "request $answered was already answered — an id names one run" "$KEPT"
  fi
  if [ -z "$OD_ID" ]; then
    mv -f "$REQ" "$KEPT"
    ondemand_refuse "the request is malformed: $OD_PARSE_ERR" "$KEPT"
  fi
  trap ondemand_finish EXIT
  mv -f "$REQ" "$STATE/requests/$OD_ID.env"
  [ "$parsed" = "1" ] || ondemand_refuse "the request is malformed: $OD_PARSE_ERR" "$STATE/requests/$OD_ID.env"
  echo "request: id=$OD_ID ref=$OD_REF provider=${OD_PROVIDER:-<rotation>} model=${OD_MODEL:-<default>} suite=${OD_SUITE_REF:-<the daily commit>} areas=${OD_AREAS:-<all of @stable>} retries=${OD_RETRIES:-<default>} by=${OD_BY:-<unnamed>}"

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
  # Only today's: the shadow itself refuses a request from another day, so one left
  # behind by a start that failed would otherwise block this lane until the next daily.
  if [ -r "$SHADOW_STATE/request.env" ] \
     && grep -qx "SHADOW_DATE=$(date -u +%Y-%m-%d)" "$SHADOW_STATE/request.env"; then
    ondemand_refuse "a shadow request for today is waiting at $SHADOW_STATE/request.env — the shadow is about to start"
  fi

  # --- one heavy lane at a time -------------------------------------------------------
  # Shared with the scheduled routines (ops/vm/lib/routine.sh): a lane that starts
  # Langflow or a browser takes it, so two of them never share the machine (stage 3,
  # 2026-10-05). A routine waits for it; this lane refuses at once, because whoever asked
  # can ask again, and a request waiting here would hold the platform's one slot. Held on
  # fd 8 until exit; every child that can outlive the run gets 8>&- with 9>&-.
  command -v flock > /dev/null 2>&1 || ondemand_fail 3 failed "flock is not on this machine"
  mkdir -p "$(dirname "$HEAVY_LOCK")" 2>/dev/null
  exec 8>> "$HEAVY_LOCK" || ondemand_fail 3 failed "cannot open the heavy-lane lock $HEAVY_LOCK"
  if ! flock -n 8; then
    local holder
    holder="$(cat "$HEAVY_LOCK.holder" 2>/dev/null || true)"
    ondemand_refuse "the machine is busy: ${holder:-another heavy lane} holds $HEAVY_LOCK — ask again once it ends"
  fi
  printf 'on-demand %s (pid %s) since %s\n' "$OD_ID" "$$" "$STAMP" > "$HEAVY_LOCK.holder" 2>/dev/null || true
  OD_HEAVY_LOCK="$HEAVY_LOCK"

  # --- leftovers of a run that was killed rather than finished ----------------------
  # Past every refusal: a request refused while the daily runs must not touch docker.
  # Under the lock, so nothing here belongs to a run still going. A run SIGKILLed past
  # TimeoutStopSec leaves what its traps never removed: the build's source tree
  # (build-target-image.sh's own trap did not run either) and its ledger copy.
  OD_TOUCHED=1
  ondemand_clear_images
  rm -rf "$STATE"/builds/src-* "$STATE"/ledger-*

  # --- the suite: the clone's commit, or the ref asked for, in a worktree of its own --
  # By default, the commit the daily left the clone on: on a green day the suite it
  # ran, on a red day that suite minus the @stable it removed, which is the suite the
  # next daily runs. Either way SUITE_SHA in the result names it, and a comparison with
  # a daily has to match on it rather than assume. Not pulled: the clone and its pull
  # are the daily's.
  #
  # A requested suite ref is fetched from the clone's origin, the mirror, into a ref of
  # this lane's own -- never into the clone's branches, HEAD or working tree -- and must
  # contain SUITE_FLOOR. Only the suite comes from it: the build and the provider
  # pre-check are the machine's part and run from the clone, as the executor does.
  if [ -n "$OD_SUITE_REF" ]; then
    local fetch_err="$STATE/suite-fetch.$$" fetched=0 anc=0
    # Never FETCH_HEAD, which the daily's `git pull` reads, and never the clone's
    # refs/remotes (--refmap= turns off git's opportunistic update of them). Five minutes
    # at most, whatever the transport: a stalled fetch would otherwise hold the slot
    # and the heavy lock until the unit's TimeoutStartSec, 90 minutes.
    # A name that is both a branch and a tag fetches the tag (git's own order:
    # refs/<name>, refs/tags/<name>, refs/heads/<name>); refs/heads/<name> says which.
    timeout 300 git -C "$REPO" fetch --no-tags --no-write-fetch-head --refmap= -q origin \
      "+$OD_SUITE_REF:refs/on-demand/suite" 9>&- 8>&- 2> "$fetch_err" && fetched=1
    said="$(tr '\n' ' ' < "$fetch_err" 2>/dev/null | cut -c1-300)"
    rm -f "$fetch_err"
    if [ "$fetched" = "0" ]; then
      case "$said" in
        *"find remote ref"* | *"invalid refspec"* | *"not a valid ref"* | *"not our ref"*)
          ondemand_refuse "the suite ref '$OD_SUITE_REF' is not on the langflow-e2e mirror the qa fetches from; the mirror syncs from GitHub hourly, so a branch or tag pushed in the last hour may not be there yet" ;;
        *) ondemand_fail 3 failed "could not fetch the suite ref '$OD_SUITE_REF' from the mirror, the machine or the network, not the ref: ${said:-no reason given}" ;;
      esac
    fi
    OD_SUITE_SHA="$(git -C "$REPO" rev-parse --verify -q 'refs/on-demand/suite^{commit}' 2>/dev/null)" || OD_SUITE_SHA=""
    [[ "$OD_SUITE_SHA" =~ ^[0-9a-f]{40}$ ]] || ondemand_refuse "the suite ref '$OD_SUITE_REF' names no commit (a tag of a tree or a blob)"
    git -C "$REPO" merge-base --is-ancestor "$SUITE_FLOOR" "$OD_SUITE_SHA" 2>/dev/null || anc=$?
    case "$anc" in
      0) ;;
      1) ondemand_refuse "the suite at '$OD_SUITE_REF' (${OD_SUITE_SHA:0:12}) is older than this executor can run: it must contain ${SUITE_FLOOR:0:12} (2026-10-02, localhost on both loopbacks in the run containers); base it on a newer main" ;;
      *) ondemand_fail 3 failed "could not tell whether the suite at '$OD_SUITE_REF' contains ${SUITE_FLOOR:0:12} (git merge-base exited $anc)" ;;
    esac
  else
    OD_SUITE_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || OD_SUITE_SHA=""
    [[ "$OD_SUITE_SHA" =~ ^[0-9a-f]{40}$ ]] || ondemand_fail 3 failed "the clone at $REPO has no commit to run"
  fi
  OD_WT="$STATE/wt"
  git -C "$REPO" worktree prune
  if [ -e "$OD_WT" ]; then
    git -C "$REPO" worktree remove --force "$OD_WT" 2>/dev/null || rm -rf "$OD_WT"
    git -C "$REPO" worktree prune
  fi
  git -C "$REPO" worktree add -q --detach "$OD_WT" "$OD_SUITE_SHA" || ondemand_fail 3 failed "could not create the worktree at $OD_WT"
  echo "suite at: $(git -C "$OD_WT" log --oneline -1)"
  # A suite from before STABLE_AREAS would ignore it and run the whole @stable, green
  # over what nobody asked for. Refused instead, before the build.
  if [ -n "$OD_AREAS" ] && ! grep -q 'STABLE_AREAS' "$OD_WT/scripts/run-e2e.sh" 2>/dev/null; then
    ondemand_refuse "the suite at ${OD_SUITE_SHA:0:12} cannot narrow @stable to areas (its run-e2e.sh predates STABLE_AREAS); ask without areas, or for a newer suite"
  fi
  # The provider keys that decide which spec files enter the suite are read from the
  # working copy's .env (#1764): linked, as the shadow does, so all lanes read one file.
  [ -f "$REPO/.env" ] && ln -sfn "$REPO/.env" "$OD_WT/.env"

  # --- a declared provider, asked before the build ------------------------------------
  # One minimal completion, with the key the run would use: a dry key or a
  # model the account cannot reach is refused now, in seconds, instead of after the
  # build, with the queue's one slot held. Only a certain answer refuses; anything else
  # (the network, a 5xx, a clone from before the probe) lets the run go on, and
  # collect-models decides after the build as before. The keys stay in the subshell.
  if [ -n "$OD_PROVIDER" ] && [ -r "$SECRETS" ]; then
    local probe_out probe_rc=0 probe_reason
    # The locks closed INSIDE the substitution: on the assignment they would not reach it.
    # Sourced as the run sources it, with no `set -a`: a line with no `export` reaches
    # neither, and the probe, like playwright's dotenv, then reads the worktree's .env.
    probe_out="$(
      exec 9>&- 8>&-
      # shellcheck disable=SC1090
      . "$SECRETS"
      unset "${OD_PUBLISHING[@]}"
      cd "$OD_WT" && node "$REPO/scripts/probe-declared-model.mjs" --provider "$OD_PROVIDER" ${OD_MODEL:+--model "$OD_MODEL"}
    )" || probe_rc=$?
    echo "provider pre-check (exit $probe_rc): ${probe_out:-no answer}"
    if [ "$probe_rc" = "2" ]; then
      # The last line: anything the secrets file printed comes before the probe's JSON.
      probe_reason="$(node -p "try{JSON.parse(process.argv[1]).reason||''}catch{''}" "$(printf '%s\n' "$probe_out" | tail -n 1)" 2>/dev/null || true)"
      ondemand_refuse "the declared provider cannot be used, checked before the build: ${probe_reason:-the pre-check said no without a reason}"
    fi
  fi

  # --- the image of the branch's commit ---------------------------------------------
  local built rc=0 build_err="$STATE/build-stderr.$$"
  # 9>&- on everything that can leave a process behind: a daemon that inherited the
  # lock's descriptor would hold the lock after this run, and refuse every next one.
  #
  # Its stderr is kept apart and then copied to the log: the script's own reason is its
  # last `build-target-image:` line, and the RESULT has to carry it. "See the line above"
  # pointed at a line only the log had (qa, 2026-10-01), and the result is what the
  # platform will show.
  # From the clone, not the suite's worktree: a requested suite ref chooses the tests,
  # never how the machine builds the target.
  built="$(BUILD_ROOT="$STATE/builds" "$REPO/ops/vm/build-target-image.sh" "$OD_REF" 9>&- 8>&- 2> "$build_err")" || rc=$?
  cat "$build_err" 2>/dev/null
  said="$(grep '^build-target-image: ' "$build_err" 2>/dev/null | tail -n 1)"
  said="${said#build-target-image: }"
  rm -f "$build_err"
  case "$rc" in
    0) ;;
    2) ondemand_refuse "build refused (status 2): ${said:-no reason given}" ;;
    3 | 7) ondemand_fail 3 failed "build could not do its part (status $rc), the machine or the network, not the branch: ${said:-no reason given}" ;;
    4 | 5 | 6) ondemand_fail 4 build_failed "build failed (status $rc), not a test result: ${said:-no reason given}" ;;
    # 1, 126, 127, a signal: statuses the script does not use, so the script itself
    # broke or is missing from the suite commit -- never the branch's doing.
    *) ondemand_fail 3 failed "build-target-image.sh ended with status $rc, which it does not use: the machine or the suite, not the branch${said:+: $said}" ;;
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
  unset "${OD_PUBLISHING[@]}"
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
  export STABLE_AREAS="$OD_AREAS"
  export RETRIES="$OD_RETRIES"
  export BASE_PORT=7910 SHARDS=4 ECHO_PORT=8100 OLLAMA_PORT=11454
  export WORKFLOW_ID=on-demand-stable
  export LEDGER_DIR="$OD_LEDGER"
  export RUNS_ROOT="$STATE/runs"
  export CREATE_ISSUE=0 AUTO_REMOVE=0 HISTORY_TO_SOURCE=0 NOTIFY_SLACK=0 NOTIFY_SLACK_ALWAYS=0 POST_QA_PLATFORM=0
  export CHECK_MIRROR=0
  unset LANGFLOW_SRC_RUN_CMD LANGFLOW_SRC_FRONTEND_DIR TARGET_VENV PREPARE_TARGET
  mkdir -p "$RUNS_ROOT"

  # localhost resolves to both loopbacks in the containers, as the shadow's do (#2159).
  # The QA VM boots with ipv6.disable=1, so docker writes 127.0.0.1 alone, and the SSRF
  # spec that requires the refusal to name `::1` failed on every on-demand run, with
  # the tests serial after it skipped (#2181). Under $STATE, because a snap docker
  # cannot read /tmp.
  printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$STATE/hosts"
  export LANGFLOW_HOSTS_FILE="$STATE/hosts"

  echo "=== run start $OD_RUN_ID ==="
  ( cd "$OD_WT" && ./scripts/run-e2e.sh ) 9>&- 8>&-
  rc=$?
  echo "=== run end, exit=$rc ==="
  # run-e2e.sh exits 1 for a red day, for a provider it refused, for a target that
  # served another version and for a run that died in preflight alike. What tells them
  # apart is what it left and what its verdict said, so the result says that, in its
  # words: "red" alone read as product failures for a run that measured nothing.
  #
  # OD_STATUS is set LAST, in every branch here and in ondemand_refuse/ondemand_fail:
  # ondemand_finish classifies only an exit with no STATUS, so a SIGTERM between a
  # STATUS and its EXIT left a result the platform refuses (EXIT is required).
  local verdict_errs last_err model_refused
  ondemand_read_model_used "$RUNS_ROOT/$OD_RUN_ID/model-used"
  verdict_errs="$(ondemand_run_errors verdict)"
  last_err="$(ondemand_run_errors last)"
  model_refused="$(cat "$RUNS_ROOT/$OD_RUN_ID"/logs/shard-*.model-refused 2>/dev/null | head -n 1)"
  if [ -n "$OD_AREAS" ] && printf '%s\n' "$last_err" | grep -q 'select no @stable test'; then
    # The request's fault, as a declared provider nobody can use is: nothing ran.
    OD_EXIT=2
    OD_REASON="the areas asked for select no test in this suite: $last_err"
    OD_STATUS=refused
  elif [ -n "$model_refused" ]; then
    OD_EXIT=2
    OD_REASON="the declared provider could not be used, so the agent specs did not run: $model_refused"
    OD_STATUS=refused
  elif printf '%s\n' "$verdict_errs" | grep -qE 'served the wrong Langflow|version check (could not|had no)'; then
    OD_EXIT=3
    OD_REASON="the run says nothing about $OD_REF @ ${OD_TARGET_SHA:0:12}: $verdict_errs"
    OD_STATUS=failed
  elif [ -f "$RUNS_ROOT/$OD_RUN_ID/results.json" ]; then
    if [ "$rc" = "0" ]; then
      OD_VERDICT=green; OD_EXIT=0; OD_REASON="the suite ran green"
    else
      OD_VERDICT=red; OD_EXIT=1; OD_REASON="the suite ran red: ${verdict_errs:-run-e2e.sh exit $rc, no verdict line}"
    fi
    OD_STATUS=done
  else
    OD_EXIT=3
    OD_REASON="run-e2e.sh exited $rc without a results.json, so the suite reached no verdict: ${verdict_errs:-${last_err:-no reason given; see $OD_LOG}}"
    OD_STATUS=failed
  fi
  exit "$OD_EXIT"
}

# Parses the request into the OD_* globals. On a malformed one, sets OD_PARSE_ERR and
# fails. Not called in $( ): the globals it sets would be lost with the subshell.
# Never sources, never evaluates: each line is split at its first '=' and the key must
# be one of eight.
ondemand_parse_request() {
  local raw="$1" line key value seen=" "
  OD_ID=""; OD_REF=""; OD_PROVIDER=""; OD_MODEL=""; OD_BY=""; OD_SUITE_REF=""; OD_AREAS=""; OD_RETRIES=""
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
      ONDEMAND_SUITE_REF)
        # A git ref name, or '' for the daily's: the shape of ONDEMAND_REF, minus what
        # git refuses or a fetch would read as something else.
        [[ "$value" =~ ^[A-Za-z0-9._/-]{0,200}$ ]] && [[ "$value" != -* ]] && [[ "$value" != *..* ]] \
          && [[ "$value" != */ ]] && [[ "$value" != /* ]] && [[ "$value" != *//* ]] \
          && [[ "$value" != .* ]] && [[ "$value" != */.* ]] && [[ "$value" != *. ]] && [[ "$value" != *./* ]] \
          && [[ "$value" != *.lock ]] && [[ "$value" != *.lock/* ]] \
          || { OD_PARSE_ERR="ONDEMAND_SUITE_REF is not a branch or tag name: '${value:0:80}'"; return 1; }
        OD_SUITE_REF="$value" ;;
      ONDEMAND_AREAS)
        # Tags, one space between: the shape run-e2e.sh's STABLE_AREAS checks, minus
        # @stable (the base) and the lane tags (an environment of their own).
        [[ "$value" =~ ^(@[a-z0-9][a-z0-9-]{0,39}( @[a-z0-9][a-z0-9-]{0,39}){0,24})?$ ]] \
          || { OD_PARSE_ERR="ONDEMAND_AREAS is not tags separated by one space: '${value:0:80}'"; return 1; }
        case " $value " in
          *" @stable "* | *" @destructive "* | *" @enterprise "* | *" @serving "*)
            OD_PARSE_ERR="ONDEMAND_AREAS names @stable or a lane tag, which are not areas: '${value:0:80}'"; return 1 ;;
        esac
        OD_AREAS="$value" ;;
      ONDEMAND_RETRIES)
        [[ "$value" =~ ^[0-5]?$ ]] || { OD_PARSE_ERR="ONDEMAND_RETRIES is not 0 to 5: '${value:0:80}'"; return 1; }
        OD_RETRIES="$value" ;;
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

# The provider and model the run's agent specs used, from the run's model-used line
# ("<provider>\t<model>", written by run-e2e.sh's phase_merge; "all" and "mixed" are
# its words for more than one). PROVIDER and MODEL in the result are "what was
# actually used" in the queue contract, and a run on the day's rotation used to echo
# the request's '' instead (#2226). Absent, or not in the request's own shapes, the
# result keeps what was requested: a value the platform refuses would cost the whole
# result, not just this field.
ondemand_read_model_used() {
  local file="$1" line provider model
  [ -f "$file" ] || return 0
  line="$(head -n 1 "$file" 2>/dev/null || true)"
  [[ "$line" == *$'\t'* ]] || return 0
  provider="${line%%$'\t'*}"; model="${line#*$'\t'}"
  [[ "$provider" =~ ^[a-z0-9-]{1,40}$ ]] || return 0
  [[ "$model" =~ ^[A-Za-z0-9._:/-]{0,120}$ ]] || return 0
  OD_USED_PROVIDER="$provider"; OD_USED_MODEL="$model"
  return 0
}

# run-e2e.sh's own ::error:: lines from this run, from this lane's log, ANSI removed.
# `verdict`: every one its verdict printed, joined; `last`: the last one anywhere in
# the run, for a run that died before its verdict. At most 600 characters either way.
ondemand_run_errors() {
  local section
  section="$(awk -v m="=== run start $OD_RUN_ID ===" 'f; $0 == m { f = 1 }' "$OD_LOG" 2>/dev/null \
    | sed $'s/\033\\[[0-9;]*m//g')"
  if [ "$1" = verdict ]; then
    section="$(printf '%s\n' "$section" | awk '/^==> Verdict$/ { f = 1; next } f')"
    printf '%s\n' "$section" | sed -n 's/^::error:: //p' | tr '\n' ' ' | sed 's/  */ /g; s/ $//' | cut -c1-600
  else
    printf '%s\n' "$section" | sed -n 's/^::error:: //p' | tail -n 1 | cut -c1-600
  fi
}

# A refusal: nothing ran, or nothing more will. Before the request has an id there is
# no result to write, so the refusal is the log line alone.
ondemand_refuse() {
  echo "REFUSED: $1"
  [ -n "${2:-}" ] && echo "         the request is kept at $2"
  OD_EXIT=2; OD_REASON="$1"; OD_STATUS=refused
  exit 2
}

ondemand_fail() {
  echo "FAILED ($2): $3"
  OD_EXIT="$1"; OD_REASON="$3"; OD_STATUS="$2"
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
    # An exit nobody classified: a signal (the daily stopping this run), or a bug. A
    # VERDICT set just before the signal goes too: VERDICT belongs to done alone.
    OD_STATUS=failed; OD_EXIT=3; OD_VERDICT=""
    case "$code" in
      143) OD_REASON="stopped by SIGTERM — the daily starting, systemctl stop, or the unit's TimeoutStartSec" ;;
      130) OD_REASON="interrupted" ;;
      *) OD_REASON="ended with status $code before a verdict" ;;
    esac
  fi

  local cleanup=ok
  # Written first with the cleanup pending, and again after it: a cleanup cut short by
  # systemd's SIGKILL at TimeoutStopSec must not leave the request without an answer.
  [ "$OD_TOUCHED" = "1" ] && ondemand_write_result pending
  if [ "$OD_TOUCHED" = "1" ]; then
  echo "--- cleanup ---"
  local port left
  for port in 7910 7911 7912 7913; do
    docker rm -f "langflow-e2e-lane-$port" > /dev/null 2>&1 || true
  done
  local names
  if ! names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"; then
    cleanup=unconfirmed
    echo "ERROR: docker ps failed — the backend containers could not be checked gone"
  fi
  left="$(printf '%s\n' "$names" | grep -E '^langflow-e2e-lane-791[0-3]$' || true)"
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
  git -C "$OD_REPO" update-ref -d refs/on-demand/suite 2>/dev/null || true
  echo "cleanup: $cleanup"
  fi

  ondemand_write_result "$cleanup"
  # Only this run's line: a run refused by the lock must not erase the holder's.
  [ -n "$OD_HEAVY_LOCK" ] && grep -q "^on-demand $OD_ID (pid $$) " "$OD_HEAVY_LOCK.holder" 2>/dev/null && rm -f "$OD_HEAVY_LOCK.holder"
  find "$OD_LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +30 -delete 2>/dev/null || true
  # build-target-image.sh keeps each build's log beside the source tree it removes; a
  # month of them is the same retention as this lane's own logs.
  find "$OD_STATE/builds" -maxdepth 1 -name 'build-*.log' -type f -mtime +30 -delete 2>/dev/null || true
  echo "=== on-demand end, exit=$OD_EXIT ==="
  exit "$OD_EXIT"
}

# results/<id>.env, written whole and then renamed, so a reader never sees half of it.
# Its one argument is the cleanup's state: pending, ok, incomplete or unconfirmed.
ondemand_write_result() {
  [ -n "$OD_ID" ] || return 0
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
    # What was used when the run said (#2226), else what was requested.
    if [ -n "$OD_USED_PROVIDER" ]; then
      ondemand_kv PROVIDER "$OD_USED_PROVIDER"
      ondemand_kv MODEL "$OD_USED_MODEL"
    else
      ondemand_kv PROVIDER "$OD_PROVIDER"
      ondemand_kv MODEL "$OD_MODEL"
    fi
    ondemand_kv REQUESTED_BY "$OD_BY"
    ondemand_kv CLEANUP "$1"
    ondemand_kv STARTED "$OD_STARTED"
    ondemand_kv FINISHED "$(date -u +%Y%m%dT%H%M%SZ)"
    ondemand_kv LOG "$OD_LOG"
  } > "$tmp" && mv -f "$tmp" "$res"
  echo "result: $res (status=$OD_STATUS${OD_VERDICT:+ verdict=$OD_VERDICT}, cleanup=$1)"
}

# One KEY=VALUE line, the value on one line whatever it held.
ondemand_kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n\r' '  ')"; }

main "$@"
exit $?
