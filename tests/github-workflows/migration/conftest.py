"""Playwright fixtures for Langflow UI migration tests."""

import json
import os

import pytest


@pytest.fixture(scope="session")
def langflow_url():
    return os.environ.get("LANGFLOW_URL", "http://localhost:7860")


@pytest.fixture(scope="session")
def state():
    state_file = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")
    with open(state_file) as f:
        return json.load(f)


@pytest.fixture(scope="session")
def flow_id(state):
    fid = state.get("flow_id")
    assert fid, "No flow_id in state file — setup_latest.py must run first"
    return fid
