"""Phase 1: Setup flow on Langflow latest, configure credentials, and execute."""

import os
import sys
import time

from helpers import (
    create_flow,
    create_variable,
    find_agent_template,
    get_auth_token,
    get_starter_projects,
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

    print(f"   Using template: {template['name']}")
    phase["steps"]["find_template"] = {"status": "pass", "template_name": template["name"]}

    # 3. Create flow from template
    print("── Creating flow...")
    flow = create_flow(token, template)
    flow_id = flow["id"]
    flow_name = flow.get("name", template["name"])
    print(f"   Created flow: {flow_name} (id={flow_id})")
    phase["steps"]["create_flow"] = {"status": "pass", "flow_id": flow_id, "flow_name": flow_name}

    # 4. Create OPENAI_API_KEY variable
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if openai_key:
        print("── Creating OPENAI_API_KEY variable...")
        try:
            var = create_variable(token, "OPENAI_API_KEY", openai_key)
            phase["steps"]["create_variable"] = {"status": "pass", "variable_id": var.get("id")}
            print("   OK")
        except Exception as e:
            print(f"   WARNING: Could not create variable: {e}")
            phase["steps"]["create_variable"] = {"status": "warn", "detail": str(e)[:200]}
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
        print("\nWARNING: Flow execution failed on latest, but continuing to test migration.")


if __name__ == "__main__":
    main()
