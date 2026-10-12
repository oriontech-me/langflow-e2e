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
# Or against ONE PUBLISHED VERSION (langflow==<version> from PyPI: a release, an rc or a
# nightly .devN), installed the way the daily installs its own: scripts/prepare-target-
# dist.sh into a venv of this lane's, served from it, and declared to run-e2e.sh by its
# version alone (#2261). No image is built. Unlike the daily's, which is always the
# newest, the version may be any release: PyPI is asked first (scripts/lib/pypi-
# release.mjs) for its own spelling, a file to install and the newest interpreter its
# requires_python allows, and langflow-base and lfx are pinned to the version too where
# PyPI has them, because a release asks for langflow-base as a range, under uv's
# if-necessary-or-explicit pre-release mode, named so no uv setting changes it. From
# 1.12 on only. The team's usual question is "is the rc that was just published
# good?", and a branch build is not the artefact users install.
#
# Or against ONE PUBLISHED IMAGE of a version (langflowai/langflow:<version>, #2270): the
# artefact users deploy in containers, with its own packaging and defaults. Asked of
# Docker Hub, pulled, and run by its digest in the image mode the shadow uses; removed
# after, unless it was on the machine before the run.
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
#   ONDEMAND_REF           a branch of upstream (build-target-image.sh decides whether
#                          it is one; a fork never is)
#   ONDEMAND_VERSION       a published version, in PEP 440's normal form (1.13.1rc0,
#                          1.13.0.dev12, 1.12.4): exactly one of REF and VERSION
#   ONDEMAND_VERSION_FROM  where the version comes from: pypi (installed into a venv),
#                          or docker (the published image, langflowai/langflow:<version>,
#                          pulled and run by its digest, #2270); '' means pypi; set only
#                          with VERSION
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
#                 a version PyPI does not have, spells otherwise, has with no file or
#                 only yanked ones, or that is older than 1.12, or that allows no
#                 Python the machine runs (3.12-3.14), an image tag Docker Hub does
#                 not have, a suite too old to declare a published version or image,
#                 or a declared provider collect-models did not find active -- the
#                 one refusal that comes after the build
#   build_failed  the commit could not be built the nightly's way, or built wrong; or
#                 the published version installed but is not servable (its langflow-
#                 base or lfx is another version, or it carries no built frontend)
#   failed        the machine could not do its part (upstream unreachable, no
#                 tomllib, a build step past its time limit, a build status the
#                 script does not use, a version that could not be installed or an
#                 image pulled, PyPI or Docker Hub not answering about it), the
#                 run says nothing about the declared
#                 target (it served another version, or the version could not be
#                 checked), the suite never wrote a results.json, the suite ran past
#                 the run's deadline, or the run was killed before answering
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
#   venv      $STATE/venv, for a version: recreated by each install, removed after
#   pulled    the published image, by tag, removed after unless it was already here
#             ($STATE/pulled-image names one to remove, for the next start too)
#   ledger    a fresh COPY of the official ledger per run, removed after: the triage
#             summary reads recurrence against the daily's history, and the official
#             file never receives a line from a run that is not the daily
#   runs      $STATE/runs
#   logs      /var/log/e2e-on-demand
#
# ## Cleanup is not optional
#
# On every exit, including a stop by the daily: the four backend containers removed and
# checked gone, a version's Langflow processes stopped and its venv removed, echo and
# ollama stopped on this lane's ports, every langflow-ondemand
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
  # The least time a suite is started with (see the deadline below). Tests only: they
  # cannot wait five minutes for a deadline to pass.
  local MIN_SUITE_S="${E2E_ONDEMAND_MIN_SUITE_S:-300}"
  # The run's own deadline, in seconds from this start: the suite is stopped when it
  # would pass it, and the result says so. From this start, not the claim: a start the
  # worker had to retry has used some of the platform's hold already. Three ceilings,
  # each under the next:
  #   this deadline        80 min, then up to 2 for the suite to stop (timeout -k),
  #                        leaving about 8 for the verdict and the cleanup
  #   TimeoutStartSec      90 min (e2e-on-demand.service), whose SIGTERM says only
  #                        "stopped", as the daily's stop and a hand's do
  #   MAX_HOLD_SECONDS     2 h, after which the platform releases the request as
  #                        abandoned while the run would still be going
  # So neither of the first two grows with retries: measured on the qa (2026-10-05 to
  # 10-10), a whole run takes 26-33 min at the suite's default of 2, which is the most
  # the platform asks for; 3 to 5, asked by hand, may reach it on a very red branch.
  local DEADLINE_S="${E2E_ONDEMAND_DEADLINE_S:-4800}"
  # A version's install, which stands where the build would: the venv is recreated and
  # resolved from scratch each time, so this is a download and a resolve, not a build.
  # Half the build's limit (BUILD_TIMEOUT_S, 30 min), and the same -k.
  local INSTALL_TIMEOUT_S="${E2E_ONDEMAND_INSTALL_TIMEOUT_S:-900}"
  # PyPI's JSON API, under which <project>/<version>/json says whether it has a release.
  # Tests only point it elsewhere.
  local PYPI_JSON="${E2E_ONDEMAND_PYPI_JSON:-https://pypi.org/pypi}"
  # A published image's pull: about 0.8 GB, so minutes on a slow link; less than the
  # build's 30 and the install's 15 because nothing is resolved or built.
  local PULL_TIMEOUT_S="${E2E_ONDEMAND_PULL_TIMEOUT_S:-600}"
  # Docker Hub's API, under which <repo>/tags/<tag> says whether a tag exists.
  local DOCKER_HUB="${E2E_ONDEMAND_DOCKER_HUB:-https://hub.docker.com/v2/repositories}"

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
  OD_VERSION=""; OD_VERSION_FROM=""; OD_VENV=""; OD_FRONTEND=""; OD_NAMED=""; OD_PULLED=""
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
  echo "request: id=$OD_ID $(ondemand_target) provider=${OD_PROVIDER:-<rotation>} model=${OD_MODEL:-<default>} suite=${OD_SUITE_REF:-<the daily commit>} areas=${OD_AREAS:-<all of @stable>} retries=${OD_RETRIES:-<default>} by=${OD_BY:-<unnamed>}"

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
  ondemand_clear_pulled
  ondemand_stop_versions || echo "WARNING: a Langflow a killed run left on this lane's ports could not be stopped; the run will find its port taken"
  rm -rf "$STATE"/builds/src-* "$STATE"/ledger-* "$STATE/venv"

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
  # A suite from before #2261 refuses a declared published distribution in preflight,
  # after the install, as a failure of the machine. Refused instead, before it.
  if [ -n "$OD_VERSION" ] && ! grep -q 'target_is_declared' "$OD_WT/scripts/run-e2e.sh" 2>/dev/null; then
    ondemand_refuse "the suite at ${OD_SUITE_SHA:0:12} cannot run against a published version (its run-e2e.sh predates declaring one); ask with the daily's suite, or a newer one"
  fi
  # And one from before #2270 refuses a published image declared without a commit.
  if [ "$OD_VERSION_FROM" = docker ] && ! grep -q 'declared_form' "$OD_WT/scripts/run-e2e.sh" 2>/dev/null; then
    ondemand_refuse "the suite at ${OD_SUITE_SHA:0:12} cannot run against a published image (its run-e2e.sh predates declaring one by its digest); ask with the daily's suite, or a newer one"
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

  # --- the target: the image of the branch's commit, or the published version -------
  local rc=0
  if [ "$OD_VERSION_FROM" = docker ]; then
    ondemand_pull "$PULL_TIMEOUT_S" "$DOCKER_HUB"
  elif [ -n "$OD_VERSION" ]; then
    ondemand_install "$INSTALL_TIMEOUT_S" "$PYPI_JSON"
  else
    local built build_err="$STATE/build-stderr.$$"
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
  fi

  # The target as a reason names it, set once here: an outcome's assignments stay plain
  # expansions, with no subshell between a STATUS and its EXIT.
  OD_NAMED="$(ondemand_target_named)"

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
  export DECLARED_MODEL_PROVIDER="$OD_PROVIDER" DECLARED_MODEL_ID="$OD_MODEL"
  export STABLE_AREAS="$OD_AREAS"
  export RETRIES="$OD_RETRIES"
  export BASE_PORT=7910 SHARDS=4 ECHO_PORT=8100 OLLAMA_PORT=11454
  export WORKFLOW_ID=on-demand-stable
  export LEDGER_DIR="$OD_LEDGER"
  export RUNS_ROOT="$STATE/runs"
  export CREATE_ISSUE=0 AUTO_REMOVE=0 HISTORY_TO_SOURCE=0 NOTIFY_SLACK=0 NOTIFY_SLACK_ALWAYS=0 POST_QA_PLATFORM=0
  export CHECK_MIRROR=0
  mkdir -p "$RUNS_ROOT"
  if [ "$OD_VERSION_FROM" = pypi ]; then
    # The daily's way of serving a published distribution (run-daily.sh), declared by
    # its version so the gate compares with it and not with today's nightly.
    export TARGET_KIND=source PREPARE_TARGET=0
    export LANGFLOW_SRC_RUN_CMD="$OD_VENV/bin/langflow run" LANGFLOW_SRC_FRONTEND_DIR="$OD_FRONTEND" TARGET_VENV="$OD_VENV"
    export TARGET_DECLARED_SHA="" TARGET_DECLARED_REF="" TARGET_DECLARED_VERSION="$OD_TARGET_VERSION"
    unset LANGFLOW_IMAGE LANGFLOW_HOSTS_FILE
  else
    # The branch's image, declared by its commit; or a published image, by its version
    # alone and named by its digest (both SHA and ref are '' for it).
    export TARGET_KIND=image
    export LANGFLOW_IMAGE="$OD_IMAGE"
    export TARGET_DECLARED_SHA="$OD_TARGET_SHA" TARGET_DECLARED_VERSION="$OD_TARGET_VERSION" TARGET_DECLARED_REF="$OD_REF"
    unset LANGFLOW_SRC_RUN_CMD LANGFLOW_SRC_FRONTEND_DIR TARGET_VENV PREPARE_TARGET
    # localhost resolves to both loopbacks in the containers, as the shadow's do (#2159).
    # The QA VM boots with ipv6.disable=1, so docker writes 127.0.0.1 alone, and the SSRF
    # spec that requires the refusal to name `::1` failed on every on-demand run, with
    # the tests serial after it skipped (#2181). Under $STATE, because a snap docker
    # cannot read /tmp. A PyPI version serves on the host, as the daily's does, and reads
    # the host's /etc/hosts.
    printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$STATE/hosts"
    export LANGFLOW_HOSTS_FILE="$STATE/hosts"
  fi

  # What is left of the deadline goes to the suite. Less than five minutes cannot hold
  # one, so the run is not started to be stopped.
  [[ "$DEADLINE_S" =~ ^[1-9][0-9]*$ ]] || ondemand_fail 3 failed "E2E_ONDEMAND_DEADLINE_S='$DEADLINE_S' is not a number of seconds"
  local suite_s=$((DEADLINE_S - SECONDS))
  [ "$suite_s" -ge "$MIN_SUITE_S" ] \
    || ondemand_fail 3 failed "the steps before the suite took ${SECONDS}s of the run's ${DEADLINE_S}s deadline, which leaves no time for a suite: the machine or the network, not the target"
  echo "suite time: ${suite_s}s, what is left of the run's ${DEADLINE_S}s deadline"
  # A marker, parsed as is: by ondemand_run_errors here and by the worker's readProgress.
  echo "=== run start $OD_RUN_ID ==="
  # -k: run-e2e.sh's EXIT cleanup runs on the TERM, and a wedged docker can hang it;
  # two minutes later it is killed, still inside the unit's cap. timeout then answers
  # 137, not 124, as a suite killed for another reason (the OOM killer) also would, so
  # 137 counts as the deadline only once the suite's time has passed.
  local suite_start=$SECONDS
  ( cd "$OD_WT" && timeout -k 120 "$suite_s" ./scripts/run-e2e.sh ) 9>&- 8>&-
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
  if [ "$rc" = "124" ] || { [ "$rc" = "137" ] && [ $((SECONDS - suite_start)) -ge "$suite_s" ]; }; then
    # timeout's own status: the suite was stopped, so whatever it left is partial.
    OD_EXIT=3
    OD_REASON="the suite ran past the run's deadline and was stopped after ${suite_s}s ($((DEADLINE_S / 60)) min from the start, retries ${OD_RETRIES:-default}). A run takes about 30 min: a suite this long is hanging, or a very red target with more retries than fit"
    OD_STATUS=failed
  elif [ -n "$OD_AREAS" ] && printf '%s\n' "$last_err" | grep -q 'select no @stable test'; then
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
    OD_REASON="the run says nothing about $OD_NAMED: $verdict_errs"
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
# be one of ten.
ondemand_parse_request() {
  local raw="$1" line key value seen=" "
  OD_ID=""; OD_REF=""; OD_PROVIDER=""; OD_MODEL=""; OD_BY=""; OD_SUITE_REF=""; OD_AREAS=""; OD_RETRIES=""
  OD_VERSION=""; OD_VERSION_FROM=""
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
        # '' when the request names a version instead (the worker writes every key).
        [[ "$value" =~ ^[A-Za-z0-9._/-]{0,200}$ ]] || { OD_PARSE_ERR="ONDEMAND_REF has characters a branch name here cannot: '${value:0:80}'"; return 1; }
        OD_REF="$value" ;;
      ONDEMAND_VERSION)
        # PEP 440's normal form, which is what PyPI lists and what the instance reports,
        # so the run's exact comparison holds: release, then aN/bN/rcN, .postN, .devN.
        # No epoch and no local version: langflow publishes neither.
        { [ -z "$value" ] || { [ "${#value}" -le 64 ] && [[ "$value" =~ ^[0-9]+(\.[0-9]+)*((a|b|rc)[0-9]+)?(\.post[0-9]+)?(\.dev[0-9]+)?$ ]]; }; } \
          || { OD_PARSE_ERR="ONDEMAND_VERSION is not a version in PEP 440's normal form (1.13.1rc0, 1.13.0.dev12): '${value:0:80}'"; return 1; }
        OD_VERSION="$value" ;;
      ONDEMAND_VERSION_FROM)
        [[ "$value" =~ ^(pypi|docker)?$ ]] || { OD_PARSE_ERR="ONDEMAND_VERSION_FROM is not a source this executor runs a version from (pypi or docker): '${value:0:80}'"; return 1; }
        OD_VERSION_FROM="$value" ;;
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
  if [ -n "$OD_REF" ] && [ -n "$OD_VERSION" ]; then
    OD_PARSE_ERR="ONDEMAND_REF and ONDEMAND_VERSION are both given: a run has one target"; return 1
  fi
  [ -n "$OD_REF" ] || [ -n "$OD_VERSION" ] || { OD_PARSE_ERR="ONDEMAND_REF is missing (or ONDEMAND_VERSION, for a published version)"; return 1; }
  if [ -n "$OD_VERSION_FROM" ] && [ -z "$OD_VERSION" ]; then
    OD_PARSE_ERR="ONDEMAND_VERSION_FROM needs ONDEMAND_VERSION: it says where a version comes from"; return 1
  fi
  [ -z "$OD_VERSION" ] || OD_VERSION_FROM="${OD_VERSION_FROM:-pypi}"
  if [ -n "$OD_MODEL" ] && [ -z "$OD_PROVIDER" ]; then
    OD_PARSE_ERR="ONDEMAND_MODEL needs ONDEMAND_PROVIDER: a model is declared for a provider"; return 1
  fi
  return 0
}

