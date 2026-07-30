"""Unit tests for the migration report's verdict (#1120).

Why these exist: `generate_report.py` produced an issue titled *"Langflow Migration
Test Failed"* whose body said `Result: PASSED` — and nothing in the repo could have
caught it, because this was our own code with no test around it. The reproduction of
run #115 is the first test below.

Run with: pytest tests/github-workflows/migration/test_generate_report.py
"""

from . import generate_report as gr
import pytest

# The shape run #115 actually left behind: `latest` and `nightly_api` fully
# recorded, and `nightly_ui` holding ONE step — the last test that managed to save
# — while the UI step itself had died on a Playwright timeout.
RUN_115_STATE = {
    "flow_id": "3a343fa6-7ba4-41d4-a913-936619fd5f6c",
    "flow_name": "Migration Test Agent",
    "phases": {
        "latest": {
            "duration_s": 4.5,
            "steps": {
                "auth": {"status": "pass"},
                "execute_flow": {"status": "pass", "detail": "Ahoy there, matey!"},
            },
        },
        "nightly_api": {
            "duration_s": 3.7,
            "steps": {
                "flow_exists": {"status": "pass"},
                "execute_flow_api": {"status": "pass"},
            },
        },
        "nightly_ui": {
            "duration_s": 1.7,
            "steps": {"execute_flow_api_post_update": {"status": "pass"}},
        },
    },
}


def test_run_115_is_reported_as_failed_not_passed():
    """The regression this file exists for."""
    verdict = gr.assess(
        RUN_115_STATE,
        {"latest": "success", "nightly_api": "success", "nightly_ui": "failure"},
    )

    assert verdict["result"] == gr.RESULT_FAILED, (
        "a phase the runner says failed must never render as PASSED, however little "
        "it managed to record"
    )
    assert len(verdict["integrity"]) == 1
    assert "nightly_ui" in verdict["integrity"][0]
    assert "crashed before writing its result" in verdict["integrity"][0]


def test_the_old_logic_is_what_this_replaces():
    """Same state, no declared outcomes — the pre-fix behaviour, for contrast.

    Kept deliberately: it documents that scanning for a recorded `fail` is NOT
    sufficient, and that the declared outcomes are the load-bearing input. If the
    workflow ever stops passing them, this is what the report degrades to.
    """
    verdict = gr.assess(RUN_115_STATE, {})

    assert verdict["result"] == gr.RESULT_PASSED
    assert verdict["integrity"] == []


def test_a_recorded_failure_still_fails():
    state = {
        "phases": {
            "nightly_api": {
                "steps": {
                    "variables_preserved": {
                        "status": "fail",
                        "detail": "openai_key_present=False",
                    }
                }
            }
        }
    }
    verdict = gr.assess(state, {"nightly_api": "failure"})

    assert verdict["result"] == gr.RESULT_FAILED
    assert any("variables_preserved" in f for f in verdict["failures"])
    # Attributed, so it is NOT an integrity problem — the phase accounted for itself.
    assert verdict["integrity"] == []


def test_a_declared_failure_that_recorded_its_own_failure_is_not_double_reported():
    state = {"phases": {"p": {"steps": {"s": {"status": "fail", "detail": "boom"}}}}}
    verdict = gr.assess(state, {"p": "failure"})

    assert verdict["result"] == gr.RESULT_FAILED
    assert len(verdict["failures"]) == 1
    assert verdict["integrity"] == []


def test_a_phase_that_ran_but_is_absent_from_the_state_fails():
    state = {"phases": {"latest": {"steps": {"auth": {"status": "pass"}}}}}
    verdict = gr.assess(state, {"latest": "success", "nightly_ui": "success"})

    assert verdict["result"] == gr.RESULT_FAILED
    assert "absent from the state file" in verdict["integrity"][0]
    assert "nightly_ui" in verdict["integrity"][0]


def test_an_empty_state_is_a_failure_not_an_empty_pass():
    """The strongest form of the same bug: nothing ran, everything looked green."""
    for state in ({}, {"phases": {}}, {"phases": None}):
        verdict = gr.assess(state, {})
        assert verdict["result"] == gr.RESULT_FAILED, state
        assert "verified nothing" in verdict["integrity"][0]


def test_a_skipped_phase_is_not_treated_as_missing():
    """`skipped` means the runner never ran it — no claim to reconcile."""
    state = {"phases": {"latest": {"steps": {"auth": {"status": "pass"}}}}}
    verdict = gr.assess(state, {"latest": "success", "nightly_ui": "skipped"})

    assert verdict["result"] == gr.RESULT_PASSED
    assert verdict["integrity"] == []


def test_warnings_alone_pass_with_warnings():
    state = {"phases": {"p": {"steps": {"s": {"status": "warn", "detail": "hmm"}}}}}
    verdict = gr.assess(state, {"p": "success"})

    assert verdict["result"] == gr.RESULT_PASSED_WARN
    assert len(verdict["warnings"]) == 1


def test_an_integrity_problem_outranks_warnings():
    """A warn must never soften an unaccounted phase into "passed with warnings"."""
    state = {"phases": {"p": {"steps": {"s": {"status": "warn"}}}}}
    verdict = gr.assess(state, {"p": "success", "q": "failure"})

    assert verdict["result"] == gr.RESULT_FAILED


def test_declared_outcomes_are_parsed_from_the_env_vocabulary():
    env = {
        "PHASE_OUTCOME_nightly_ui": "failure",
        "PHASE_OUTCOME_latest": "Success",  # GitHub casing varies by expression
        "PHASE_OUTCOME_blank": "   ",
        "PHASE_OUTCOME_": "failure",  # no phase name
        "UNRELATED": "failure",
    }
    assert gr.declared_outcomes(env) == {
        "nightly_ui": "failure",
        "latest": "success",
    }


def test_the_rendered_report_leads_with_the_unaccounted_phase():
    """Placement matters: below the per-step tables is where run #115 hid it."""
    body = gr.generate_report(
        RUN_115_STATE,
        {"latest": "success", "nightly_api": "success", "nightly_ui": "failure"},
    )

    assert "## Result: FAILED" in body
    assert "## Unaccounted phases" in body
    assert body.index("## Unaccounted phases") < body.index("### Phase: latest")
    # The runner's own verdict is shown next to the phase it belongs to.
    assert "runner outcome: `failure`" in body


def test_the_rendered_report_still_lists_every_step():
    body = gr.generate_report(RUN_115_STATE, {})

    for step in ("auth", "execute_flow", "flow_exists", "execute_flow_api_post_update"):
        assert step in body


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
