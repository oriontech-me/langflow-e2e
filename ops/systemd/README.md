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

What the machine must have before the units are worth installing. Neither of these can
live in this repository as a file, so they are listed here, with how to check each on
the machine.

| Prerequisite | Check | If it is missing |
|---|---|---|
| `uv` in `~/.local/bin` (the installer and the starter need it; systemd does not load that directory, which is why the wrapper puts it on `PATH`) | `~/.local/bin/uv --version` | the preflight **stops** the run and says so |
| `localhost` resolving to **both** `127.0.0.1` and `::1`. Ubuntu's default `/etc/hosts` maps `::1` to `ip6-localhost ip6-loopback` only, so add `localhost` to that line: `::1 localhost ip6-localhost ip6-loopback` (#1998) | `python3 -c 'import socket; print({a[4][0] for a in socket.getaddrinfo("localhost", None)})'` shows both | the preflight **warns** and writes `logs/target-localhost.log`, and `model-provider-base-url-ssrf` fails on the environment, not the product |

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

### Asking for an on-demand run by hand

Write the request, then start the unit. The request is **parsed, never sourced**: six
known keys, each checked against its shape, anything else refused (see the header of
`ops/vm/run-on-demand.sh`). `ONDEMAND_SUITE_REF`, optional, runs a branch or tag of this
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

Its cleanup runs `docker builder prune -af`, which is **machine-wide**: harmless while no
other lane builds an image on the qa, and the first thing to change when one does.

There is **one request slot**. A start while a run is going is joined to that run's
job by systemd and answers nothing, so write the next request only after the running
one's result exists, and start the unit again.

The answer is `/root/e2e-on-demand/results/<id>.env`: `STATUS` (`refused`,
`build_failed`, `failed` or `done`), `VERDICT` for a run that reached one, `RUN_ID`,
the target's ref, commit and version, the suite commit, and `CLEANUP` (`pending` if the
cleanup was cut short, then `ok`, `incomplete` or `unconfirmed`). The log is
`/var/log/e2e-on-demand/latest.log`.

## Verify

```sh
for f in e2e-daily.service e2e-daily.timer e2e-daily-watchdog.service \
         e2e-daily-watchdog.timer e2e-mirror-freshness.service e2e-mirror-freshness.timer \
         e2e-mirror-freshness-announce.service e2e-mirror-freshness-announce.timer \
         e2e-shadow.service e2e-on-demand.service; do
  diff -q "ops/systemd/$f" "/etc/systemd/system/$f" || echo "$f DIFFERS"
done
diff -q ops/systemd/e2e-daily.service.d/10-target-dist.conf \
        /etc/systemd/system/e2e-daily.service.d/10-target-dist.conf

systemctl show e2e-daily.service -p LoadState -p Wants -p After --value
systemctl list-timers e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer \
  e2e-mirror-freshness-announce.timer
```

Existence is `LoadState=loaded`, never `ActiveState` — a unit that does not exist reports
`ActiveState=inactive`, which reads like a unit that is merely stopped. And `active` does
not mean running for a `oneshot`: compare `ExecMainExitTimestamp` with
`ExecMainStartTimestamp` for that.

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
| `disk` | `ops/vm/run-disk.sh` | 10:45 | heavy, only to clean | 12:45 |

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

Every weekday it records the disk's use and the cache's size in its result, and at or
over `DISK_ALARM_PCT` (70) of `/` it leaves an `ALARM` naming the largest entries under
`/root`, which the watchdog posts to Slack, beside the reason on a skipped or failed day
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
