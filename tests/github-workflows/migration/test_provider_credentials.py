"""Unit tests for the credential verdict that routes the migration report (#1295).

Why these exist: the verdict decides whether a run is reported as a **migration**
failure or as a **provider billing** state, and whether the job is aborted before it
installs Langflow. Both mistakes are expensive in opposite directions — calling a
transient rate limit "billing" throws away a run that would have passed, and calling
a drained account "migration failed" files a bug against Langflow that does not
exist (exactly what run #124 did).

The first test is the real payload from that run, byte for byte.

Run with: pytest tests/github-workflows/migration/test_provider_credentials.py
"""

import json

from . import provider_credentials as pc

# The exact body OpenAI returned on 2026-08-05, reproduced locally against the same
# drained key while diagnosing #1295.
RUN_124_BODY = json.dumps(
    {
        "error": {
            "message": (
                "You have no credits remaining. Add credits to continue using the API "
                "at https://platform.openai.com/settings/organization/billing/."
            ),
            "type": "insufficient_quota",
            "param": None,
            "code": "credit_balance_exhausted",
        }
    }
)

# How that same failure reaches the pip job: the provider's 429 quoted inside a
# Langflow 500, with no HTTP status of its own available to the caller.
RUN_124_DETAIL = (
    'HTTP 500: {"detail":"{\\"message\\":\\"Error running graph: Error building '
    "Component Language Model: \\n\\nError code: 429 - {'error': {'message': 'You have "
    "no credits remaining. Add credits to continue using the API at "
    "https://platform.openai.com/settings/organization/billing/.', 'type': "
    "'insufficient_quota', 'param': None, 'code': 'credit_balance_exhausted'}}\\\"}\"}"
)


def test_run_124_probe_body_is_billing():
    verdict, reason = pc.classify(429, RUN_124_BODY)
    assert verdict == pc.BILLING
    assert "no credits remaining" in reason


def test_run_124_langflow_500_detail_is_billing_without_a_status():
    # The mid-run path: the only evidence is text, and the 500 belongs to Langflow —
    # attributing it to the migration is the #1295 defect.
    verdict, _ = pc.classify(None, RUN_124_DETAIL)
    assert verdict == pc.BILLING


def test_every_strong_billing_marker_stands_on_its_own():
    """Each marker alone must decide `billing`.

    The run #124 payload carries three of them at once (`credit_balance_exhausted`,
    `insufficient_quota`, `no credits remaining`), so a test built only on that body
    passes even after a marker is deleted — measured: removing
    `credit_balance_exhausted` from the pattern changed no test. Providers reword
    these messages (that is the whole #1011 spend-cap lesson), and the next one may
    arrive carrying exactly one.
    """
    for marker in (
        "credit_balance_exhausted",
        "Your credit balance is too low to access the API",
        "You have no credits remaining",
        "insufficient_quota",
        "You exceeded your current quota",
        "Payment Required",
        "monthly spending cap",
        "spend-cap reached",
        "HTTP 402 returned by the provider",
    ):
        verdict, _ = pc.classify(None, marker)
        assert verdict == pc.BILLING, f"{marker!r} must classify as billing on its own"


def test_a_strong_marker_wins_even_over_a_rate_limit_body():
    # The same markers, one at a time, against the branch that would otherwise send
    # them to INCONCLUSIVE and let a drained run continue.
    # `exceeded your current quota` is here for a reason a marker-only test cannot
    # show: `\bquota\b` is *also* a weak marker, so deleting the strong one still
    # yields BILLING everywhere — except against a body that names a rate limit,
    # where the rate-limit branch would then win and a drained account would be
    # waved through as transient. This assertion is the only thing that pins it.
    for marker in (
        "insufficient_quota",
        "no credits remaining",
        "credit_balance_exhausted",
        "You exceeded your current quota",
    ):
        verdict, _ = pc.classify(429, f"Rate limit reached. {marker}")
        assert verdict == pc.BILLING, f"{marker!r} must outrank a rate-limit mention"


def test_anthropic_wording_is_billing_too():
    # collect-models' canonical pattern covers this one; keep the two in sync.
    verdict, _ = pc.classify(400, "Your credit balance is too low to access the Anthropic API")
    assert verdict == pc.BILLING


