"""Unit tests for the migration state file's write contract (#1120).

The bug these lock down: `state["phases"]["nightly_ui"] = results` discarded every
step recorded before it, because `TestMigrationUI.setup` is an autouse fixture and
each test method gets a fresh `self.results`. Run #115 ran six UI tests; the report
showed one row.

Run with: pytest tests/github-workflows/migration/test_state_store.py
"""

import json

import pytest
from . import state_store as ss


def test_steps_from_successive_tests_accumulate():
    """The regression: six tests must leave six steps, not one."""
    state = {"phases": {}}
    for i in range(1, 7):
        state = ss.merge_phase(
            state,
            "nightly_ui",
            {"steps": {f"step_{i}": {"status": "pass"}}, "start_time": 100 + i},
        )

    steps = state["phases"]["nightly_ui"]["steps"]
    assert len(steps) == 6, "each save must ADD, never replace the phase"
    assert sorted(steps) == [f"step_{i}" for i in range(1, 7)]


def test_a_later_test_does_not_erase_an_earlier_failure():
    """The #1120 shape exactly: a failing test followed by a passing one."""
    state = ss.merge_phase(
        {"phases": {}},
        "nightly_ui",
        {"steps": {"execute_flow_ui": {"status": "fail", "detail": "click timeout"}}},
    )
    state = ss.merge_phase(
        state,
        "nightly_ui",
        {"steps": {"execute_flow_api_post_update": {"status": "pass"}}},
    )

    steps = state["phases"]["nightly_ui"]["steps"]
    assert steps["execute_flow_ui"]["status"] == "fail", (
        "the failure must survive a later test's save — erasing it is how the report "
        "lost the only thing that mattered"
    )
    assert steps["execute_flow_api_post_update"]["status"] == "pass"


def test_re_recording_the_same_step_takes_the_newer_value():
    state = ss.merge_phase({"phases": {}}, "p", {"steps": {"s": {"status": "warn"}}})
    state = ss.merge_phase(state, "p", {"steps": {"s": {"status": "fail"}}})

    assert state["phases"]["p"]["steps"]["s"]["status"] == "fail"


def test_duration_spans_the_whole_phase_not_the_last_test():
    state = ss.merge_phase(
        {"phases": {}}, "p", {"steps": {"a": {}}, "start_time": 1000.0, "end_time": 1005.0}
    )
    state = ss.merge_phase(
        state, "p", {"steps": {"b": {}}, "start_time": 1060.0, "end_time": 1070.0}
    )

    phase = state["phases"]["p"]
    assert phase["start_time"] == 1000.0
    assert phase["end_time"] == 1070.0
    assert phase["duration_s"] == 70.0, (
        "run #115 reported 1.7s for a phase that took over a minute, because it kept "
        "only the last test's own runtime"
    )


def test_other_phases_are_untouched():
    state = {
        "flow_id": "abc",
        "phases": {"latest": {"steps": {"auth": {"status": "pass"}}}},
    }
    merged = ss.merge_phase(state, "nightly_ui", {"steps": {"open_flow": {"status": "pass"}}})

    assert merged["phases"]["latest"]["steps"]["auth"]["status"] == "pass"
    assert merged["flow_id"] == "abc", "top-level keys survive"


def test_merge_does_not_mutate_the_input():
    state = {"phases": {"p": {"steps": {"a": {"status": "pass"}}}}}
    ss.merge_phase(state, "p", {"steps": {"b": {"status": "pass"}}})

    assert list(state["phases"]["p"]["steps"]) == ["a"], "callers keep their own copy"


def test_missing_and_malformed_shapes_do_not_raise():
    for state in ({}, {"phases": None}, {"phases": {"p": None}}):
        merged = ss.merge_phase(state, "p", {"steps": {"s": {"status": "pass"}}})
        assert merged["phases"]["p"]["steps"]["s"]["status"] == "pass"

    merged = ss.merge_phase({"phases": {}}, "p", {})
    assert merged["phases"]["p"]["steps"] == {}


def test_save_phase_round_trips_through_the_file(tmp_path):
    path = tmp_path / "state.json"

    ss.save_phase("nightly_ui", {"steps": {"one": {"status": "pass"}}}, state_file=str(path))
    ss.save_phase("nightly_ui", {"steps": {"two": {"status": "fail"}}}, state_file=str(path))

    written = json.loads(path.read_text())
    assert sorted(written["phases"]["nightly_ui"]["steps"]) == ["one", "two"]


def test_save_phase_creates_the_file_when_absent(tmp_path):
    path = tmp_path / "nested-missing.json"
    ss.save_phase("p", {"steps": {"s": {"status": "pass"}}}, state_file=str(path))

    assert json.loads(path.read_text())["phases"]["p"]["steps"]["s"]["status"] == "pass"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
