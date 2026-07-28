#!/usr/bin/env python3
"""A/B/A/B contention test for #965.

Question: is the instant `500 database is locked` on DELETE /api/v1/projects/{id}
a THRESHOLD REGRESSION in 1.12 (nightly) versus 1.10.3 (stable), or the same
long-standing defect measured under different machine load?

Design (each arm gets identical treatment, never simultaneously, so the 2-core
Docker VM is not shared between arms):
  - arms alternate A(stable 1.10.3, :7861) / B(nightly 1.12.0.dev7, :7862)
  - ROUNDS alternations; each round = P concurrent clients x N create+delete cycles
  - between rounds every leftover probe project is deleted serially, so DB size
    stays comparable across rounds
  - per round we record: 204 count, 500 count, other, and the latency profile of
    the failures (an instant failure means SQLite's busy handler never waited;
    a slow one means it waited and gave up)

Prints a per-round table plus a per-arm total. No test-suite code involved.
"""
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

ARMS = [("stable-1.10.3", "http://localhost:7861"), ("nightly-1.12.0.dev7", "http://localhost:7862")]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
P = int(sys.argv[2]) if len(sys.argv) > 2 else 2
N = int(sys.argv[3]) if len(sys.argv) > 3 else 15
PREFIX = "AB965"


def call(base, method, path, token, body=None, timeout=200):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), time.monotonic() - t0
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw), time.monotonic() - t0
        except Exception:
            return e.code, raw[:200].decode(errors="replace"), time.monotonic() - t0
    except Exception as e:  # timeout / connection reset
        return 0, str(e)[:120], time.monotonic() - t0


def token_for(base):
    with urllib.request.urlopen(base + "/api/v1/auto_login") as r:
        return json.load(r)["access_token"]


def purge(base, token):
    """Delete every leftover probe project, serially and with one retry."""
    st, body, _ = call(base, "GET", "/api/v1/projects/", token)
    lst = body if isinstance(body, list) else (body or {}).get("folders", [])
    ids = [f["id"] for f in lst if str(f.get("name", "")).startswith(PREFIX)]
    for pid in ids:
        st, _, _ = call(base, "DELETE", f"/api/v1/projects/{pid}", token)
        if st >= 400:
            call(base, "DELETE", f"/api/v1/projects/{pid}", token)
    return len(ids)


def round_once(name, base, rnd):
    token = token_for(base)
    codes = Counter()
    fail_lat, ok_lat = [], []
    lock = threading.Lock()

    def worker(w):
        for i in range(N):
            st, body, _ = call(base, "POST", "/api/v1/projects/", token,
                               {"name": f"{PREFIX} r{rnd}-w{w}-{i}"})
            if not isinstance(body, dict) or "id" not in body:
                with lock:
                    codes[f"create-{st}"] += 1
                continue
            st, body, dt = call(base, "DELETE", f"/api/v1/projects/{body['id']}", token)
            with lock:
                codes[st] += 1
                (ok_lat if st == 204 else fail_lat).append(dt)

    threads = [threading.Thread(target=worker, args=(w,)) for w in range(P)]
    t0 = time.monotonic()
    [t.start() for t in threads]
    [t.join() for t in threads]
    wall = time.monotonic() - t0
    leftovers = purge(base, token)

    total = sum(codes.values())
    n500 = codes.get(500, 0)
    other = total - codes.get(204, 0) - n500
    med = statistics.median(fail_lat) if fail_lat else 0.0
    print(f"round {rnd} | {name:20s} | 204={codes.get(204,0):3d} 500={n500:3d} other={other:2d} "
          f"| fail median={med:6.2f}s | wall={wall:6.1f}s | purged={leftovers}", flush=True)
    return {"arm": name, "round": rnd, "n204": codes.get(204, 0), "n500": n500,
            "other": other, "fail_median": med, "wall": wall}


print(f"--- A/B contention test: ROUNDS={ROUNDS} P={P} N={N} (deletes per round = {P * N})", flush=True)
for name, base in ARMS:
    tok = token_for(base)
    print(f"pre-purge {name}: {purge(base, tok)} leftover probe projects removed", flush=True)

results = []
for rnd in range(1, ROUNDS + 1):
    for name, base in ARMS:
        results.append(round_once(name, base, rnd))

print("\n--- per-arm totals")
for name, _ in ARMS:
    rs = [r for r in results if r["arm"] == name]
    t204 = sum(r["n204"] for r in rs)
    t500 = sum(r["n500"] for r in rs)
    tot = t204 + t500 + sum(r["other"] for r in rs)
    meds = [r["fail_median"] for r in rs if r["n500"]]
    print(f"{name:20s} 204={t204:3d}/{tot:3d}  500={t500:3d}  ({100*t500/tot:.0f}% of requests)  "
          f"fail-median across rounds={statistics.median(meds) if meds else 0:.2f}s")
json.dump(results, open("/tmp/ab965-results.json", "w"), indent=1)