# The request's target, for the request line: ref=<branch>, or version=<v> from=<where>.
ondemand_target() {
  if [ -n "$OD_VERSION" ]; then printf 'version=%s from=%s' "$OD_VERSION" "$OD_VERSION_FROM"; else printf 'ref=%s' "$OD_REF"; fi
}

# The target as a reason names it: "<branch> @ <sha12>", "langflow==<version>", or the
# published image it pulled.
ondemand_target_named() {
  if [ "$OD_VERSION_FROM" = docker ]; then printf '%s' "${OD_PULLED:-the image of $OD_VERSION}"
  elif [ -n "$OD_VERSION" ]; then printf 'langflow==%s' "$OD_VERSION"
  else printf '%s @ %s' "$OD_REF" "${OD_TARGET_SHA:0:12}"; fi
}

# Whether a version is older than 1.12: before it langflow-base was numbered 0.N, and
# today's suite measures a product that old as a long list of features it lacks.
ondemand_version_too_old() {
  local major minor
  major="${OD_VERSION%%.*}"; minor="${OD_VERSION#"$major"}"; minor="${minor#.}"; minor="${minor%%[!0-9]*}"
  [ "$((10#$major))" -lt 1 ] || { [ "$((10#$major))" = 1 ] && [ "$((10#${minor:-0}))" -lt 12 ]; }
}

