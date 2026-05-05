"""Wait for Langflow to be healthy."""

import argparse
import sys
import time

import os

import requests

BASE_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")


def wait_for_langflow(timeout: int = 120) -> bool:
    start = time.time()
    print(f"Waiting for Langflow at {BASE_URL} (timeout: {timeout}s)")

    while time.time() - start < timeout:
        try:
            r = requests.get(f"{BASE_URL}/health_check", timeout=5)
            if r.status_code == 200:
                elapsed = time.time() - start
                print(f"Langflow is healthy after {elapsed:.1f}s")
                return True
        except requests.ConnectionError:
            pass
        except Exception as e:
            print(f"  Unexpected error: {e}")

        remaining = timeout - (time.time() - start)
        print(f"  Not ready yet... ({remaining:.0f}s remaining)")
        time.sleep(5)

    print("TIMEOUT: Langflow did not become healthy")
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    if not wait_for_langflow(args.timeout):
        sys.exit(1)
