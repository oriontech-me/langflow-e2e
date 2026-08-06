"""Generate a markdown migration test report from the collected state.

## Why the verdict is not just "did anything record a failure" (#1120)

Run #115 opened an issue titled *"Langflow Migration Test Failed"* whose body said
**`Result: PASSED`**, with every listed step green. Both were accurate about what
they measured, and that is the defect:

- `Verify migration via UI (Playwright)` failed — `test_05_execute_flow_ui` died on
  a 30 s `Locator.click` timeout.
- A pytest test that **crashes** never reaches its own `_save_results()`, so it
  writes **no** `fail` entry. The old verdict scanned the state file for a `fail`
  status, found none, and printed `Result: PASSED`.

So the report read the **absence of a failure record as evidence of success** — and
the one situation where the report matters most is exactly the one that records
nothing. A reader who trusts the first line of the body draws the opposite of the
truth.

The fix is to stop inferring. The workflow now tells this script the outcome of
each verification step (`PHASE_OUTCOME_<phase>`), and the script **reconciles** that
against what the phase actually recorded. A phase the runner says failed, that
recorded no failure, is reported as a crash — never as a pass. A phase that was
supposed to run and is missing from the state entirely is reported as incomplete.
Nothing here can conclude "passed" from missing data.

## Why the job's own status is reconciled too (#1141)

Only three steps carry an `id`, so `PHASE_OUTCOME_*` covers only the three
verification phases. The steps **between** them — resolving, installing, booting
the nightly, and waiting out the alembic migration — carry none, and a failure
there reproduced the #1120 symptom by a different route: the job goes red, phases 2
and 3 never run (so their outcomes arrive empty and are not declared), the state
file holds a fully-passing `latest` phase, and the report printed `Result: PASSED`
into an issue titled *"Failed"*. A migration that never completes is precisely what
this workflow exists to catch, and it landed in that gap.

So the workflow also hands over `JOB_STATUS` (`job.status`). A red job whose report
found nothing wrong is itself an integrity problem: the failure is real and lives
outside every phase this report can see. Reconciling the job status covers the
steps that exist today *and* any added later, which per-step `id`s would not.

## Why `blocked` is not `fail` (#1295)

A step whose only problem is that the provider stopped paying measured **nothing**
about the migration. Run #124 reported `Result: FAILED` under the title *"Langflow
Migration Test Failed (latest → nightly)"* when the witness flow had never executed
on the source — a drained OpenAI account, quoted inside a Langflow 500. So a step
that `provider_credentials.classify()` attributes to billing or key rot records
`blocked`, and the verdict becomes `BLOCKED` — red, never green (there is no
migration signal to be had, so this must not read as a pass), but not a claim about
Langflow. A real migration failure alongside it still wins the verdict: `blocked`
only decides the wording when it is the *only* thing wrong.

`blocked` also counts as an accounted failure in the #1120 reconciliation above.
Without that, a phase the runner saw fail whose only bad step was `blocked` would be
reported as "crashed before writing its result" — the exact false verdict that
mechanism exists to prevent, arriving through the fix for another one.
"""

import json
import os
from datetime import datetime, timezone
# `Optional`, not `dict | None`: CI runs 3.12 but the file is also imported by the
# unit tests on whatever interpreter a developer has, and macOS still ships 3.9.
from typing import Optional

STATE_FILE = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")
REPORT_FILE = os.environ.get("REPORT_FILE", "/tmp/migration-report.md")
# Written by `provider_credentials.py` when the pre-flight probe (or a mid-run
# classification) attributes the failure to the provider's billing state or the key
# itself. Read here because the pre-flight aborts BEFORE any phase runs, so the state
# file is empty and the report would otherwise say "verified nothing" without saying
# why (#1295).
CREDENTIAL_VERDICT_FILE = os.environ.get("CREDENTIAL_VERDICT_FILE", "/tmp/credential-verdict.json")

STATUS_ICON = {
    "pass": "PASS",
    "fail": "FAIL",
    "warn": "WARN",
    "skip": "SKIP",
    "blocked": "BLOCK",
}

# Statuses that mean the step did not do what it was there to do. `blocked` is one of
# them for the #1120 reconciliation (a phase owning a blocked step is accounted for),
# while carrying a different verdict — see the module docstring.
NOT_OK_STATUSES = ("fail", "blocked")

# Per-phase step outcomes handed in by the workflow, as
# `PHASE_OUTCOME_<phase>=success|failure|skipped|cancelled` — GitHub's
# `steps.<id>.outcome` vocabulary, passed straight through.
PHASE_OUTCOME_PREFIX = "PHASE_OUTCOME_"

