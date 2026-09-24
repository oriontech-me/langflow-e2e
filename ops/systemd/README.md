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
| `e2e-mirror-freshness-announce.service` + `.timer` | 07:30 UTC on weekdays, `Persistent=false`: posts only if the mirror is behind 30 minutes before the daily. The rest of the day reaches the channel as the `Mirror:` line of the daily's own message |

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
      /etc/systemd/system/
mkdir -p /etc/systemd/system/e2e-daily.service.d
cp ops/systemd/e2e-daily.service.d/10-target-dist.conf /etc/systemd/system/e2e-daily.service.d/
systemctl daemon-reload
systemctl enable --now e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer \
  e2e-mirror-freshness-announce.timer
```

The `.service` units carry no `[Install]` section by design: each is pulled by its
timer's `Unit=`, so only the timers are enabled.

## Verify

```sh
for f in e2e-daily.service e2e-daily.timer e2e-daily-watchdog.service \
         e2e-daily-watchdog.timer e2e-mirror-freshness.service e2e-mirror-freshness.timer \
         e2e-mirror-freshness-announce.service e2e-mirror-freshness-announce.timer; do
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

## What is NOT here

- **`/root/run-daily.sh`**, the split-lane wrapper the base unit still names: a remote
  target over ssh, the source clone, one shard, tracing forced off. It is no longer a
  way back to anything that runs, so it is not versioned; removing it is a decision of
  its own.
- **`langflow-tunnel.service`**, which names an internal host by ssh alias and is out of
  the lane since the consolidation served its target locally. It goes with its deletion.
- **Scratch under `/root`** (`chk.sh`, `diag.sh`, `e1-*.sh`, …): rehearsal tooling, not
  configuration. Named here so nobody hunts for it in the repository.