def test_google_spend_cap_is_billing():
    verdict, _ = pc.classify(429, "Your project has exceeded its monthly spending cap.")
    assert verdict == pc.BILLING


def test_plain_rate_limit_is_inconclusive_not_billing():
    # THE divergence from collect-models.spec.ts's `\b429\b` (see the module
    # docstring): here BILLING aborts the job, and a rate limit is retryable — so it
    # must let the run proceed.
    verdict, reason = pc.classify(
        429,
        json.dumps(
            {
                "error": {
                    "message": (
                        "Rate limit reached for gpt-4o-mini in organization org-x on "
                        "requests per min (RPM): Limit 3, Used 3, Requested 1."
                    ),
                    "type": "rate_limit_exceeded",
                }
            }
        ),
    )
    assert verdict == pc.INCONCLUSIVE
    assert "transient" in reason


def test_a_rate_limit_message_that_also_names_credit_exhaustion_is_billing():
    # Both markers present: the strong billing marker wins, so a drained account
    # cannot hide behind the word "rate limit".
    verdict, _ = pc.classify(
        429, "Rate limit reached. You have no credits remaining. Add credits to continue"
    )
    assert verdict == pc.BILLING


def test_invalid_key_is_key_rot_not_billing():
    verdict, reason = pc.classify(
        401, json.dumps({"error": {"message": "Incorrect API key provided: sk-xxx"}})
    )
    assert verdict == pc.KEY_ROT
    assert "rotate" in pc._ACTIONS[verdict].lower()


def test_no_model_access_is_key_rot():
    verdict, _ = pc.classify(
        403, json.dumps({"error": {"message": "The model `gpt-9` does not exist or you do "
                                              "not have access to it."}})
    )
    assert verdict == pc.KEY_ROT


def test_2xx_is_live_regardless_of_body():
    verdict, reason = pc.classify(200, json.dumps({"choices": [{"message": {"content": "p"}}]}))
    assert verdict == pc.LIVE
    assert "200" in reason


def test_provider_5xx_is_inconclusive():
    verdict, _ = pc.classify(503, "upstream connect error")
    assert verdict == pc.INCONCLUSIVE


def test_unrecognised_4xx_is_inconclusive_so_the_run_still_decides():
    # Fail-open: aborting here would block the migration test for a reason that has
    # nothing to do with migration.
    verdict, reason = pc.classify(400, json.dumps({"error": {"message": "max_tokens is not "
                                                                       "supported"}}))
    assert verdict == pc.INCONCLUSIVE
    assert "400" in reason


def test_empty_evidence_is_inconclusive_and_says_so():
    verdict, reason = pc.classify(None, "")
    assert verdict == pc.INCONCLUSIVE
    assert "nothing to attribute" in reason


def test_blocking_is_exactly_billing_and_key_rot():
    # The routing contract: only these two divert the report off `migration-test`
    # and abort a job early.
    assert set(pc.BLOCKING) == {pc.BILLING, pc.KEY_ROT}
    assert pc.LIVE not in pc.BLOCKING and pc.INCONCLUSIVE not in pc.BLOCKING


# ── probe ────────────────────────────────────────────────────────────────────


def _transport(status, body):
    def send(request, timeout):
        assert request.method == "POST"
        payload = json.loads(request.data.decode())
        assert payload["max_tokens"] == 1, "the probe must not spend more than one token"
        return status, body

    return send


def test_probe_reports_billing_on_the_drained_key():
    verdict, reason = pc.probe("sk-test", transport=_transport(429, RUN_124_BODY))
    assert verdict == pc.BILLING
    assert "model=gpt-4o-mini" in reason


def test_probe_reports_live_on_a_funded_key():
    verdict, _ = pc.probe("sk-test", transport=_transport(200, '{"choices":[]}'))
    assert verdict == pc.LIVE


def test_probe_sends_the_witness_model():
    seen = {}

    def send(request, timeout):
        seen.update(json.loads(request.data.decode()))
        return 200, "{}"

    pc.probe("sk-test", model="gpt-4.1-mini", transport=send)
    # The probe must ask about the model the witness will use — a key with no access
    # to *that* model is a KEY_ROT the run would otherwise discover 3 minutes later.
    assert seen["model"] == "gpt-4.1-mini"


def test_probe_never_sends_the_key_in_the_body():
    def send(request, timeout):
        assert "sk-secret" not in request.data.decode()
        return 200, "{}"

    pc.probe("sk-secret", transport=send)


