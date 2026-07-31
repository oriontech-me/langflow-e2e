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


# Node types that need an external input (a file, a vector store, a URL, …) to
# build — a witness flow containing any of these cannot execute headlessly from a
# plain chat message, so it is unusable as a migration baseline (it fails with
# "No files to process" / a missing connection rather than proving the migration).
_DATA_SOURCE_TYPES = {
    "File",
    "AstraDB",
    "SplitText",
    "URLComponent",
    "OpenAIEmbeddings",
    "AstraDBToolComponent",
}

# Model components whose model must be selected for the flow to build.
_MODEL_TYPES = {"OpenAIModel", "LanguageModelComponent"}


def _node_types(project: dict) -> list:
    return [
        n.get("data", {}).get("type", "")
        for n in (project.get("data") or {}).get("nodes", [])
    ]


def find_agent_template(starter_projects: list) -> dict | None:
    """Pick an executable witness flow for the migration baseline.

    Historically this looked for a 'Simple Agent' starter, but Langflow latest
    (1.10.x) ships no agent starter and returns projects with name=null, so the
    old fallback ("first project with data") non-deterministically landed on a
    flow that cannot execute headlessly — a RAG flow whose `Read File` has no
    file, or a `Language Model` flow with no model selected — failing the
    baseline (#905). The witness only needs to be a simple, executable chat flow
    that survives migration, so prefer that shape explicitly.
    """
    def is_simple_chat_flow(project: dict) -> bool:
        types = _node_types(project)
        if not types:
            return False
        # Must have a model component and NO external-input data source.
        has_model = any(t in _MODEL_TYPES for t in types)
        has_data_source = any(t in _DATA_SOURCE_TYPES for t in types)
        return has_model and not has_data_source

    # Pass 0: an agent starter by name (kept for builds that ship one).
    for project in starter_projects:
        name = (project.get("name") or "").lower()
        if "simple agent" in name or "basic agent" in name:
            return project

    # Pass 1: a simple, executable chat flow (model + no external data source).
    for project in starter_projects:
        if is_simple_chat_flow(project):
            return project

    # Pass 2: any agent-named starter.
    for project in starter_projects:
        name = (project.get("name") or "").lower()
        if "agent" in name:
            return project

    # Pass 3: any project that has flow data (last resort).
    for project in starter_projects:
        if project.get("data"):
            return project

    return None


def ensure_model_selected(
    template: dict,
    model: str = "gpt-4o-mini",
    provider: str = "OpenAI",
    api_key_var: str = "OPENAI_API_KEY",
) -> list:
    """Patch model components so the witness flow can build.

    A starter's model component ships with no model selected, and the build fails
    with "A model selection is required" (#905). Fill the selection in place so
    the flow is executable. Returns the list of node types that were patched (for
    reporting). Non-empty fields are left untouched.

    **Fill the unified selector, not the legacy overrides (#1004).** Since 1.11.1
    `LanguageModelComponent` carries a required `model` field (`type: model`,
    `input_types: ['LanguageModel']`) and demotes `provider` / `model_name` to
    advanced *overrides* of it. Writing the overrides while `model` stays empty is
    rejected at build time:

        Error running method "text_response": Model name/provider overrides
        require a built-in model selection, not a connected model object.

    which is what broke the baseline every day from 2026-07-23 (#1004). Measured
    against `langflow:1.11.1` and `langflow-nightly:1.12.0.dev9`, both of which
    ship the same node shape: `model` as a plain string builds and runs; a
    `{provider, model_name}` dict fails with "A model selection is required"; the
    legacy-overrides-only patch reproduces the #1004 error. So when the selector
    exists, set it and leave the overrides alone; the legacy branch stays for
    builds that predate it (e.g. `OpenAIModel`).
    """
    patched = []
    for node in (template.get("data") or {}).get("nodes", []):
        data = node.get("data", {})
        if data.get("type") not in _MODEL_TYPES:
            continue
        tmpl = data.get("node", {}).get("template", {})
        changed = False
        if "model" in tmpl:
            if not tmpl["model"].get("value"):
                tmpl["model"]["value"] = model
                changed = True
        else:
            if "provider" in tmpl and not tmpl["provider"].get("value"):
                tmpl["provider"]["value"] = provider
                changed = True
            if "model_name" in tmpl and not tmpl["model_name"].get("value"):
                tmpl["model_name"]["value"] = model
                changed = True
        # The api_key field takes the NAME of the global Credential (Langflow
        # auto-imports OPENAI_API_KEY on startup). Harmless alongside the unified
        # selector — verified building both with and without it.
        if "api_key" in tmpl and not tmpl["api_key"].get("value"):
            tmpl["api_key"]["value"] = api_key_var
            changed = True
        if changed:
            patched.append(data.get("type"))
    return patched


def create_flow(token: str, template: dict) -> dict:
    """Create a flow from a starter project template."""
    flow_data = {
        "name": template.get("name") or "Migration Test Agent",
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
