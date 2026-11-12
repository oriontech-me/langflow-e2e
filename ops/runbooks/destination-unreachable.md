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
| 3. Network ticket | 24 hours after the outage started, or the second daily in a row in temporary mode, whichever comes first | Open a ticket with the VM's network administrators (below). |
| Ceiling | 5 weekdays without a fix | Take it to the team lead. The question is no longer the network, it is the VM or the migration plan. |

Open a triage issue on this repository when you reach step 2, and record each step
in it. #2422 is the worked example.

## Step 2: temporary mode

Temporary mode makes the daily pull the suite from this public repository and stop
the two things that need the destination: opening the umbrella and removing
`@stable` by itself. On the VM, as root:

```bash
cd /root/e2e-qa
git remote get-url origin > /root/e2e-qa.origin.before   # to restore it later
# Anonymous HTTPS: the VM's SSH key is not authorized here. No `.git` suffix (#2332).
git remote set-url origin https://github.com/oriontech-me/langflow-e2e
GIT_TERMINAL_PROMPT=0 git pull --ff-only

mkdir -p /etc/systemd/system/e2e-daily.service.d
cat > /etc/systemd/system/e2e-daily.service.d/90-destination-unreachable.conf <<'EOF'
[Service]
Environment=CREATE_ISSUE=0
Environment=AUTO_REMOVE=0
EOF
systemctl daemon-reload
systemctl show e2e-daily.service -p Environment | tr ' ' '\n' | grep -E 'CREATE_ISSUE|AUTO_REMOVE'
```

While it lasts:

- **A red day is opened by hand** on the destination, from a machine that reaches it,
  with the labels `daily-failure` and `needs-triage` and a `[Daily Failure]` title.
  The run's material is in `/root/e2e-qa/runs/<run-id>/` on the VM.
- **`@stable` removals go by pull request.**
- **The suite is what this repository's `main` holds.** The mirror-freshness check
  keeps comparing it with the destination's `main`.

> **This fallback has an end date.** It works only while both repositories exist.
> The migration plan archives one of them at stage 6, and after that there is
> nothing to fall back to unless the team keeps a second, private, up-to-date copy.
> That choice is open decision nº 10 of the migration plan. Do not make the fallback
> automatic, and do not use it outside this runbook.

## Step 3: the network ticket

Open it with whoever administers the VM's network. Say:

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
git remote set-url origin "$(cat /root/e2e-qa.origin.before)"
git pull --ff-only
rm /etc/systemd/system/e2e-daily.service.d/90-destination-unreachable.conf
systemctl daemon-reload
```

Then confirm that the next red day opens its umbrella by itself, and close the triage
issue. Leave the alarm installed.
