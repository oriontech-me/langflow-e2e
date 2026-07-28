#!/usr/bin/env python3
"""Scope #965: is the SQLITE_BUSY-as-500 specific to project DELETE, or does it
hit every write path? Runs P concurrent clients, each doing N rounds of
{project POST, project DELETE, flow POST, flow DELETE}, and tallies status codes
plus the error detail per operation. Cleans up whatever survives."""
import json
import sys
import threading
import urllib.request
from collections import Counter

BASE = "http://localhost:7860"
P = int(sys.argv[1]) if len(sys.argv) > 1 else 2
N = int(sys.argv[2]) if len(sys.argv) > 2 else 10

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
details = Counter()
leaked = {"projects": [], "flows": []}
lock = threading.Lock()

def record(op, status, body):
    with lock:
        tally[(op, status)] += 1
        if status >= 400:
            d = body.get("detail") if isinstance(body, dict) else str(body)
            details[(op, str(d)[:120])] += 1

def worker(w):
    for i in range(N):
        st, body = call("POST", "/api/v1/projects/", TOKEN, {"name": f"Scope965 p{w}-{i}"})
        record("POST /projects", st, body)
        pid = body.get("id") if isinstance(body, dict) else None

        st, body = call("POST", "/api/v1/flows/", TOKEN, {
            "name": f"Scope965 f{w}-{i}",
            "description": "",
            "data": {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        })
        record("POST /flows", st, body)
        fid = body.get("id") if isinstance(body, dict) else None

        if fid:
            st, body = call("DELETE", f"/api/v1/flows/{fid}", TOKEN)
            record("DELETE /flows", st, body)
            if st >= 400:
                with lock:
                    leaked["flows"].append(fid)
        if pid:
            st, body = call("DELETE", f"/api/v1/projects/{pid}", TOKEN)
            record("DELETE /projects", st, body)
            if st >= 400:
                with lock:
                    leaked["projects"].append(pid)

threads = [threading.Thread(target=worker, args=(w,)) for w in range(P)]
[t.start() for t in threads]
[t.join() for t in threads]

print(f"--- P={P} rounds={N}")
for (op, status), c in sorted(tally.items()):
    print(f"{op:20s} {status}  x{c}")
print("--- error details")
for (op, d), c in details.most_common():
    print(f"{op:20s} x{c}  {d}")

# Serial cleanup — contention is gone by now, so these succeed.
for fid in leaked["flows"]:
    call("DELETE", f"/api/v1/flows/{fid}", TOKEN)
for pid in leaked["projects"]:
    call("DELETE", f"/api/v1/projects/{pid}", TOKEN)
print(f"--- cleaned leaked: {len(leaked['flows'])} flows, {len(leaked['projects'])} projects")
