"""Verify Langflow nightly started cleanly after upgrade with LANGFLOW_LOAD_FLOWS_PATH set."""

import os
import sys

import requests

BASE_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")
EXPECTED_FLOW_NAME = os.environ.get("EXPECTED_FLOW_NAME", "")


def main():
    has_failure = False

    # 1. Health check
    print("── Health check...")
    try:
        r = requests.get(f"{BASE_URL}/health_check", timeout=10)
        r.raise_for_status()
        print(f"   OK: {r.json()}")
    except Exception as e:
        print(f"   FAIL: {e}")
        has_failure = True

    # 2. Auth
    print("── Auto login...")
    token = ""
    try:
        r = requests.get(f"{BASE_URL}/api/v1/auto_login", timeout=10)
        r.raise_for_status()
        token = r.json().get("access_token", "")
        print("   OK: token obtained")
    except Exception as e:
        print(f"   FAIL: {e}")
        has_failure = True

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 3. List flows — the flow loaded via LANGFLOW_LOAD_FLOWS_PATH must still exist
    print("── List flows (checking pre-loaded flow survived upgrade)...")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/flows/", headers=headers, timeout=15)
        r.raise_for_status()
        payload = r.json()
        flows = payload if isinstance(payload, list) else payload.get("flows", [])
        print(f"   OK: {len(flows)} flows found")
        if EXPECTED_FLOW_NAME:
            names = [f.get("name", "") for f in flows]
            if EXPECTED_FLOW_NAME in names:
                print(f"   OK: expected flow '{EXPECTED_FLOW_NAME}' is present")
            else:
                print(f"   FAIL: expected flow '{EXPECTED_FLOW_NAME}' not found. Found: {names}")
                has_failure = True
        elif len(flows) == 0:
            print("   WARN: no flows found after upgrade")
    except Exception as e:
        print(f"   FAIL: {e}")
        has_failure = True

    if has_failure:
        print("\nUpgrade-with-flows verification FAILED.")
        sys.exit(1)
    else:
        print("\nUpgrade-with-flows verification PASSED.")


if __name__ == "__main__":
    main()
