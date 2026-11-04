# The VM lane's systemd units

What schedules and contains the daily on the machine that carries the verdict. These
files are the **source**; the copies under `/etc/systemd/system` are installed from
here, which is what makes `diff` a meaningful check (see *Verify*).

| Unit | What it is |
|---|---|
| `e2e-daily.service` + `e2e-daily.service.d/10-target-dist.conf` | the run itself: `Type=oneshot`, `HOME` declared because systemd sets none (#1715), and a drop-in that serves the **published distribution** instead of the source clone |
| `e2e-daily.timer` | 08:00 UTC on weekdays, `Persistent=false` |
| `e2e-daily-watchdog.service` | the alarm for a day that produced **no** verdict |
| `e2e-daily-watchdog.timer` | 09:00 UTC on weekdays, `Persistent=true` |
| `e2e-mirror-freshness.service` + `.timer` | hourly: is the suite this lane checked out still what `main` holds? (#1947). **Records** the answer, never posts |
| `e2e-shadow.service` | the **image shadow** (#2093): the same suite against the published image of the version the daily served, on its own ports, worktree, ledger and logs, publishing nothing. **No timer**: `ops/vm/request-shadow.sh` starts it with `--no-block` at the end of the daily **on the days its cadence is due** (every run through 2026-10-09, then the first run of each week from Monday; the knobs are in `run-daily.sh` and may be moved from the lane file), and `After=e2e-daily.service` holds it until the daily's unit has finished |
| `e2e-on-demand.service` | the **on-demand run**: one `@stable` run against one branch of upstream, built into an image on this machine (`ops/vm/build-target-image.sh`) and served as a declared target (#2111), answering the request in `/root/e2e-on-demand/request.env`. Its own ports (7910-7913, echo 8100, ollama 11454; not 7890-7893, the Enterprise and serving-identity defaults), worktree, ledger copy and logs, publishing nothing. **No timer** and **no `Conflicts=`**: it refuses to start on weekdays 07:30-08:40 UTC or beside the daily or the shadow, and `run-daily.sh` stops it if it is still going at 08:00. It also refuses while a scheduled routine holds the heavy-lane lock (*Scheduled routines*) |
| `e2e-on-demand-worker.service` | the **on-demand worker** (`ops/vm/on-demand-worker.mjs`): polls the QA platform's on-demand queue over outbound HTTPS, claims one request at a time, writes it into the run's slot, starts `e2e-on-demand.service` and forwards its result. The one long-running unit here, so the one with an `[Install]` section: it comes back after a reboot by itself. See *Operating the on-demand worker* |
| `e2e-mirror-freshness-announce.service` + `.timer` | 07:30 UTC on weekdays, `Persistent=false`: posts only if the mirror is behind 30 minutes before the daily. The rest of the day reaches the channel as the `Mirror:` line of the daily's own message |
| `e2e-routine-<name>.service` + `.timer` | a **scheduled routine** moved off Actions (stage 3): the shape is `ops/vm/lib/routine.sh`, see *Scheduled routines* below |
| `e2e-routine-watchdog@.service` + `e2e-routine-<name>-watchdog.timer` | the **absence alarm** of one routine, the instance being its name; one template, one timer per routine |

## Two asymmetries that look like inconsistencies and are not

**`Persistent=`, opposite on purpose.** A daily that catches up after downtime produces a
verdict for a day it did not observe, so it must not: `false`. An alarm that catches up
is still telling the truth — "the run did not happen" does not expire — so it must:
`true`. Whoever makes them agree breaks one of the two.

**Every calendar carries `UTC` explicitly.** This machine's clock is EDT and Debian's
cron (3.0pl1) has no `CRON_TZ`, which is why none of this is a crontab line: a schedule
written in local time silently moves an hour at the DST change, and the lane it is
compared against (`.github/workflows/daily-stable.yml`) is expressed in UTC.

## Machine prerequisites

What the machine must have before the units are worth installing. None of these can
live in this repository as a file, so they are listed here, with how to check each on
the machine.

| Prerequisite | Check | If it is missing |
|---|---|---|
| `uv` in `~/.local/bin` (the installer and the starter need it; systemd does not load that directory, which is why the wrapper puts it on `PATH`) | `~/.local/bin/uv --version` | the preflight **stops** the run and says so |
| `localhost` resolving to **both** `127.0.0.1` and `::1`. Ubuntu's default `/etc/hosts` maps `::1` to `ip6-localhost ip6-loopback` only, so add `localhost` to that line: `::1 localhost ip6-localhost ip6-loopback` (#1998) | `python3 -c 'import socket; print({a[4][0] for a in socket.getaddrinfo("localhost", None)})'` shows both | the preflight **warns** and writes `logs/target-localhost.log`, and `model-provider-base-url-ssrf` fails on the environment, not the product |
| `lf-self.localhost` resolving to `127.0.0.1`. `mcp-server.spec.ts` registers Langflow as its own MCP server under that name, which every starter allow-lists, because from 1.13.1 a loopback MCP destination is admitted only by an explicit `LANGFLOW_SSRF_ALLOWED_HOSTS` entry and the suite cannot list `localhost` (`tests/helpers/mcp/self-mcp-url.ts`, upstream #16041). `*.localhost` needs no file where nsswitch has `myhostname` or `resolve`; this VM's has `files mymachines dns`, so add the name to the loopback line: `127.0.0.1 localhost lf-self.localhost` | `python3 -c 'import socket; print({a[4][0] for a in socket.getaddrinfo("lf-self.localhost", None)})'` shows `127.0.0.1` | the preflight **warns** and writes `logs/target-self-mcp-host.log`, and the two self-registration tests in `mcp-server.spec.ts` fail with `Connection failed: … unhandled errors in a TaskGroup` |

The asymmetry is deliberate. A missing `uv` cannot produce a run at all, so the preflight
refuses one. A missing `::1` produces a run with one false red, and a refusal would trade
a day of data for it. So the preflight warns, and the warning lands in the run's own
evidence, where the triage of that red looks first.

**Check with `getaddrinfo`, not `getent ahosts`.** On a host with no global IPv6 address
`getent ahosts localhost` drops `::1` even when `/etc/hosts` is right. That was measured
on the QA VM, and it is the resolver the backend does *not* use.

## Install

```sh
cd /root/e2e-qa
cp -r ops/systemd/e2e-daily.service ops/systemd/e2e-daily.timer \
      ops/systemd/e2e-daily-watchdog.service ops/systemd/e2e-daily-watchdog.timer \
      ops/systemd/e2e-mirror-freshness.service ops/systemd/e2e-mirror-freshness.timer \
      ops/systemd/e2e-mirror-freshness-announce.service ops/systemd/e2e-mirror-freshness-announce.timer \
      ops/systemd/e2e-shadow.service ops/systemd/e2e-on-demand.service \
      /etc/systemd/system/
mkdir -p /etc/systemd/system/e2e-daily.service.d
cp ops/systemd/e2e-daily.service.d/10-target-dist.conf /etc/systemd/system/e2e-daily.service.d/
systemctl daemon-reload
systemctl enable --now e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer \
  e2e-mirror-freshness-announce.timer
```

The `.service` units carry no `[Install]` section by design: each is pulled by its
timer's `Unit=`, so only the timers are enabled. `e2e-shadow.service` has no timer
either: it is installed and never enabled, and the daily asks for it. Removing it is the
shadow's rollback, and the daily then logs `shadow: NOT requested — … not installed`.
`e2e-on-demand.service` is the same: installed, never enabled, started for one request.

`e2e-on-demand-worker.service` is the exception: it is enabled, and it needs its env
file before it starts (see *Operating the on-demand worker*):

```sh
cp ops/systemd/e2e-on-demand-worker.service /etc/systemd/system/
# Created empty only when it does not exist: never over a file that holds the token.
[ -e /root/.e2e-on-demand-worker.env ] || install -m 600 -o root -g root /dev/null /root/.e2e-on-demand-worker.env
systemctl daemon-reload
systemctl enable e2e-on-demand-worker.service
```

Fill the env file, then start it. Started on an empty file, it exits 78 and stays
failed until restarted:

```sh
systemctl start e2e-on-demand-worker.service
```

### Asking for an on-demand run by hand

Write the request, then start the unit. This is what the worker does for each request
it claims, and the way to run one with the worker stopped. The request is **parsed,
never sourced**: ten known keys (`ONDEMAND_ID`, `ONDEMAND_REF`, `ONDEMAND_VERSION`,
`ONDEMAND_VERSION_FROM`, `ONDEMAND_PROVIDER`, `ONDEMAND_MODEL`, `ONDEMAND_REQUESTED_BY`,
`ONDEMAND_AREAS`, `ONDEMAND_RETRIES`, `ONDEMAND_SUITE_REF`), each checked against its
shape, anything else refused (see the header of `ops/vm/run-on-demand.sh`). The target
is exactly one of `ONDEMAND_REF`, a branch of upstream built into an image, and
`ONDEMAND_VERSION`, a version published on PyPI in PEP 440's normal form (`1.13.1rc0`,
`1.13.0.dev12`, as PyPI spells it), installed with the daily's
`scripts/prepare-target-dist.sh` into `/root/e2e-on-demand/venv` and served from it.
`langflow-base` and `lfx` are pinned to the same version where PyPI has them, Python is
3.14 unless the release excludes it (then 3.13 or 3.12, which uv downloads once), uv
resolves under `--prerelease=if-necessary-or-explicit` whatever `UV_PRERELEASE` says
(with uv 0.12.5, the qa's, that resolves rcs, finals and nightlies alike), and versions
before 1.12 are refused (their `langflow-base` was numbered 0.N); `ONDEMAND_VERSION_FROM` is `pypi` or
empty, which means it. With `ONDEMAND_VERSION_FROM=docker` the version's **published
image** runs instead (`langflowai/langflow:<version>`, or `langflow-nightly` for a nightly
the first lacks): asked of Docker Hub, pulled, and run by its digest, since the image's
labels carry no Langflow commit; it is removed after the run unless it was on the
machine before. `ONDEMAND_SUITE_REF`, optional, runs a branch or tag of this
repository instead of the commit the daily left the clone on: it is fetched from the
clone's origin (the GHES mirror, synced hourly) and must contain the executor's
`SUITE_FLOOR`, or the request is refused before the build. **A suite ref is trusted
code:** its scripts and specs run as root, so they reach anything on the machine:
`/root/.e2e-secrets` (publishing tokens included), the worker's token, the mirror's git
credentials, the daily's clone and its units. Accepted on 2026-10-09, because whoever
can push a branch to the mirror can already change the `main` the daily runs as root;
see the header of `run-on-demand.sh`.

```sh
mkdir -p /root/e2e-on-demand
cat > /root/e2e-on-demand/request.env <<'REQ'
ONDEMAND_ID=hand-20261001-1
ONDEMAND_REF=release-1.13.0
ONDEMAND_PROVIDER=anthropic
ONDEMAND_REQUESTED_BY=victor
REQ
systemctl start --no-block e2e-on-demand.service
```

A published version instead of a branch:

```sh
cat > /root/e2e-on-demand/request.env <<'REQ'
ONDEMAND_ID=hand-20261012-1
ONDEMAND_VERSION=1.12.5rc1
REQ
systemctl start --no-block e2e-on-demand.service
```

Its published image instead: add `ONDEMAND_VERSION_FROM=docker`.

Its cleanup runs `docker builder prune -af`, which is **machine-wide**: harmless while no
other lane builds an image on the qa, and the first thing to change when one does.

There is **one request slot**. A start while a run is going is joined to that run's
job by systemd and answers nothing, so write the next request only after the running
one's result exists, and start the unit again.

The answer is `/root/e2e-on-demand/results/<id>.env`: `STATUS` (`refused`,
`build_failed`, `failed` or `done`), `VERDICT` for a run that reached one, `RUN_ID`,
the target's ref, commit and version (a version's ref and commit are empty, and
`BUILD_S` is its install or its pull; a published image's run adds `TARGET_IMAGE`, the
digest that ran), the suite commit, and `CLEANUP` (`pending` if the
cleanup was cut short, then `ok`, `incomplete` or `unconfirmed`). The log is
`/var/log/e2e-on-demand/latest.log`.

**How long a run takes, and its limits.** Measured on the qa from 2026-10-05 to 10-10: a
whole run of `@stable` takes 26-33 min, 316-353 s of it the build and 17-24 min the
suite. A run narrowed to one area takes about 10 min, almost all of it the build.
Three ceilings, each under the next:

| Ceiling | Where | When it is hit |
|---|---|---|
| each upstream step 5 min, the `docker build` 30 min | `build-target-image.sh` (`UPSTREAM_TIMEOUT_S`, `BUILD_TIMEOUT_S`) | `failed`, "did not finish in …": the machine, docker or the network, never the branch |
| a version's install 15 min | `run-on-demand.sh` (`E2E_ONDEMAND_INSTALL_TIMEOUT_S`) | `failed`, "did not finish in …": the machine, the network or the index, never the version |
| an image's pull 10 min | `run-on-demand.sh` (`E2E_ONDEMAND_PULL_TIMEOUT_S`) | `failed`, "did not finish in …": the machine, the network or the registry, never the version |
| the run's deadline, 80 min from the executor's start, plus up to 2 for the suite to stop | `run-on-demand.sh` (`E2E_ONDEMAND_DEADLINE_S`): the suite gets what is left | `failed`, "the suite ran past the run's deadline" |
| 90 min | the unit's `TimeoutStartSec` | `failed`, "stopped by SIGTERM", which the daily's stop and `systemctl stop` also say |

Over all three is the platform's `MAX_HOLD_SECONDS`, 2 h from the claim: past it, the
platform releases the request as `abandoned` while the run would still be going. The
deadline counts from the executor's start, not the claim, so a start the worker had to
retry (the slot held by a run started by hand), or one held while the daily has the
machine (`paused_for_daily`, up to its 70 min window), can still pass it; the run's
result is taken anyway, over the `abandoned`. That is why none of the
ceilings grows with retries. The platform asks for at most the suite's default of 2;
3 to 5, asked by hand, may reach the deadline on a very red branch.

## Verify

```sh
for f in e2e-daily.service e2e-daily.timer e2e-daily-watchdog.service \
         e2e-daily-watchdog.timer e2e-mirror-freshness.service e2e-mirror-freshness.timer \
         e2e-mirror-freshness-announce.service e2e-mirror-freshness-announce.timer \
         e2e-shadow.service e2e-on-demand.service e2e-on-demand-worker.service; do
  diff -q "ops/systemd/$f" "/etc/systemd/system/$f" || echo "$f DIFFERS"
done
diff -q ops/systemd/e2e-daily.service.d/10-target-dist.conf \
        /etc/systemd/system/e2e-daily.service.d/10-target-dist.conf

systemctl show e2e-daily.service -p LoadState -p Wants -p After --value
systemctl list-timers e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer \
  e2e-mirror-freshness-announce.timer
systemctl is-enabled e2e-on-demand-worker.service   # enabled
systemctl is-active e2e-on-demand-worker.service    # active
```

Existence is `LoadState=loaded`, never `ActiveState` — a unit that does not exist reports
`ActiveState=inactive`, which reads like a unit that is merely stopped. And `active` does
not mean running for a `oneshot`: compare `ExecMainExitTimestamp` with
`ExecMainStartTimestamp` for that.

## Operating the on-demand worker

The worker is the bridge between the QA platform's on-demand queue and
`e2e-on-demand.service`. The platform cannot reach this machine, so the worker pulls:
every call is outbound HTTPS. The contract it speaks is the platform's
(`oriontech-me/quality-platform`, `docs/ON_DEMAND_QUEUE_CONTRACT.md`); what it does on
this machine is in the header of `ops/vm/on-demand-worker.mjs`.

**Its env file**, `/root/.e2e-on-demand-worker.env`, mode 600, owned by root, outside
the clone. `KEY=value` lines, read by systemd (`EnvironmentFile=`):

| Key | Required | What |
|---|---|---|
| `QA_ON_DEMAND_API_BASE` | yes | the platform's API, `https://<host>`, no path |
| `QA_ON_DEMAND_WORKER_TOKEN` | yes | the worker's credential: a token the platform issued (`odw_…`) |
| `QA_ON_DEMAND_WORKER_ID` | no | the name the platform shows for this worker; `qa` when unset |

The token is a secret: put it in the file straight from where it was issued. Never in
a chat, an issue, a commit or a shell history you keep.

**Is it working?**

```sh
systemctl status e2e-on-demand-worker.service
journalctl -u e2e-on-demand-worker.service --since "1 hour ago"
```

The platform's On Demand tab shows the worker's state and when it was last seen. It
sends a heartbeat every 60 s: "not responding" there means it stopped, or cannot reach
the platform (the VPN, or the platform down). Its own state, the request it holds and
the claim token, is `/root/e2e-on-demand/worker/state.json`. Each run's log is
`/var/log/e2e-on-demand/<stamp>.log`, and `latest.log` points at the newest.

**Exit 78: the configuration is wrong.** A key missing, an `API_BASE` that is not
`https://<host>`, a `WORKER_ID` of a shape the platform does not take, or the platform
answering 401 to the token (wrong, or revoked). The
unit does not restart on 78 (`RestartPreventExitStatus=78`): retrying a wrong token
every 30 s fixes nothing. It stays `failed` until someone fixes the file. The journal
names what is wrong (`::error::`). Fix it, then:

```sh
systemctl restart e2e-on-demand-worker.service
journalctl -u e2e-on-demand-worker.service -n 20   # no ::error::, and the tab sees it within a minute
```

**Rotating the token, without interrupting it.** The platform keeps at most two active
tokens, which is what a rotation needs. Tokens are issued and revoked by a platform
admin, signed in with their own session (the routes and a terminal recipe are in the
platform's contract, *Worker credential*):

1. issue a new token (two already active refuse it: revoke the one that is not in use
   first);
2. replace `QA_ON_DEMAND_WORKER_TOKEN` in the env file, and `systemctl restart
   e2e-on-demand-worker.service`;
3. check that the heartbeat lands (the journal, or the tab);
4. revoke the old token.

Restarting the worker never stops a run: the run lives in `e2e-on-demand.service`, and
the worker reads the request it holds back from its state file.

**After a pull by hand.** The daily's pull restarts the worker when its code changed
(`systemctl try-restart`, in `run-daily.sh`). A pull by hand does not: restart it
yourself, or it keeps running the code from before. A changed unit file is never
installed by a pull: copy it and `systemctl daemon-reload`, as in *Install*.

**Stopping a run.** `systemctl stop e2e-on-demand.service` is safe: its trap cleans up
(containers, image, build cache, worktree) and writes the result `failed`, "stopped by
SIGTERM", which the worker forwards to the platform. A run cancelled on the platform,
queued or under way, needs nothing here: the worker learns it from its next heartbeat
(about a minute) and stops the run the same way, or, when no run has taken the
request yet, answers it itself, "cancelled on the platform before a run took it". The
journal says which: `asked e2e-on-demand.service to stop`, or `no run of it is going:
answered as cancelled`.

**Stopping the worker.** `systemctl stop e2e-on-demand-worker.service`: nothing new is
claimed, and a run already going finishes on its own. Started again, the worker
forwards its result. While it is stopped, requests wait in the platform's queue, and
one it held is released as `abandoned` after the 15 min lease: stopped longer than that
mid-run, the run shows `abandoned` until the worker, started again, forwards its result. To keep it off across a
reboot, `systemctl disable --now`.

## Rollback

Each unit is replaced, not merged, so rollback is the previous copy plus a reload. When
one is edited on the machine, the convention beside them is a dated backup —
`e2e-daily.service.bak-20260922` is the one from the tunnel removal — and `cp -a`
preserves the original mtime, so the date that means anything is the one in the name.

```sh
cp -a /etc/systemd/system/e2e-daily.service.bak-<date> /etc/systemd/system/e2e-daily.service
systemctl daemon-reload
```

## The wrappers the units call — `ops/vm/`

`e2e-daily.service` (through its drop-in) and `e2e-daily-watchdog.service` run scripts
from the clone, `/root/e2e-qa/ops/vm/`, the way `e2e-mirror-freshness.service` already
did. The wrapper pulls the clone and re-executes itself, so what runs is what `main`
holds — see its header for why the body is one function.

What the repository cannot hold stays on the machine, in two files the wrapper reads:

| File | Holds | Mode |
|---|---|---|
| `/root/.e2e-secrets` | provider keys, tokens, the Slack webhook | 600 |
| `/root/.e2e-lane` | topology, no secrets: `ISSUE_HOST`, `ISSUE_REPO`, `ISSUE_CC`, `BACKUP_DEST` | 600 |

The wrapper **refuses** to run when `.e2e-lane` is missing or leaves a key unset, and
names the key. `ISSUE_CC` has to be *set*, not non-empty: the empty string is a real
choice (an issue that pings nobody), while an absent key would fall back to the
github.com handles in `create-failure-issue.mjs`. So `.e2e-lane` goes in **before** the
units that point at `ops/vm/` are installed.

**Rollback** for either script is its pre-#1994 copy, left untouched in `/root`:
`/root/run-daily-dist.sh` for the drop-in's `ExecStart`, `/root/e2e-daily-watchdog.sh`
for the watchdog's, then `systemctl daemon-reload`. Deleting the drop-in is *not* a
rollback: it falls through to `/root/run-daily.sh`, the split-lane wrapper.

## Scheduled routines

The routines that ran on Actions' cron move here one at a time (stage 3 of the migration
plan). Each is a wrapper that sources `ops/vm/lib/routine.sh`, whose header is the
reference. In short:

- **The daily has priority.** A routine does not start on weekdays 07:30-08:40 UTC,
  beside `e2e-daily` or `e2e-shadow`, or while today's shadow request waits. It *waits*
  for its turn within a budget it declares, and `run-daily.sh` stops the routine that
  holds its turn at 08:00, found by the `e2e-routine-*` name; one still waiting is left
  to wait.
- **One heavy lane at a time.** Every lane that starts Langflow or a browser (the
  routines and the on-demand run) takes `/run/lock/e2e-heavy.lock`; who holds it is in
  `/run/lock/e2e-heavy.lock.holder`. A routine waits for it, the on-demand run refuses.
  The daily and the shadow take no lock: they have priority by stopping the others. A
  **light** routine, one that starts neither (`coverage-matrix`), waits for the daily
  lane alone and takes no lock.
- **An honest exit.** 0 green, 1 red, 2 skipped, 3 failed, 4 blocked. The service
  declares `SuccessExitStatus=2 4`, so systemd's `failed` means the machine failed.
  Each run writes `/root/e2e-routines/<name>/results/<stamp>.env` and `last.env`; logs
  are under `/var/log/e2e-<name>/`.
- **Red reaches the destination**, per the routine's declared visibility: one open issue
  per routine on `ISSUE_REPO` (label `routine:<name>`), commented on each red day and
  closed by the first green one, and a Slack post. The publishing credentials are read
  only by the report, never by the routine's work. Skipped, failed and blocked days, and
  a red whose report failed, are said by the routine's watchdog. So is a verdict with an
  `ALARM` line: something the routine must say that is not its verdict.

| Routine | Wrapper | When (UTC, weekdays) | Lock | Watchdog |
|---|---|---|---|---|
| `migration` | `ops/vm/run-migration.sh` | 09:15 | heavy | 12:30 |
| `coverage-matrix` | `ops/vm/run-coverage-matrix.sh` | 08:45 | none | 10:30 |
| `stable-orphans` | `ops/vm/run-stable-orphans.sh` | Mondays 10:00 | none | Mondays 11:45 |
| `disk` | `ops/vm/run-disk.sh` | 10:45 | daily's priority; heavy only to clean | 12:45 |

`coverage-matrix` commits to the **source's** `main` with `SOURCE_PUSH_TOKEN`, the
credential the daily's auto-removal and history already use, on a tree of its own: the
clone is never touched. It sends the dashboard feed to the QA platform only when
`QA_COVERAGE_MATRIX_ENDPOINT` is set in `/root/.e2e-secrets` (the token,
`QA_E2E_AUTOMATION_TOKEN`, is already there). `MATRIX_DRY_RUN=1` computes and stops
before the push and the POST.

`stable-orphans` reconciles `@stable` removals against the open issues that own their
restore (#1746, #2224). It only reads the source, which is public: `SOURCE_READ_TOKEN`, a
token with no permission at all, is what it uses and what reaches the reconciler, with
`SOURCE_PUSH_TOKEN` as the fallback until it exists (the result's `READ_TOKEN` says which).
It reads `main` into a detached worktree of the clone, removed when the run ends, and reads the open issues of
every repository in `ORPHAN_TRACKER_REPOS` (default `source destination`): dedicated
issues live in both until stage 4 moves the backlog. Its report is ONE issue on
`ISSUE_REPO` under a fixed title, replaced each run and closed when nothing is left;
Slack hears only about an orphan the last published run did not list. Findings are not
red: red means the reconciler itself refused. `ORPHANS_DRY_RUN=1` reconciles and stops
before the issue and Slack. It needs `gh` on the machine, for the reconciler's lookup of
gate references: installed on the qa on 2026-10-08 from GitHub's apt repository
(`/etc/apt/sources.list.d/github-cli.list`), so it moves with the system's upgrades.

`disk` keeps this machine's disk from filling silently (stage 3, task 8). What grows here
and what bounds it:

| Store | Bounded by |
|---|---|
| run directories of the daily, the on-demand run and the shadow | each keeps its last 30 (`RUNS_KEEP` in `scripts/run-e2e.sh`), about 470 MB a run |
| logs | pruned by age in each wrapper and in `routine.sh` |
| docker images | each lane removes what it pulled; the shadow keeps today's nightly |
| uv's cache | **this routine**: over `UV_CACHE_CAP_GB` (15) it runs `uv cache clean` under the heavy-lane lock, so never beside an install. It grows about 300 MB a weekday |
| anything else under `/root` | a human's (rehearsals, probes, spikes): never removed by a routine |

It measures the disk before it waits for anything, then waits for the daily lane's
priority (and, to clean, for the heavy-lane lock) within one 60 min budget, and measures
again after each wait. Every weekday it records the disk's use and the cache's size in its result, and at or
over `DISK_ALARM_PCT` (70) of `/` it leaves an `ALARM` naming the largest entries under
`/root` (a survey cut at `DISK_SURVEY_TIMEOUT_S`, 45 s, and marked incomplete if it runs
over), which the watchdog posts to Slack, beside the reason on a skipped or failed day
too. A full disk is never a red: it is not the
product's, and a red would open the routine's issue on the destination. It publishes
nothing itself.

Installing one routine, e.g. `migration` (each routine's units ship with the routine itself):

```sh
cd /root/e2e-qa
cp ops/systemd/e2e-routine-migration.service ops/systemd/e2e-routine-migration.timer \
   ops/systemd/e2e-routine-migration-watchdog.timer ops/systemd/e2e-routine-watchdog@.service \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now e2e-routine-migration.timer e2e-routine-migration-watchdog.timer
```

Rollback: `systemctl disable --now` the two timers. The routine's state and logs stay for
whoever asks what it did.

## What is NOT here

- **`/root/run-daily.sh`**, the split-lane wrapper the base unit still names: a remote
  target over ssh, the source clone, one shard, tracing forced off. It is no longer a
  way back to anything that runs, so it is not versioned; removing it is a decision of
  its own.
- **`langflow-tunnel.service`**, which names an internal host by ssh alias and is out of
  the lane since the consolidation served its target locally. It goes with its deletion.
- **Scratch under `/root`** (`chk.sh`, `diag.sh`, `e1-*.sh`, …): rehearsal tooling, not
  configuration. Named here so nobody hunts for it in the repository.
