#!/usr/bin/env python3
"""Probe for the #965 <-> #932 relationship.

#932's symptom is NOT a 5xx: `PATCH /api/v1/flows/{id}` with a new `folder_id`
returns 200, but a follow-up `GET /api/v1/flows/{id}` reports the OLD folder_id.
Question: does write contention (the #965 trigger) also produce that silent
non-persistence, i.e. one shared backend cause?

Each client loops: create folders A and B, create a flow in A, PATCH it into B,
GET it back. Tallies (a) PATCH status, (b) whether the GET shows B.
"""
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter

BASE = os.environ.get("BASE", "http://localhost:7862")
P = int(sys.argv[1]) if len(sys.argv) > 1 else 4
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8


def call(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:200].decode(errors="replace")


with urllib.request.urlopen(BASE + "/api/v1/auto_login") as r:
    TOKEN = json.load(r)["access_token"]

tally = Counter()
lock = threading.Lock()
leaked = []


def worker(w):
    for i in range(N):
        st, a = call("POST", "/api/v1/projects/", TOKEN, {"name": f"Probe932 A{w}-{i}"})
        st2, b = call("POST", "/api/v1/projects/", TOKEN, {"name": f"Probe932 B{w}-{i}"})
        if not (isinstance(a, dict) and isinstance(b, dict)):
            with lock:
                tally["folder_create_failed"] += 1
            continue
        st3, flow = call("POST", "/api/v1/flows/", TOKEN, {
            "name": f"Probe932 f{w}-{i}",
            "description": "",
            "folder_id": a["id"],
            "data": {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        })
        if not isinstance(flow, dict) or "id" not in flow:
            with lock:
                tally[f"flow_create_{st3}"] += 1
            continue
        st4, patched = call("PATCH", f"/api/v1/flows/{flow['id']}", TOKEN, {"folder_id": b["id"]})
        st5, got = call("GET", f"/api/v1/flows/{flow['id']}", TOKEN)
        persisted = isinstance(got, dict) and got.get("folder_id") == b["id"]
        with lock:
            tally[f"PATCH {st4}"] += 1
            if st4 == 200:
                tally["patch200_persisted" if persisted else "patch200_NOT_persisted"] += 1
            leaked.append((flow["id"], a["id"], b["id"]))


threads = [threading.Thread(target=worker, args=(w,)) for w in range(P)]
[t.start() for t in threads]
[t.join() for t in threads]

print(f"--- BASE={BASE} P={P} rounds={N}")
for k, v in sorted(tally.items()):
    print(f"{k:28s} x{v}")

# Serial cleanup, retrying once — contention is gone once the threads are done.
for fid, aid, bid in leaked:
    call("DELETE", f"/api/v1/flows/{fid}", TOKEN)
    for pid in (aid, bid):
        st, _ = call("DELETE", f"/api/v1/projects/{pid}", TOKEN)
        if st >= 400:
            call("DELETE", f"/api/v1/projects/{pid}", TOKEN)
print(f"--- cleanup attempted for {len(leaked)} flows and {2 * len(leaked)} projects")
