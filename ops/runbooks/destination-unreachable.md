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
  hours into an outage. It posts once per outage and once on recovery. In between, it
  posts once more if the cause changes: *"QA VM reaches the destination, but its
  credential is refused"* means the network is back and only the VM's credential is
  missing (see *Leaving temporary mode*).
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
# Nothing to save: leaving rebuilds the destination's URL from /root/.e2e-lane.
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
  443"*), and that it fails from the VM only. Check from your own machine before
  you say so.
- **What still works:** other outbound hosts from the VM, such as `github.com`.
- **What it costs:** the daily regression runs without its suite update and without
  its issue.

Link the ticket in the triage issue.

## Leaving temporary mode

Two things must be true, and the alarm tells them apart:

- **The network is back.** The alarm posts one of three messages: *"QA VM reaches the
  destination again"* (network and credential both confirmed), *"QA VM reaches the
  destination on the network again"* (network back, credential not confirmed: check it
  below before leaving), or *"QA VM reaches the destination, but its credential is
  refused"*.
- **The VM has a credential that git over HTTPS and the API accept.** The destination
  no longer takes SSH, and since 2026-11-17 a personal token lasts at most 7 days, so a
  token on the VM is not a fix (#2490). The credential is a GitHub App's, and what the
  VM holds is the App's private key, not a token: an installation token expires one
  hour after it is minted, so the VM has to mint a fresh one before each use. That
  minting does not exist yet (#2518). The third message above means this part is
  missing: stay in temporary mode until it is installed.

**Do not run the block below until #2518 is merged and the VM mints its own token.**
An installation token pasted into `/root/.e2e-secrets` passes both checks, because it
is valid when they run, and is refused within the hour: the next daily would then die
in its credential preflight with temporary mode already gone (#2519).

When both hold, undo step 2 before the next daily. On the VM, as root:

```bash
cd /root/e2e-qa
. /root/.e2e-lane
# HTTPS, built from the lane file. No `.git` suffix (#2332).
dest="https://${ISSUE_HOST:-}/${ISSUE_REPO:-}"
# Both checks run before origin moves. A refused git, or an API credential the check
# reports as refused (exit 3), leaves temporary mode exactly as it was; any other exit
# of the API check proceeds, as the daily does. The API check is the daily's own
# preflight: once the drop-in is gone, a refused API credential stops the daily before
# it tests anything.
if [ -z "${ISSUE_HOST:-}" ] || [ -z "${ISSUE_REPO:-}" ]; then
  echo "ISSUE_HOST or ISSUE_REPO missing from /root/.e2e-lane: stop"
elif ! GIT_TERMINAL_PROMPT=0 git ls-remote "$dest" HEAD >/dev/null; then
  echo "git over HTTPS is refused: the credential is not in place, stay in temporary mode"
elif ( . /root/.e2e-secrets; . /root/.e2e-lane; export ISSUE_HOST ISSUE_REPO GH_TOKEN GITHUB_TOKEN
        node scripts/check-issue-credential.mjs ); [ $? -eq 3 ]; then
  # 3 is the one answer the daily dies on. 2 (could not tell) only warns there, so it
  # does not hold you here either; the line above says which it was.
  echo "the API credential was refused (see the line above): stay in temporary mode"
else
  git remote set-url origin "$dest" \
    && GIT_TERMINAL_PROMPT=0 git pull --ff-only \
    && systemctl try-restart e2e-on-demand-worker.service \
    && rm -f /etc/systemd/system/e2e-daily.service.d/90-destination-unreachable.conf \
    && systemctl daemon-reload \
    && rm -f /root/e2e-qa.origin.before \
    && echo "left temporary mode" \
    || echo "stopped partway: read the line above, fix it, and paste again"
  # Expect no CREATE_ISSUE=0 or AUTO_REMOVE=0 here once it has left.
  systemctl show e2e-daily.service -p Environment | tr ' ' '\n' | grep -E 'CREATE_ISSUE|AUTO_REMOVE'
fi
```

If the pull fails after `set-url`, origin already points at the destination while the
drop-in stays: the daily still runs, and its own pull says why. Fix the pull and paste
the block again; every step is safe to repeat.

Both checks run as root in this shell, which is not quite the daily's environment. If
the git check fails here while the daily's credential is wired somewhere this shell
does not see, the block errs on the safe side and keeps temporary mode. The API check
reads the token as the daily does today, `GITHUB_TOKEN` or `GH_TOKEN` from
`/root/.e2e-secrets`. That only proves a token works at the moment it runs; with the
App, the token is minted from its key, and #2518 decides how this check reads it. The
saved
`/root/e2e-qa.origin.before`, left by outages before #2490, is removed on the way.

Do not restore `/root/e2e-qa.origin.before` if it is there: it holds the SSH URL the
destination no longer accepts.

Then confirm that the next red day opens its umbrella by itself, and close the triage
issue. Leave the alarm installed.
