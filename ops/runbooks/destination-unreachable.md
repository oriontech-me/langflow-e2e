# Runbook: the QA VM cannot reach the destination

The destination is the host the VM lane's daily pulls its suite from and opens its
umbrella on. It is `ISSUE_HOST` in `/root/.e2e-lane` on the VM; this repository is
public, so the host is not written here.

When the VM cannot reach it, the daily still runs, but it tests the suite it already
has, and a red day opens no umbrella. That is what happened in #2422, and in #2330
with a refused credential instead of a closed port.

## How you find out

- **The hourly alarm** (`e2e-destination-reachability.timer`) posts
  *"QA VM cannot reach the destination"* after 3 failed checks in a row, about 3
  hours into an outage. It posts once per outage and once on recovery.
- **The pre-daily check** (`e2e-destination-reachability-announce.timer`, 07:30 UTC
  on weekdays) posts if the destination is down at that moment. While an outage
  lasts, this is its daily reminder.
- **Without either:** a daily that ran an old suite and opened no umbrella.

The alarm's script, its threshold and how it was measured are in
`scripts/destination-reachability-alarm.sh`.

## The steps and their deadlines

The clock is the daily (Monday to Friday, 08:00 UTC). Until the daily runs, an outage
costs nothing. Only weekdays count: an outage that starts on Saturday becomes a step
on Monday at 07:30 UTC.

| Step | Starts when | What to do |
|---|---|---|
| 1. Wait | The alarm posts | Nothing. The short outages measured so far lasted about 2 hours and cleared by themselves. |
| 2. Temporary mode | The 07:30 UTC check says it is still down | Enter temporary mode before the 08:00 UTC daily (below). |
| 3. Network ticket | 24 hours after the outage started, or the second daily in a row in temporary mode, whichever comes first | First check whether the destination's own outage was announced. If it was, open no ticket. Otherwise, open one with the VM's network administrators (below). |
| Ceiling | 5 weekdays without a fix | Take it to the team lead. The question is no longer the network, it is the VM or the migration plan. |

Open a triage issue on this repository when you reach step 2, and record each step
in it. #2422 is the worked example.

## Step 2: temporary mode

Temporary mode makes the daily pull the suite from this public repository. It also
turns off opening the umbrella, which needs the destination, and removing `@stable`
by itself, which would happen with no umbrella to tell anyone. On the VM, as root:

```bash
cd /root/e2e-qa
# Saved once, to restore it later. Safe to paste again: a second run, or a second
# outage, never overwrites the saved destination with the public URL.
[ -s /root/e2e-qa.origin.before ] || git remote get-url origin > /root/e2e-qa.origin.before
cat /root/e2e-qa.origin.before   # must be the destination, not github.com
# Anonymous HTTPS: the VM's SSH key is not authorized here. No `.git` suffix (#2332).
git remote set-url origin https://github.com/oriontech-me/langflow-e2e
GIT_TERMINAL_PROMPT=0 git pull --ff-only
# The daily restarts the on-demand worker only when its own pull moves HEAD. This
# pull came first, so restart it here, or it keeps running the old code.
systemctl try-restart e2e-on-demand-worker.service

mkdir -p /etc/systemd/system/e2e-daily.service.d
cat > /etc/systemd/system/e2e-daily.service.d/90-destination-unreachable.conf <<'EOF'
[Service]
Environment=CREATE_ISSUE=0
Environment=AUTO_REMOVE=0
EOF
systemctl daemon-reload
systemctl show e2e-daily.service -p Environment | tr ' ' '\n' | grep -E 'CREATE_ISSUE|AUTO_REMOVE'
# The daily sources these two files after the unit's environment. Expect no output,
# or an assignment there beats the drop-in.
grep -nE '^(export )?(CREATE_ISSUE|AUTO_REMOVE)=' /root/.e2e-secrets /root/.e2e-lane
```

The next daily's log should show
`WARNING: switches overridden by the unit's environment: CREATE_ISSUE=0 AUTO_REMOVE=0`.

While it lasts:

- **A red day is opened by hand** on the destination, from a machine that reaches it,
  with the labels `daily-failure` and `needs-triage` and a `[Daily Failure]` title.
  The run's material is in `/root/e2e-qa/runs/<run-id>/` on the VM.
- **`@stable` removals go by pull request.**
- **The suite is what this repository's `main` holds.** The mirror-freshness check
  reads `UNKNOWN` the whole time: origin is now this repository, so it has nothing
  to compare. That line carries no information until you leave temporary mode.

> **This fallback has an end date.** It works only while both repositories exist.
> The migration plan archives one of them at stage 6, and after that there is
> nothing to fall back to unless the team keeps a second, private, up-to-date copy.
> That choice is open decision nº 10 of the migration plan. Do not make the fallback
> automatic, and do not use it outside this runbook.

## Step 3: the network ticket

**First, rule out an outage of the destination itself.** Check the destination's
announcement channel, and try the destination from a machine outside the VM. If the
destination's operators have announced an outage, or it fails from outside the VM
too, the network is not the problem and a ticket only adds noise. Then stay in
temporary mode, record the announcements in the triage issue, and keep the 5-weekday
ceiling. This is what happened in #2422: the first look pointed at the network, and
the destination's operators then announced that it was down, with no ETA.

Only if the destination answers from outside the VM and no outage was announced,
open a ticket with whoever administers the VM's network. Say:

- **Since when:** the time of the first failed check, from the alarm's message or
  `~/.local/state/langflow-e2e/destination-reachability.history` on the VM.
- **What fails:** the alarm's reason line (for example *"no connection on port(s)
  22 443"*), and that it fails from the VM only. Check from your own machine before
  you say so.
- **What still works:** other outbound hosts from the VM, such as `github.com`.
- **What it costs:** the daily regression runs without its suite update and without
  its issue.

Link the ticket in the triage issue.

## Leaving temporary mode

When the alarm posts *"QA VM reaches the destination again"*, undo step 2 before the
next daily. On the VM, as root:

```bash
cd /root/e2e-qa
before="$(cat /root/e2e-qa.origin.before)"
case "$before" in
  ''|*github.com/oriontech-me/*) echo "saved origin is '$before': not the destination, stop" ;;
  *) git remote set-url origin "$before" \
       && git pull --ff-only \
       && systemctl try-restart e2e-on-demand-worker.service \
       && rm /etc/systemd/system/e2e-daily.service.d/90-destination-unreachable.conf \
       && systemctl daemon-reload \
       && rm /root/e2e-qa.origin.before ;;
esac
```

If it stops, set origin by hand to the destination's SSH URL (the host is
`ISSUE_HOST` and the repository is `ISSUE_REPO` in `/root/.e2e-lane`).

Then confirm that the next red day opens its umbrella by itself, and close the triage
issue. Leave the alarm installed.