# The job's own status at the time the report is generated, from `job.status`
# (`success|failure|cancelled`). The report step runs under `if: always()`, so this
# is the runner's verdict on everything that happened before it — including the
# steps no `PHASE_OUTCOME_*` covers.
JOB_STATUS_VAR = "JOB_STATUS"
JOB_STATUS_NOT_OK = {"failure", "cancelled"}

RESULT_FAILED = "FAILED"
RESULT_PASSED = "PASSED"
RESULT_PASSED_WARN = "PASSED (with warnings)"
RESULT_BLOCKED = "BLOCKED (provider credentials — no migration signal)"


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"phases": {}}


def load_credential_verdict(path: Optional[str] = None) -> Optional[dict]:
    """The credential verdict for this run, or `None` when there is none.

    Absence is the normal case and must leave every other verdict untouched — a
    malformed or unreadable marker is treated the same way, because a crash here
    would replace the report with its own failure.
    """
    try:
        with open(CREDENTIAL_VERDICT_FILE if path is None else path) as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or not payload.get("verdict"):
        return None
    return payload


def load_digest(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "unknown"


def declared_outcomes(environ=None) -> dict:
    """Phase name → runner outcome, from the `PHASE_OUTCOME_<phase>` variables."""
    env = os.environ if environ is None else environ
    out = {}
    for key, value in env.items():
        if not key.startswith(PHASE_OUTCOME_PREFIX):
            continue
        phase = key[len(PHASE_OUTCOME_PREFIX) :]
        if phase and value and value.strip():
            out[phase] = value.strip().lower()
    return out


def job_status(environ=None) -> Optional[str]:
    """The runner's verdict on the job so far, from `JOB_STATUS`. `None` if unset."""
    env = os.environ if environ is None else environ
    value = (env.get(JOB_STATUS_VAR) or "").strip().lower()
    return value or None


def assess(
    state: dict,
    declared: dict,
    job: Optional[str] = None,
    credential: Optional[dict] = None,
) -> dict:
    """Decide the overall result, and surface anything that makes the report untrustworthy.

    Returns `{"result", "failures", "warnings", "integrity", "blocked"}`. `integrity` holds
    mismatches between what the runner observed and what the phase recorded — the
    #1120 class. Those count as failures: a report that cannot account for a phase
    must not claim that phase passed.

    `job` is the runner's verdict on the whole job (`job.status`). It catches the
    #1141 case: a failure in a step no phase covers, which otherwise left the report
    saying `PASSED` on a red run.

    `credential` is the marker `provider_credentials.py` leaves behind (#1295). It is
    the only attribution available when the **pre-flight** aborts, since no phase has
    run at that point and the state file is empty.
    """
    phases = state.get("phases", {}) or {}

    failures = []
    warnings = []
    integrity = []
    blocked = []

    for phase_name, phase_data in phases.items():
        for step_name, step_data in (phase_data.get("steps", {}) or {}).items():
            status = (step_data or {}).get("status")
            detail = str((step_data or {}).get("detail", "no detail"))[:200]
            if status == "fail":
                failures.append(f"- **{phase_name}/{step_name}**: {detail}")
            elif status == "blocked":
                blocked.append(f"- **{phase_name}/{step_name}**: {detail}")
            elif status == "warn":
                warnings.append(f"- **{phase_name}/{step_name}**: {detail}")

    for phase_name, outcome in sorted(declared.items()):
        recorded_steps = (phases.get(phase_name) or {}).get("steps", {}) or {}
        recorded_fail = any(
            (s or {}).get("status") in NOT_OK_STATUSES for s in recorded_steps.values()
        )

        if outcome == "failure" and not recorded_fail:
            # The #1120 case: the step died before it could write its own verdict.
            integrity.append(
                f"- **{phase_name}**: the runner reports this phase FAILED, but it recorded no "
                f"failing step — it crashed before writing its result "
                f"({len(recorded_steps)} step(s) recorded). Read the job log for the real cause; "
                f"this report cannot attribute it."
            )
        elif outcome in {"success", "failure"} and phase_name not in phases:
            integrity.append(
                f"- **{phase_name}**: the runner ran this phase (outcome `{outcome}`) but it is "
                f"absent from the state file, so nothing about it was verified."
            )

    # The pre-flight abort: the credential verdict is the whole story, and there are
    # no phases to attach it to.
    if credential:
        where = credential.get("phase") or "pre-flight"
        blocked.append(
            f"- **{where}**: {credential.get('reason') or credential.get('verdict')}"
        )
        action = credential.get("action")
        if action:
            blocked.append(f"- **What to do**: {action}")

    # A state file with no phases at all is the strongest form of the same problem:
    # it used to render as a clean PASS. Skipped when the credential verdict already
    # attributes the run — same rule as the #1141 branch below, which stays quiet once
    # something else owns the cause.
    if not phases and not credential:
        integrity.append(
            "- **(all phases)**: the state file records no phases at all, so this report "
            "verified nothing. Treated as a failure rather than an empty pass."
        )

    # #1141: the job is red but nothing above accounts for it — the failing step is
    # one this report does not cover. Only reported when there is no attribution yet;
    # a phase that already owns the failure says it better than this can.
    if job in JOB_STATUS_NOT_OK and not failures and not integrity and not blocked:
        integrity.append(
            f"- **(outside every phase)**: the runner reports this job `{job}`, but no "
            f"verification phase recorded or was declared a failure — so the cause is a "
            f"step this report does not cover (resolving, installing or booting the "
            f"nightly, or the alembic migration timing out). Read the job log; this "
            f"report cannot attribute it."
        )

    # A real failure outranks a blocked step: if anything about the migration itself
    # went wrong, that is the verdict, and the credential state is a footnote.
    if failures or integrity:
        result = RESULT_FAILED
    elif blocked:
        result = RESULT_BLOCKED
    elif warnings:
        result = RESULT_PASSED_WARN
    else:
        result = RESULT_PASSED

    return {
        "result": result,
        "failures": failures,
        "warnings": warnings,
        "integrity": integrity,
        "blocked": blocked,
    }


def format_step(name: str, step: dict) -> str:
    icon = STATUS_ICON.get(step.get("status", ""), "?")
    line = f"| {icon} | {name} |"
    detail = step.get("detail", "")
    if not detail:
        # Build detail from other fields
        extras = {k: v for k, v in step.items() if k != "status"}
        if extras:
            detail = ", ".join(f"{k}={v}" for k, v in extras.items() if v is not None)
    line += f" {detail[:120]} |"
    return line


def generate_report(
    state: dict,
    declared: Optional[dict] = None,
    job: Optional[str] = None,
    credential: Optional[dict] = None,
) -> str:
    if declared is None:
        declared = declared_outcomes()
    if job is None:
        job = job_status()
    if credential is None:
        credential = load_credential_verdict()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    latest_digest = load_digest("/tmp/latest-digest.txt")
    nightly_digest = load_digest("/tmp/nightly-digest.txt")

    verdict = assess(state, declared, job, credential)

    lines = [
        "# Langflow Migration Test Report",
        f"**Date:** {now}",
        f"**Flow:** {state.get('flow_name', 'N/A')} (`{state.get('flow_id', 'N/A')}`)",
        f"**Latest digest:** `{latest_digest[-20:]}`",
        f"**Nightly digest:** `{nightly_digest[-20:]}`",
    ]
    # Stated in the header so a reader comparing the issue title to the body can see
    # both verdicts at once — the pair that contradicted each other in #1120/#1141.
    if job:
        lines.append(f"**Job status (runner):** `{job}`")
    lines += [
        "",
        f"## Result: {verdict['result']}",
        "",
    ]

    # Right under the verdict, because it is the reason the verdict cannot be
    # trusted at face value — burying it below the per-step tables is how run #115
    # read as a pass.
    if verdict["integrity"]:
        lines.append("## Unaccounted failures")
        lines.append("")
        lines.extend(verdict["integrity"])
        lines.append("")

    # Also right under the verdict, and for the same reason: a reader who stops after
    # the first screen must not walk away thinking Langflow's migration broke (#1295).
    if verdict["blocked"]:
        lines.append("## Blocked on provider credentials — not a migration verdict")
        lines.append("")
        lines.append(
            "The witness flow could not reach the model provider, so **nothing about "
            "the migration was measured** by the step(s) below. Fix the account or the "
            "key, then re-run; no change in this repo can make this pass."
        )
        lines.append("")
        lines.extend(verdict["blocked"])
        lines.append("")

    for phase_name, phase_data in state.get("phases", {}).items():
        duration = phase_data.get("duration_s", "?")
        outcome = declared.get(phase_name)
        suffix = f" — runner outcome: `{outcome}`" if outcome else ""
        lines.append(f"### Phase: {phase_name} ({duration}s){suffix}")
        lines.append("")
        lines.append("| Status | Step | Detail |")
        lines.append("|--------|------|--------|")

        for step_name, step_data in (phase_data.get("steps", {}) or {}).items():
            lines.append(format_step(step_name, step_data))

        lines.append("")

    if verdict["failures"]:
        lines.append("## Failures")
        lines.extend(verdict["failures"])
        lines.append("")

    if verdict["warnings"]:
        lines.append("## Warnings")
        lines.extend(verdict["warnings"])
        lines.append("")

    return "\n".join(lines)


def main():
    state = load_state()
    report = generate_report(state)

    with open(REPORT_FILE, "w") as f:
        f.write(report)

    print(report)


if __name__ == "__main__":
    main()