def test_an_empty_secret_is_key_rot_without_a_request():
    def send(request, timeout):  # pragma: no cover — must not be reached
        raise AssertionError("probe must not call the provider without a key")

    verdict, reason = pc.probe("", transport=send)
    assert verdict == pc.KEY_ROT
    assert "not configured" in reason


def test_a_transport_failure_is_inconclusive_never_blocking():
    def send(request, timeout):
        raise OSError("connection reset")

    verdict, reason = pc.probe("sk-test", transport=send)
    assert verdict == pc.INCONCLUSIVE
    assert "OSError" in reason


# ── marker + announcements ───────────────────────────────────────────────────


def test_marker_is_written_only_for_blocking_verdicts(tmp_path):
    path = tmp_path / "verdict.json"
    assert pc.write_marker(pc.LIVE, "fine", "pre-flight", "api", str(path)) is None
    assert pc.write_marker(pc.INCONCLUSIVE, "unclear", "pre-flight", "api", str(path)) is None
    assert not path.exists(), "absence of the marker is what keeps the default routing"

    assert pc.write_marker(pc.BILLING, "drained", "pre-flight", "api", str(path)) == str(path)
    payload = json.loads(path.read_text())
    assert payload["verdict"] == pc.BILLING
    assert payload["label"] == "provider-credentials-api"
    assert payload["label"] != "migration-test", (
        "routing a billing state to the migration tracker is #1295 — a later green "
        "run would close it with 'Migration test passed'"
    )
    assert payload["job"] == "api"
    assert payload["title"] and payload["action"]


def test_the_two_jobs_get_two_different_trackers(tmp_path):
    """The #793 collision, which a single shared label would have reintroduced.

    Both jobs run in parallel; the one that goes green must not be able to close the
    issue the other just filed, because reaching the provider from the compose job
    says nothing about what the API job saw a minute earlier.
    """
    labels = {job: pc.issue_label(job) for job in pc.JOBS}

    assert labels["api"] != labels["compose"]
    assert set(labels.values()) == {"provider-credentials-api", "provider-credentials-compose"}
    assert "migration-test" not in labels.values()

    for job, label in labels.items():
        path = tmp_path / f"{job}.json"
        pc.write_marker(pc.BILLING, "drained", f"pre-flight/{job}", job, str(path))
        assert json.loads(path.read_text())["label"] == label


def test_an_unknown_job_is_refused_rather_than_given_a_tracker():
    # A typo in the workflow must not open a third tracker nobody watches.
    import pytest

    for job in ("", "API", "pip", "compose-2", None):
        with pytest.raises(ValueError):
            pc.issue_label(job)


def test_a_blocking_announcement_states_there_was_no_migration_signal():
    line = pc.announce(pc.BILLING, "drained", "pre-flight")
    assert line.startswith("::error::")
    assert "NO migration signal" in line


def test_an_inconclusive_announcement_warns_and_does_not_error():
    line = pc.announce(pc.INCONCLUSIVE, "network blip", "pre-flight")
    assert line.startswith("::warning::")
    assert "::error::" not in line


# ── step_status: the mid-run decision both API scripts share ─────────────────


def test_a_billing_detail_records_blocked_and_leaves_a_marker(tmp_path, capsys):
    marker = tmp_path / "verdict.json"

    status = pc.step_status(RUN_124_DETAIL, "latest/execute_flow", marker=str(marker))

    assert status == "blocked"
    assert json.loads(marker.read_text())["phase"] == "latest/execute_flow"
    assert "::error::" in capsys.readouterr().out


def test_both_api_scripts_route_their_execution_failure_through_step_status():
    """Structural, and labelled as such: the alternative needs a live Langflow.

    It cannot tell whether the call site is *correct* — the tests above do that — but
    the realistic regression here is the wiring being dropped while the module keeps
    passing its own tests, and that is exactly what this catches.
    """
    import pathlib

    here = pathlib.Path(__file__).parent
    for name in ("setup_latest.py", "verify_migration_api.py"):
        source = (here / name).read_text()
        assert "credentials.step_status(" in source, (
            f"{name} no longer classifies a failed flow execution — a drained provider "
            f"would be filed as a migration failure again (#1295)"
        )


