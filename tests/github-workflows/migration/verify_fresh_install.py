"""Verify Langflow is functional after a fresh PostgreSQL install."""

import os
import sys

import requests

BASE_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")


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

    # 3. List flows
    print("── List flows...")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/flows/", headers=headers, timeout=15)
        r.raise_for_status()
        flows = r.json()
        print(f"   OK: {len(flows)} flows found")
    except Exception as e:
        print(f"   FAIL: {e}")
        has_failure = True

    # 4. Starter projects loaded
    print("── Starter projects...")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/starter-projects/", headers=headers, timeout=30)
        r.raise_for_status()
        projects = r.json()
        print(f"   OK: {len(projects)} starter projects")
        if len(projects) == 0:
            print("   WARN: no starter projects found")
    except Exception as e:
        print(f"   FAIL: {e}")
        has_failure = True

    if has_failure:
        print("\nFresh install verification FAILED.")
        sys.exit(1)
    else:
        print("\nFresh install verification PASSED.")


if __name__ == "__main__":
    main()