# The published image of the version, pulled where the build would put an image: asked
# of Docker Hub first, so a tag it does not have is refused in seconds and before any
# pull, then pulled and named by its DIGEST, which the run is given instead of the tag:
# a tag can be pushed again during the run, a digest cannot. The image carries no
# Langflow commit (its labels are the base image's), so the version it serves, checked
# exactly by run-e2e.sh, is the rest of the check. An image this run pulled is removed
# after it; one that was already here (the shadow's nightly, say) is left alone.
ondemand_pull() {
  local limit_s="$1" hub="$2" repo code tag="" rc=0 start=$SECONDS err="$OD_STATE/pull-stderr.$$" said digest
  [[ "$limit_s" =~ ^[1-9][0-9]*$ ]] || ondemand_fail 3 failed "E2E_ONDEMAND_PULL_TIMEOUT_S='$limit_s' is not a number of seconds"
  ondemand_version_too_old && ondemand_refuse "langflowai/langflow:$OD_VERSION is older than 1.12, which this executor runs: today's suite measures a product that old as the features it lacks"
  # langflowai/langflow publishes releases, rcs and nightlies; langflow-nightly only
  # nightlies, some of them older than the first.
  for repo in langflowai/langflow langflowai/langflow-nightly; do
    if [ "$repo" = langflowai/langflow-nightly ] && ! [[ "$OD_VERSION" =~ \.dev[0-9]+$ ]]; then break; fi
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$hub/$repo/tags/$OD_VERSION" 9>&- 8>&- 2>/dev/null)" || code=""
    case "$code" in
      200) tag="$repo:$OD_VERSION"; break ;;
      404) ;;
      *) ondemand_fail 3 failed "could not ask Docker Hub whether it has $repo:$OD_VERSION (HTTP ${code:-none}): the network or the registry, not the version" ;;
    esac
  done
  [ -n "$tag" ] || ondemand_refuse "Docker Hub has no langflowai/langflow:$OD_VERSION; one published in the last few minutes may not be there yet, so ask again shortly"
  # Recorded before the pull, so a run killed during it still has its image removed by
  # the next start. Only an image that was not here before is this run's to remove.
  if ! docker image inspect "$tag" > /dev/null 2>&1; then
    OD_PULLED="$tag"
    printf '%s\n' "$tag" > "$OD_STATE/pulled-image"
  fi
  echo "pulling: $tag (at most ${limit_s}s)"
  timeout -k 30 "$limit_s" docker pull -q "$tag" 9>&- 8>&- > /dev/null 2> "$err" || rc=$?
  cat "$err" 2>/dev/null
  said="$(tail -n 3 "$err" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g; s/ $//' | cut -c1-300)"
  rm -f "$err"
  if [ "$rc" = "124" ] || { [ "$rc" = "137" ] && [ $((SECONDS - start)) -ge "$limit_s" ]; }; then
    ondemand_fail 3 failed "the pull of $tag did not finish in ${limit_s}s, so it was stopped: the machine, the network or the registry, not the version"
  fi
  [ "$rc" = "0" ] || ondemand_fail 3 failed "could not pull $tag (docker exited $rc): the machine, the network or the registry: ${said:-no reason given}"
  digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" 2>/dev/null | grep -m 1 "^${tag%%:*}@sha256:")"
  [[ "$digest" =~ ^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || ondemand_fail 3 failed "pulled $tag but docker names no digest for it ('${digest:0:120}'), so the run could not be held to those bytes"
  OD_IMAGE="$digest"; OD_TARGET_VERSION="$OD_VERSION"; OD_BUILD_S=$((SECONDS - start))
  # Parsed by the worker's readProgress, as "built:" and "installed:" are.
  echo "pulled: $tag, version $OD_VERSION, ${OD_BUILD_S}s, as $digest"
}

# The image a run pulled, removed by tag: from this run's cleanup, or from the next
# start when a killed run left it. Never one that was already on the machine.
ondemand_clear_pulled() {
  local tag
  tag="$(head -n 1 "$OD_STATE/pulled-image" 2>/dev/null)" || tag=""
  [ -n "$tag" ] || return 0
  if [[ "$tag" =~ ^langflowai/langflow(-nightly)?:[0-9A-Za-z.]+$ ]]; then
    echo "removing the pulled image $tag"
    docker rmi "$tag" > /dev/null 2>&1 || echo "WARNING: could not remove $tag (an image a container still uses, or already gone)"
  fi
  rm -f "$OD_STATE/pulled-image"
}

# The published version into $STATE/venv, where the build would put the image: asked of
# PyPI first, so a version it does not have is refused in seconds and before the venv
# is touched, then installed by scripts/prepare-target-dist.sh -- the daily's own
# installer, which refuses a venv whose langflow-base is not the version or that has no
# built frontend. From the clone, not the suite's worktree, as the build is.
ondemand_install() {
  local limit_s="$1" pypi="$2" said rc=0 out err="$OD_STATE/install-stderr.$$" meta="$OD_STATE/pypi.$$.json" code start=$SECONDS
  [[ "$limit_s" =~ ^[1-9][0-9]*$ ]] || ondemand_fail 3 failed "E2E_ONDEMAND_INSTALL_TIMEOUT_S='$limit_s' is not a number of seconds"
  # 404 is PyPI's "no such version" and 200 its release; anything else (the network, a
  # 5xx) is failed: the install reads the same index, and the pins below need it too.
  local python=3.14 pin="" verdict requires p nosol
  # Before 1.12, langflow-base was numbered 0.N (1.11.6 requires langflow-base 0.11.6),
  # which the installer's check that it is the version cannot match: every such run
  # would end build_failed, blaming the release. Refused instead, before anything.
  if ondemand_version_too_old; then
    ondemand_refuse "langflow==$OD_VERSION is older than 1.12, which this executor can install: before it, langflow-base was numbered 0.N and its version cannot be checked against the release's"
  fi
  code="$(curl -sS -o "$meta" -w '%{http_code}' --max-time 30 "$pypi/langflow/$OD_VERSION/json" 9>&- 8>&- 2>/dev/null)" || code=""
  if [ "$code" = "404" ]; then
    rm -f "$meta"
    ondemand_refuse "PyPI has no langflow==$OD_VERSION; check the version at https://pypi.org/project/langflow/#history (one published in the last few minutes may not be listed yet: ask again shortly)"
  fi
  if [ "$code" = "200" ]; then
    said="$(node "$OD_REPO/scripts/lib/pypi-release.mjs" "$meta" "$OD_VERSION" 9>&- 8>&- 2>/dev/null)" || said=""
    rm -f "$meta"
    verdict="$(printf '%s\n' "$said" | sed -n 's/^verdict=//p')"
    requires="$(printf '%s\n' "$said" | sed -n 's/^requires=//p')"
    case "$verdict" in
      ok) ;;
      # PyPI answers /1.12/json with 1.12.0: the same release, spelled so the run's exact
      # gate would call it another version. Refused with the spelling to ask for.
      other) ondemand_refuse "PyPI publishes that release as langflow==$(printf '%s\n' "$said" | sed -n 's/^version=//p'), not $OD_VERSION; ask for it as PyPI spells it" ;;
      nofiles) ondemand_refuse "PyPI lists langflow==$OD_VERSION with no files to install" ;;
      # uv would still install a yanked release pinned with == (PEP 592); refused because
      # its publisher withdrew it, which is not what anyone means to test.
      yanked) ondemand_refuse "langflow==$OD_VERSION was withdrawn from PyPI (every file is yanked)" ;;
      *) echo "PyPI's answer for langflow==$OD_VERSION could not be read; the install decides" ;;
    esac
    if [ "$verdict" = "ok" ]; then
      python="$(printf '%s\n' "$said" | sed -n 's/^python=//p')"
      [ -n "$python" ] || ondemand_refuse "langflow==$OD_VERSION requires Python $requires, and this machine runs 3.12 to 3.14"
      [[ "$python" =~ ^3\.1[2-4]$ ]] || python=3.14
    fi
  else
    rm -f "$meta"
    ondemand_fail 3 failed "could not ask PyPI whether it has langflow==$OD_VERSION (HTTP ${code:-none}): the network or the index, not the version"
  fi
  # langflow-base and lfx pinned to the version when PyPI has them at it: a release asks
  # for langflow-base as a range, which resolves the newest of the series, and lfx is
  # not pinned at all (#2261 review). Only what PyPI says it has: lfx is younger than
  # most releases, and a pin to a version it never had fails the install.
  # Any answer but those two is the network's: unpinned, a release would resolve the
  # newest langflow-base and end build_failed, blaming the release for a blip.
  for p in langflow-base lfx; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$pypi/$p/$OD_VERSION/json" 9>&- 8>&- 2>/dev/null)" || code=""
    case "$code" in
      200) pin="${pin:+$pin }$p" ;;
      404) ;;
      *) ondemand_fail 3 failed "could not ask PyPI whether it has $p==$OD_VERSION (HTTP ${code:-none}): the network or the index, not the version" ;;
    esac
  done
  # uv's pre-release mode, named rather than its default, which UV_PRERELEASE or a
  # uv.toml would change: if-necessary-or-explicit resolves a pinned rc, a final and a
  # nightly (whose lfx requires a langflow-sdk .devM) with the qa's uv, and lets in no
  # other project's beta the daily's install does not already get (#2261).
  OD_VENV="$OD_STATE/venv"
  echo "installing: langflow==$OD_VERSION from $OD_VERSION_FROM into $OD_VENV, python $python${pin:+, with $pin at the same version} (at most ${limit_s}s)"
  out="$(TARGET_VERSION="$OD_VERSION" LANGFLOW_DIST_VENV="$OD_VENV" LANGFLOW_DIST_PIN="$pin" LANGFLOW_DIST_PYTHON="$python" LANGFLOW_DIST_PRERELEASE=if-necessary-or-explicit \
    timeout -k 60 "$limit_s" "$OD_REPO/scripts/prepare-target-dist.sh" 9>&- 8>&- 2> "$err")" || rc=$?
  cat "$err" 2>/dev/null
  # The installer's reason is its ERROR: paragraph; the first line names it.
  said="$(grep -m 1 '^ERROR: ' "$err" 2>/dev/null)"
  said="${said#ERROR: }"
  # uv's own word that the requirements cannot be met together: the release's metadata,
  # or an index that has not seen a release published minutes ago -- not the machine.
  # uv's paragraph alone: from its first line up to the installer's own ERROR: line.
  nosol="$(awk '/No solution found/ { f = 1 } /^ERROR: / { f = 0 } f' "$err" 2>/dev/null | head -n 6 | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-400)"
  rm -f "$err"
  if [ "$rc" = "124" ] || { [ "$rc" = "137" ] && [ $((SECONDS - start)) -ge "$limit_s" ]; }; then
    ondemand_fail 3 failed "the install of langflow==$OD_VERSION did not finish in ${limit_s}s, so it was stopped: the machine, the network or the index, not the version"
  fi
  if [ "$rc" != "0" ]; then
    case "$said" in
      # Its checks of what landed: the distribution is wrong, not the machine.
      "the install reported success and no langflow"* | "the wheel installed "* \
        | "langflow "*" is installed and langflow-base is not"* | "langflow is "*" but langflow-base is "* \
        | "langflow "*" find_spec cannot locate"* | "the distribution carries no built frontend"* \
        | "lfx was pinned to "*)
        ondemand_fail 4 build_failed "langflow==$OD_VERSION installed but cannot be served, not a test result: ${said:-no reason given}" ;;
      *) [ -z "$nosol" ] || ondemand_fail 3 failed "uv found no set of packages that installs langflow==$OD_VERSION${pin:+ with $pin at the same version}: the release's own requirements, or an index that has not caught up with a release published minutes ago (ask again shortly); uv said: $nosol"
        ondemand_fail 3 failed "could not install langflow==$OD_VERSION (prepare-target-dist.sh exited $rc): the machine, the network or the index, which this cannot tell from the version: ${said:-no reason given}" ;;
    esac
  fi
  local line
  while IFS= read -r line; do
    case "$line" in
      prepared_version=*) OD_TARGET_VERSION="${line#prepared_version=}" ;;
      frontend_dir=*) OD_FRONTEND="${line#frontend_dir=}" ;;
      install_s=*) OD_BUILD_S="${line#install_s=}" ;;
    esac
  done <<< "$out"
  [ "$OD_TARGET_VERSION" = "$OD_VERSION" ] && [ -n "$OD_FRONTEND" ] && [ -x "$OD_VENV/bin/langflow" ] \
    || ondemand_fail 4 build_failed "the install's answer is incomplete: version='$OD_TARGET_VERSION' (asked $OD_VERSION) frontend='$OD_FRONTEND' langflow=$([ -x "$OD_VENV/bin/langflow" ] && echo present || echo missing)"
  [[ "$OD_BUILD_S" =~ ^[0-9]{1,6}$ ]] || OD_BUILD_S=""
  # Parsed by the worker's readProgress, as the build's "built:" line is.
  echo "installed: langflow==$OD_VERSION, version $OD_TARGET_VERSION, ${OD_BUILD_S:-?}s, in $OD_VENV"
}