def test_neither_job_can_touch_the_other_jobs_credential_tracker():
    """Structural, and it pins an ABSENCE — which is the realistic regression here.

    The two jobs of `migration-test.yml` are near-copies of each other, so the way a
    per-job label degrades back into a shared one is a copy-paste between them (that
    is how the collision PR #793 found reached both halves in the first place). Text,
    not YAML parsing: the PR-validation lane installs `pytest` and nothing else, so
    `pyyaml` is not available here.

    It cannot tell whether the routing is *correct* — the tests above do that.
    """
    import pathlib

    workflow = (
        pathlib.Path(__file__).resolve().parents[3] / ".github/workflows/migration-test.yml"
    ).read_text()

    marker = "\n  migration-test-compose:"
    assert marker in workflow, "the compose job header moved — this guard cannot split the file"
    api_half, compose_half = workflow.split(marker, 1)

    for half, own, other in (
        (api_half, "api", "compose"),
        (compose_half, "compose", "api"),
    ):
        assert f"provider-credentials-{other}" not in half, (
            f"the {own} job references the {other} job's credential tracker — a green run "
            f"would close an issue about a failure it never observed (#793)"
        )
        assert f"--job {own}" in half, f"the {own} job does not tell the classifier which job it is"
        assert f"--job {other}" not in half


def test_any_other_failure_still_records_fail_and_says_nothing(tmp_path, capsys):
    marker = tmp_path / "verdict.json"

    # The migration failures this workflow exists to catch must be untouched by the
    # #1295 fix — including the ones whose text mentions a model or a 500.
    for detail in (
        'HTTP 404: {"detail":"Flow identifier 152131bd not found"}',
        'HTTP 500: {"detail":"A model selection is required"}',
        "HTTP 500: cannot decrypt variable (Fernet)",
    ):
        assert pc.step_status(detail, "latest/execute_flow", marker=str(marker)) == "fail", detail

    assert not marker.exists(), "a migration failure must not be filed as a credential state"
    assert capsys.readouterr().out == ""


# ── CLI ──────────────────────────────────────────────────────────────────────


def test_probe_mode_exits_nonzero_on_billing(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(pc, "_send", _transport(429, RUN_124_BODY))
    marker = tmp_path / "verdict.json"

    code = pc.main(["--probe", "--job", "api", "--marker", str(marker)])

    assert code == 1, "a blocking pre-flight must stop the job before it installs anything"
    assert "::error::" in capsys.readouterr().out
    assert marker.exists()


def test_probe_mode_exits_zero_when_inconclusive(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(pc, "_send", _transport(503, "bad gateway"))

    code = pc.main(["--probe", "--job", "api", "--marker", str(tmp_path / "verdict.json")])

    assert code == 0, "fail-open: the run itself is the authoritative verdict"
    assert "::warning::" in capsys.readouterr().out


def test_classify_file_mode_attributes_without_changing_the_exit_code(tmp_path, capsys):
    body = tmp_path / "run-source.json"
    body.write_text(RUN_124_BODY)
    marker = tmp_path / "verdict.json"

    code = pc.main(
        [
            "--classify-file",
            str(body),
            "--status",
            "500",
            "--phase",
            "compose-source",
            "--job",
            "compose",
            "--marker",
            str(marker),
        ]
    )

    # The step that produced this body already failed; attribution must not become a
    # second, competing exit code.
    assert code == 0
    assert json.loads(marker.read_text())["phase"] == "compose-source"
    assert "::error::" in capsys.readouterr().out


def test_an_unreadable_body_file_never_masks_the_real_failure(tmp_path, capsys):
    code = pc.main(["--classify-file", str(tmp_path / "absent.json"), "--job", "compose"])
    assert code == 0
    out = capsys.readouterr().out
    assert "::warning::" in out and "no credential verdict" in out


def test_probe_and_classify_file_are_mutually_exclusive(tmp_path):
    import pytest

    with pytest.raises(SystemExit):
        pc.main(["--probe", "--job", "api", "--classify-file", str(tmp_path / "x.json")])
    with pytest.raises(SystemExit):
        pc.main(["--job", "api"])
    # `--job` itself is required: a default would hand both jobs one tracker (#793).
    with pytest.raises(SystemExit):
        pc.main(["--probe"])
    with pytest.raises(SystemExit):
        pc.main(["--probe", "--job", "pip"])
