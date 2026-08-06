"""Classify an OpenAI credential failure, and probe the key before the run pays for it.

## Why this exists (#1295)

On run #124 both jobs of `migration-test.yml` died in their **source** phase with

    HTTP 500 … Error building Component Language Model … Error code: 429 -
    {'error': {'message': 'You have no credits remaining. Add credits to continue
    using the API …', 'type': 'insufficient_quota',
    'code': 'credit_balance_exhausted'}}

The account was drained. Three separate things went wrong with how that was
reported, and none of them is about migration:

1. **The witness never ran on the source**, so *nothing* about the migration was
   exercised — no alembic, no Fernet round-trip, no volume. The run carried zero
   migration signal, and the issue it filed was titled *"Langflow Migration Test
   Failed (latest → nightly)"*.
2. **It wrote to the `migration-test` tracker.** The next green run's `Close issue
   on success` step comments *"Migration test passed. Closing this issue."*, so the
   history reads as a migration bug that appeared and got fixed. It never existed.
3. **The pre-flight only checked that the secret was non-empty.** Its own comment
   already makes this argument one level up ("the run only fails 5+ minutes later
   with a misleading error") — a present-but-unusable key reproduced exactly that,
   after installing Langflow (2 min 50 s) and pulling 941 MB of images (1 min 53 s).

So this module answers one question — *is the failure the provider's billing state,
the key itself, or something we should not blame on either?* — for both jobs, and
the workflow routes the report on the answer.

## Fail-open, on purpose

The authoritative verdict on a run is the run. This module is an **attributor and
an optimiser**, not a gate: only `BILLING` and `KEY_ROT` (`BLOCKING`) abort a job
early, and everything it cannot classify is `INCONCLUSIVE` → announced with a
`::warning::` and the run proceeds to reach its own conclusion. Aborting on an
unrecognised 4xx would block the migration test for a reason that has nothing to do
with migration; letting it through costs one run that was going to fail anyway,
with the real cause in the log. A verdict is never silent either way (#1012).

## Divergence from `collect-models.spec.ts`'s `BILLING_OR_QUOTA` (#955)

That regex — the canonical one for this error class — includes a bare `\\b429\\b`.
Here it must not: a plain `rate_limit_exceeded` is also 429, and in
`collect-models` both branches only ever *warn*, so conflating them was free.
Here `BILLING` **aborts the job**, and a rate limit is transient and retryable —
calling it billing would abort a run that would have passed on the next attempt.
So a body that names a rate limit and carries none of the strong billing markers is
`INCONCLUSIVE`, and the run continues. Everything else about the pattern mirrors
`collect-models.spec.ts` (which is TypeScript, so the pattern cannot be shared —
keep the two in sync by hand; both are unit-tested).

Stdlib only: the PR-validation unit lane installs `pytest` and nothing else, so
this module must be importable without `requests`.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Callable, Optional, Tuple

LIVE = "live"
BILLING = "billing"
KEY_ROT = "key-rot"
INCONCLUSIVE = "inconclusive"

# The two verdicts that stop a job before it can produce a migration signal, and
# that route the report away from the `migration-test` tracker.
BLOCKING = (BILLING, KEY_ROT)

MARKER_FILE = os.environ.get("CREDENTIAL_VERDICT_FILE", "/tmp/credential-verdict.json")

DEFAULT_MODEL = os.environ.get("WITNESS_MODEL", "gpt-4o-mini")
COMPLETIONS_URL = os.environ.get(
    "OPENAI_COMPLETIONS_URL", "https://api.openai.com/v1/chat/completions"
)

# Markers that mean "the account cannot pay for this call". `credit_balance_exhausted`
# and `no credits remaining` are OpenAI's 2026-08 wording, measured on the drained
# key that produced #1295.
_STRONG_BILLING = re.compile(
    r"credit[_ ]balance[_ ]exhausted"
    r"|credit balance is too low"
    r"|no credits remaining"
    r"|insufficient[_ ]?quota"
    r"|exceeded your current quota"
    r"|payment required"
    r"|spend(?:ing)?[ _-]?cap"
    r"|\b402\b",
    re.IGNORECASE,
)

# Weaker markers: real for this class, but also present in messages that are not a
# billing state at all — which is why a rate limit is checked first.
_WEAK_BILLING = re.compile(
    r"\bquota\b|resource[_ ]?exhausted|billing",
    re.IGNORECASE,
)

_RATE_LIMIT = re.compile(r"rate[_ ]?limit", re.IGNORECASE)

# Key rot / config: the key is wrong, revoked, or has no access to the model. A real
# defect someone must fix in the repo secret — reported apart from billing because
# the action differs (rotate the secret vs. top up the account).
_KEY_ROT = re.compile(
    r"invalid[_ ]?api[_ ]?key"
    r"|incorrect api key"
    r"|invalid[_ ]authentication"
    r"|\bunauthorized\b"
    r"|model[_ ]not[_ ]found"
    r"|does not (?:exist|have access)"
    r"|permission[_ ]?denied",
    re.IGNORECASE,
)

_HTTP_KEY_ROT_STATUS = (401, 403)

_TITLES = {
    BILLING: "Migration test blocked: OpenAI account has no credits (no migration signal)",
    KEY_ROT: "Migration test blocked: OpenAI key rejected (no migration signal)",
}

_ACTIONS = {
    BILLING: (
        "Top up the OpenAI account (or point the `OPENAI_API_KEY` secret at a funded "
        "one). No code change in this repo can make this run pass."
    ),
    KEY_ROT: (
        "Set or rotate the `OPENAI_API_KEY` repository secret (Settings → Secrets and "
        "variables → Actions) — the current one is missing, rejected, or has no access "
        "to the witness model."
    ),
}

# The label the report is routed to when the verdict is blocking. Kept off
# `migration-test` so a later green run cannot close it with "Migration test
# passed", which would read as a migration bug that never existed.
#
# **Per job, not shared** — the collision PR #793 found on run #101: the two jobs of
# this workflow run in parallel and used one label, so the job that went green closed
# the issue the other had just filed (its `migration-test` failure survived as
# "resolved"). A single `provider-credentials` label would have been a fresh instance
# of that same bug: the compose job reaching the provider says nothing about what the
# API job saw a minute earlier, and vice versa. The cost is that a drained account
# files two issues — one per job — which is noise, but noise that self-clears on the
# next good run, where the alternative silently closes a live blocker.
ISSUE_LABEL_BASE = "provider-credentials"

# The two jobs of `migration-test.yml`, spelled as they appear in `--job`. A closed
# set so a typo in the workflow cannot quietly open a third tracker nobody watches.
JOBS = ("api", "compose")


def issue_label(job: str) -> str:
    if job not in JOBS:
        raise ValueError(f"unknown job {job!r} — expected one of {JOBS}")
    return f"{ISSUE_LABEL_BASE}-{job}"


def classify(status: Optional[int], body: str) -> Tuple[str, str]:
    """Return `(verdict, reason)` for an OpenAI response or an error string.

    `status` is the HTTP status when one is known (the pre-flight probe, or the
    `curl` code the compose job captured) and `None` when the only evidence is text
    — e.g. the migration helper's `"HTTP 500: {…}"` detail, where the provider's own
    429 is quoted *inside* a Langflow 500 body.
    """
    text = body or ""
    snippet = " ".join(text.split())[:300]

    if status is not None and 200 <= status < 300:
        return LIVE, f"HTTP {status} — the key answered a 1-token completion"

    strong_billing = bool(_STRONG_BILLING.search(text))

    # Order matters: a rate limit is 429 too, and aborting the job for it would
    # throw away a run that the next attempt would have completed.
    if _RATE_LIMIT.search(text) and not strong_billing:
        return (
            INCONCLUSIVE,
            f"rate limit, not a billing state — transient, letting the run proceed: {snippet}",
        )

    if strong_billing or _WEAK_BILLING.search(text):
        return BILLING, f"provider billing/quota exhausted: {snippet}"

    if _KEY_ROT.search(text) or status in _HTTP_KEY_ROT_STATUS:
        return KEY_ROT, f"the key was rejected: HTTP {status} {snippet}".strip()

    if status is None:
        return (
            INCONCLUSIVE,
            f"no HTTP status and no recognised credential marker: {snippet}"
            if snippet
            else "no HTTP status and no response text — nothing to attribute",
        )

    if status >= 500:
        return INCONCLUSIVE, f"provider-side HTTP {status} — not a credential verdict: {snippet}"

    return INCONCLUSIVE, f"unrecognised HTTP {status} — not attributed to credentials: {snippet}"


def probe(
    api_key: str,
    model: str = DEFAULT_MODEL,
    url: str = COMPLETIONS_URL,
    timeout: int = 30,
    transport: Optional[Callable[[urllib.request.Request, int], Tuple[int, str]]] = None,
) -> Tuple[str, str]:
    """Spend one token to find out whether the key can be used at all.

    Presence is not usability — that is the whole finding of #1295. `transport` is
    injectable so the unit tests never touch the network; the default sends the
    real request through `urllib` (stdlib, see the module docstring).
    """
    if not api_key:
        return KEY_ROT, "OPENAI_API_KEY is empty — the secret is not configured"

    payload = json.dumps(
        {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
    ).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    send = transport or _send
    try:
        status, body = send(request, timeout)
    except Exception as exc:  # transport failure: no verdict, never a blocking one
        return INCONCLUSIVE, f"could not reach the provider ({type(exc).__name__}: {exc})"

    verdict, reason = classify(status, body)
    return verdict, f"{reason} [model={model}]"


def _send(request: urllib.request.Request, timeout: int) -> Tuple[int, str]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        # The body is where the verdict lives — `insufficient_quota` vs a rate limit
        # are both 429.
        return err.code, err.read().decode("utf-8", "replace")


def marker_payload(verdict: str, reason: str, phase: str, job: str) -> dict:
    return {
        "verdict": verdict,
        "reason": reason,
        "phase": phase,
        "job": job,
        "title": _TITLES.get(verdict, ""),
        "action": _ACTIONS.get(verdict, ""),
        # The workflow's issue step reads this rather than composing it, so the
        # per-job split lives in one place.
        "label": issue_label(job),
    }


def write_marker(
    verdict: str, reason: str, phase: str, job: str, path: str = MARKER_FILE
) -> Optional[str]:
    """Record a blocking verdict for the workflow's issue-routing step.

    Only `BLOCKING` verdicts are written: the file's **presence** is the signal, and
    its absence means "no credential verdict", which keeps the routing default (the
    `migration-test` tracker) untouched for every other failure.
    """
    if verdict not in BLOCKING:
        return None
    with open(path, "w") as handle:
        json.dump(marker_payload(verdict, reason, phase, job), handle, indent=2)
    return path


def step_status(
    detail: str, phase: str, job: str = "api", marker: Optional[str] = None
) -> str:
    """The status a failed flow execution should record: `"blocked"` or `"fail"`.

    The mid-run half of #1295, shared by `setup_latest.py` and
    `verify_migration_api.py` so both call sites are a single line and the decision
    itself is unit-tested. `detail` is the migration helper's `"HTTP 500: {…}"`
    string, where the provider's own error is quoted inside Langflow's — hence no
    status to pass. A blocking verdict is announced and recorded on the way out; any
    other failure keeps its original `"fail"` and this function stays silent.

    `job` defaults to `"api"` because both callers are steps of that job — the compose
    job has no Python and classifies through the CLI.
    """
    verdict, reason = classify(None, detail)
    if verdict not in BLOCKING:
        return "fail"
    print(announce(verdict, reason, phase))
    write_marker(verdict, reason, phase, job, MARKER_FILE if marker is None else marker)
    return "blocked"


def announce(verdict: str, reason: str, phase: str) -> str:
    """The workflow-log line for a verdict. Nothing here is ever silent (#1012)."""
    if verdict == LIVE:
        return f"OpenAI credential probe: live — {reason}"
    if verdict == INCONCLUSIVE:
        return f"::warning::OpenAI credential probe inconclusive ({phase}) — {reason}"
    return (
        f"::error::{_TITLES[verdict]} — {reason}. {_ACTIONS[verdict]} "
        f"This run produced NO migration signal: the witness flow never executed, so "
        f"nothing about the alembic migration or the Fernet round-trip was verified."
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--probe",
        action="store_true",
        help="spend one token on OPENAI_API_KEY before the job installs anything",
    )
    parser.add_argument(
        "--classify-file",
        metavar="PATH",
        help="classify a saved response body (the compose job's /tmp/run-*.json)",
    )
    parser.add_argument("--status", type=int, default=None, help="HTTP status for --classify-file")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--phase", default="pre-flight", help="where the verdict was reached")
    # Required, with no default: which job filed this decides which issue a green run
    # is allowed to close, and a default would hand both jobs the same tracker — the
    # #793 collision (see ISSUE_LABEL_BASE).
    parser.add_argument("--job", required=True, choices=JOBS, help="which job reached the verdict")
    parser.add_argument("--marker", default=MARKER_FILE)
    args = parser.parse_args(argv)

    if args.probe == bool(args.classify_file):
        parser.error("pass exactly one of --probe or --classify-file")

    if args.probe:
        verdict, reason = probe(os.environ.get("OPENAI_API_KEY", ""), model=args.model)
    else:
        try:
            with open(args.classify_file) as handle:
                body = handle.read()
        except OSError as exc:
            # Attribution must never replace the real error with its own crash.
            print(f"::warning::could not read {args.classify_file} ({exc}) — no credential verdict")
            return 0
        verdict, reason = classify(args.status, body)

    print(announce(verdict, reason, args.phase))
    written = write_marker(verdict, reason, args.phase, args.job, args.marker)
    if written:
        print(f"Recorded credential verdict in {written}")

    # `--probe` runs before the job spends anything, so a blocking verdict stops it
    # there. `--classify-file` runs *after* the step that already failed — it only
    # attributes, and must not change that step's exit code.
    if args.probe and verdict in BLOCKING:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
