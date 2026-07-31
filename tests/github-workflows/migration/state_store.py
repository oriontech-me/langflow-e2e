"""The shared migration state file's write contract.

Stdlib only, deliberately: `helpers.py` pulls in `requests`, and this has to be
importable by a unit test on any interpreter.

## Why merging is the contract, not assigning (#1120)

`test_ui_migration.py` used to write its phase with:

```python
state["phases"]["nightly_ui"] = results
```

`TestMigrationUI.setup` is an **autouse fixture**, so pytest builds a fresh
instance per test method and `self.results` starts empty every time. Assigning
therefore discarded every step recorded by the tests before it. Run #115 ran six UI
tests and the report showed **one** row — whichever test happened to save last.

Combined with the report's old habit of reading a missing failure as a pass, that
meant a failing UI phase could neither fail the report nor appear in it.
"""

import json
import os

STATE_FILE = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")


def merge_phase(state: dict, phase: str, results: dict) -> dict:
    """Fold one test's `results` into `state`'s `phase`, keeping what is already there.

    Steps accumulate. `duration_s` spans the phase — earliest start to latest end —
    rather than the last test's own runtime, which is what made run #115's UI phase
    report `1.7s` for a phase that took over a minute.
    """
    state = dict(state or {})
    phases = dict(state.get("phases") or {})
    existing = dict(phases.get(phase) or {})

    steps = dict(existing.get("steps") or {})
    steps.update(results.get("steps") or {})
    existing["steps"] = steps

    starts = [t for t in (existing.get("start_time"), results.get("start_time")) if t is not None]
    ends = [t for t in (existing.get("end_time"), results.get("end_time")) if t is not None]
    if starts:
        existing["start_time"] = min(starts)
    if ends:
        existing["end_time"] = max(ends)
    if starts and ends:
        existing["duration_s"] = round(max(ends) - min(starts), 1)

    phases[phase] = existing
    state["phases"] = phases
    return state


def save_phase(phase: str, results: dict, state_file: str = None) -> dict:
    """Read, merge and write back. Returns the state that was written."""
    path = state_file or STATE_FILE
    try:
        with open(path) as f:
            state = json.load(f)
    except FileNotFoundError:
        state = {"phases": {}}

    merged = merge_phase(state, phase, results)
    with open(path, "w") as f:
        json.dump(merged, f, indent=2)
    return merged
