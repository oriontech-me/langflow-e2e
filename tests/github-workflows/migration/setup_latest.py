"""Phase 1: Setup flow on Langflow latest, configure credentials, and execute."""

import os
import sys
import time

from helpers import (
    create_flow,
    create_variable,
    ensure_model_selected,
    find_agent_template,
    get_auth_token,
    get_starter_projects,
    list_variables,
    run_flow_safe,
    save_state,
    load_state,
)


def main():
    state = load_state()
    phase = {"start_time": time.time(), "steps": {}}

    # 1. Authenticate
    print("── Authenticating...")
    token = get_auth_token()
    phase["steps"]["auth"] = {"status": "pass"}
    print("   OK")

    # 2. Get starter projects and find agent template
    print("── Fetching starter projects...")
    projects = get_starter_projects(token)
    print(f"   Found {len(projects)} starter projects")

    template = find_agent_template(projects)
    if not template:
        names = [p.get("name") for p in projects]
        print(f"   ERROR: No agent template found. Available: {names}")
        phase["steps"]["find_template"] = {"status": "fail", "detail": f"Available: {names}"}
        state["phases"]["latest"] = phase
        save_state(state)
        sys.exit(1)

    template_name = template.get("name") or "Migration Test Agent"
    node_types = [
        n.get("data", {}).get("type", "")
        for n in (template.get("data") or {}).get("nodes", [])
    ]
    print(f"   Using template: {template_name} (nodes: {node_types})")
    phase["steps"]["find_template"] = {
        "status": "pass",
        "template_name": template_name,
        "node_types": node_types,
    }

    # 2b. Ensure the model component has a model selected. A starter may ship an
    # empty model_name/provider (the unified Language Model requires an explicit
    # selection — otherwise the build fails "A model selection is required", #905).
    patched = ensure_model_selected(template)
    phase["steps"]["ensure_model"] = {"status": "pass", "patched_nodes": patched}
    if patched:
        print(f"   Patched empty model selection on: {patched}")

    # 3. Create flow from template
    print("── Creating flow...")
    flow = create_flow(token, template)
    flow_id = flow["id"]
    flow_name = flow.get("name", template["name"])
    print(f"   Created flow: {flow_name} (id={flow_id})")
    phase["steps"]["create_flow"] = {"status": "pass", "flow_id": flow_id, "flow_name": flow_name}

    # 4. Ensure the OPENAI_API_KEY variable exists. Since v1.5 Langflow
    # auto-imports the OPENAI_API_KEY env var as a global Credential on startup,
    # so creating it again returns 400 "already exists" (#905). Treat an existing
    # variable as success instead of a warning.
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if openai_key:
        print("── Ensuring OPENAI_API_KEY variable...")
        if any(v.get("name") == "OPENAI_API_KEY" for v in list_variables(token)):
            print("   Already present (auto-imported as a Credential on startup)")
            phase["steps"]["create_variable"] = {
                "status": "pass",
                "detail": "auto-imported",
            }
        else:
            try:
                var = create_variable(token, "OPENAI_API_KEY", openai_key)
                phase["steps"]["create_variable"] = {
                    "status": "pass",
                    "variable_id": var.get("id"),
                }
                print("   Created")
            except Exception as e:
                print(f"   WARNING: Could not create variable: {e}")
                phase["steps"]["create_variable"] = {
                    "status": "warn",
                    "detail": str(e)[:200],
                }
    else:
        print("── OPENAI_API_KEY not set, skipping variable creation")
        phase["steps"]["create_variable"] = {"status": "skip", "detail": "No OPENAI_API_KEY env var"}

    # 5. Execute the flow
    print("── Executing flow on latest...")
    success, detail = run_flow_safe(token, flow_id)
    status = "pass" if success else "fail"
    print(f"   {status.upper()}: {detail[:120]}")
    phase["steps"]["execute_flow"] = {"status": status, "detail": detail}

    # Save state
    phase["end_time"] = time.time()
    phase["duration_s"] = round(phase["end_time"] - phase["start_time"], 1)
    state["flow_id"] = flow_id
    state["flow_name"] = flow_name
    state["phases"]["latest"] = phase
    save_state(state)

    if not success:
        print("\nERROR: Flow execution failed on latest. Cannot establish migration baseline.")
        sys.exit(1)


if __name__ == "__main__":
    main()
