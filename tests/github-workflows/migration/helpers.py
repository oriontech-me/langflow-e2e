"""Shared helpers for migration test scripts."""

import json
import os
import time

import requests

BASE_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")
STATE_FILE = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")


def get_auth_token() -> str:
    """Get auth token via auto_login."""
    r = requests.get(f"{BASE_URL}/api/v1/auto_login", timeout=10)
    r.raise_for_status()
    data = r.json()
    return data.get("access_token", "")


def api_headers(token: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"phases": {}}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def get_starter_projects(token: str) -> list:
    """Fetch starter project templates."""
    r = requests.get(
        f"{BASE_URL}/api/v1/starter-projects/",
        headers=api_headers(token),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_agent_template(starter_projects: list) -> dict | None:
    """Find 'Simple Agent' or similar agent template."""
    for project in starter_projects:
        name = project.get("name", "").lower()
        if "simple agent" in name or "basic agent" in name:
            return project
    # Fallback: any template with "agent" in the name
    for project in starter_projects:
        name = project.get("name", "").lower()
        if "agent" in name:
            return project
    return None


def create_flow(token: str, template: dict) -> dict:
    """Create a flow from a starter project template."""
    flow_data = {
        "name": template.get("name", "Migration Test Agent"),
        "description": "Auto-created for migration testing",
        "data": template.get("data"),
        "endpoint_name": template.get("endpoint_name"),
    }
    r = requests.post(
        f"{BASE_URL}/api/v1/flows/",
        headers=api_headers(token),
        json=flow_data,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def create_variable(token: str, name: str, value: str, var_type: str = "Credential") -> dict:
    """Create a global variable (credential)."""
    r = requests.post(
        f"{BASE_URL}/api/v1/variables/",
        headers=api_headers(token),
        json={"name": name, "value": value, "type": var_type, "default_fields": []},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def list_variables(token: str) -> list:
    """List all global variables."""
    r = requests.get(
        f"{BASE_URL}/api/v1/variables/",
        headers=api_headers(token),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def get_flow(token: str, flow_id: str) -> dict:
    """Get a flow by ID."""
    r = requests.get(
        f"{BASE_URL}/api/v1/flows/{flow_id}",
        headers=api_headers(token),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def list_flows(token: str) -> list:
    """List all flows."""
    r = requests.get(
        f"{BASE_URL}/api/v1/flows/",
        headers=api_headers(token),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def run_flow(token: str, flow_id: str, message: str = "Hello, what is 2+2?") -> dict:
    """Run a flow via API and return the result."""
    payload = {
        "input_value": message,
        "output_type": "chat",
        "input_type": "chat",
    }
    r = requests.post(
        f"{BASE_URL}/api/v1/run/{flow_id}",
        headers=api_headers(token),
        json=payload,
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def run_flow_safe(token: str, flow_id: str, message: str = "Hello, what is 2+2?") -> tuple[bool, str]:
    """Run a flow and return (success, detail)."""
    try:
        result = run_flow(token, flow_id, message)
        outputs = result.get("outputs", [])
        if outputs:
            first_output = outputs[0]
            results_list = first_output.get("outputs", [])
            if results_list:
                inner = results_list[0]
                msg = inner.get("results", {}).get("message", {})
                text = msg.get("text", str(msg)) if isinstance(msg, dict) else str(msg)
                return True, text[:200]
        return True, f"Flow executed (raw keys: {list(result.keys())})"
    except requests.HTTPError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text[:300]}"
    except Exception as e:
        return False, str(e)[:300]