# A version's Langflow on this lane's ports, by the starter's own pid files: run-e2e.sh
# stops them on its exit, and this is for an exit it never reached.
# Fails when one of them could not be stopped (it survived SIGKILL), which the stopper
# says and leaves its pid file for.
ondemand_stop_versions() {
  local port stopped=0
  [ -x "$OD_REPO/scripts/stop-langflow-source.sh" ] || return 0
  for port in 7910 7911 7912 7913; do
    LANGFLOW_PORT="$port" "$OD_REPO/scripts/stop-langflow-source.sh" > "$OD_STATE/stop.$$" 2>&1 || stopped=1
    sed 's/^/    /' "$OD_STATE/stop.$$" 2>/dev/null
    rm -f "$OD_STATE/stop.$$"
  done
  return "$stopped"
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
  if ! ondemand_stop_versions; then
    cleanup=incomplete
    echo "ERROR: a Langflow on this lane's ports (7910-7913) could not be stopped"
  fi
  [ -z "$OD_VENV" ] || rm -rf "$OD_VENV"
  if [ -n "$OD_WT" ] && [ -d "$OD_WT/scripts" ]; then
    ( cd "$OD_WT"; ECHO_PORT=8100 bash scripts/stop-echo-source.sh; OLLAMA_PORT=11454 bash scripts/stop-ollama-source.sh ) 2>&1 | sed 's/^/    /' || true
  fi
  ondemand_clear_images
  ondemand_clear_pulled
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
