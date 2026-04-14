"""Phase 3a: Verify migration preserved the flow, variables, and execution works via API."""

import sys
import time

from helpers import (
    get_auth_token,
    get_flow,
    list_flows,
    list_variables,
    load_state,
    run_flow_safe,
    save_state,
)


def main():
    state = load_state()
    flow_id = state.get("flow_id")
    if not flow_id:
        print("ERROR: No flow_id in state. Did setup_latest.py run?")
        sys.exit(1)

    phase = {"start_time": time.time(), "steps": {}}
    has_failure = False

    # 1. Authenticate on nightly
    print("── Authenticating on nightly...")
    token = get_auth_token()
    phase["steps"]["auth"] = {"status": "pass"}
    print("   OK")

    # 2. Check flow still exists
    print(f"── Checking flow {flow_id} exists after migration...")
    try:
        flow = get_flow(token, flow_id)
        flow_name = flow.get("name", "unknown")
        print(f"   OK: Flow '{flow_name}' exists")
        phase["steps"]["flow_exists"] = {"status": "pass", "flow_name": flow_name}
    except Exception as e:
        print(f"   FAIL: {e}")
        phase["steps"]["flow_exists"] = {"status": "fail", "detail": str(e)[:300]}
        has_failure = True

    # 3. Check all flows are listed
    print("── Listing all flows...")
    try:
        flows = list_flows(token)
        flow_names = [f.get("name") for f in flows]
        print(f"   Found {len(flows)} flows: {flow_names}")
        phase["steps"]["list_flows"] = {"status": "pass", "count": len(flows), "names": flow_names}
    except Exception as e:
        print(f"   FAIL: {e}")
        phase["steps"]["list_flows"] = {"status": "fail", "detail": str(e)[:300]}
        has_failure = True

    # 4. Check variables preserved
    print("── Checking variables...")
    try:
        variables = list_variables(token)
        var_names = [v.get("name") for v in variables]
        print(f"   Found {len(variables)} variables: {var_names}")
        has_openai = "OPENAI_API_KEY" in var_names
        if has_openai:
            print("   OK: OPENAI_API_KEY preserved")
        else:
            print("   WARN: OPENAI_API_KEY not found in variables")
        phase["steps"]["variables_preserved"] = {
            "status": "pass" if has_openai else "warn",
            "count": len(variables),
            "names": var_names,
            "openai_key_present": has_openai,
        }
    except Exception as e:
        print(f"   FAIL: {e}")
        phase["steps"]["variables_preserved"] = {"status": "fail", "detail": str(e)[:300]}
        has_failure = True

    # 5. Execute flow on nightly via API
    print("── Executing flow on nightly via API...")
    success, detail = run_flow_safe(token, flow_id)
    status = "pass" if success else "fail"
    print(f"   {status.upper()}: {detail[:120]}")
    phase["steps"]["execute_flow_api"] = {"status": status, "detail": detail}
    if not success:
        has_failure = True

    # Save state
    phase["end_time"] = time.time()
    phase["duration_s"] = round(phase["end_time"] - phase["start_time"], 1)
    phase["overall"] = "fail" if has_failure else "pass"
    state["phases"]["nightly_api"] = phase
    save_state(state)

    if has_failure:
        print("\nSome API migration checks FAILED.")
        sys.exit(1)
    else:
        print("\nAll API migration checks PASSED.")


if __name__ == "__main__":
    main()
