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
| `e2e-mirror-freshness.service` + `.timer` | hourly: is the suite this lane checked out still what `main` holds? (#1947) |

## Two asymmetries that look like inconsistencies and are not

**`Persistent=`, opposite on purpose.** A daily that catches up after downtime produces a
verdict for a day it did not observe, so it must not: `false`. An alarm that catches up
is still telling the truth — "the run did not happen" does not expire — so it must:
`true`. Whoever makes them agree breaks one of the two.

**Every calendar carries `UTC` explicitly.** This machine's clock is EDT and Debian's
cron (3.0pl1) has no `CRON_TZ`, which is why none of this is a crontab line: a schedule
written in local time silently moves an hour at the DST change, and the lane it is
compared against (`.github/workflows/daily-stable.yml`) is expressed in UTC.

## Install

```sh
cd /root/e2e-qa
cp -r ops/systemd/e2e-daily.service ops/systemd/e2e-daily.timer \
      ops/systemd/e2e-daily-watchdog.service ops/systemd/e2e-daily-watchdog.timer \
      ops/systemd/e2e-mirror-freshness.service ops/systemd/e2e-mirror-freshness.timer \
      /etc/systemd/system/
mkdir -p /etc/systemd/system/e2e-daily.service.d
cp ops/systemd/e2e-daily.service.d/10-target-dist.conf /etc/systemd/system/e2e-daily.service.d/
systemctl daemon-reload
systemctl enable --now e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer
```

The `.service` units carry no `[Install]` section by design: each is pulled by its
timer's `Unit=`, so only the timers are enabled.

## Verify

```sh
for f in e2e-daily.service e2e-daily.timer e2e-daily-watchdog.service \
         e2e-daily-watchdog.timer e2e-mirror-freshness.service e2e-mirror-freshness.timer; do
  diff -q "ops/systemd/$f" "/etc/systemd/system/$f" || echo "$f DIFFERS"
done
diff -q ops/systemd/e2e-daily.service.d/10-target-dist.conf \
        /etc/systemd/system/e2e-daily.service.d/10-target-dist.conf

systemctl show e2e-daily.service -p LoadState -p Wants -p After --value
systemctl list-timers e2e-daily.timer e2e-daily-watchdog.timer e2e-mirror-freshness.timer
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

## What is NOT here yet

- **The wrappers** the units call: `/root/run-daily.sh`, `/root/run-daily-dist.sh`,
  `/root/e2e-daily-watchdog.sh`. They carry the topology — target host, ports, secrets
  path — so versioning them means parameterizing what is machine-specific instead of
  committing it. The units only name them; tracked in #1976.
- **`langflow-tunnel.service`**, which names an internal host by ssh alias and is out of
  the lane since the consolidation served its target locally. It goes with the wrapper
  pass, or with its deletion.
- **Scratch under `/root`** (`chk.sh`, `diag.sh`, `e1-*.sh`, …): rehearsal tooling, not
  configuration. Named here so nobody hunts for it in the repository.
