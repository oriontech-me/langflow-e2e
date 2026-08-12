#!/usr/bin/env python3
"""Measure LE-2156 against a running Langflow (default http://localhost:7860).

Usage: python3 docs/upstream-bugs/scripts/probe-2156-model-input-fill.py

Prints one line per case. The verdict is the FIRST row plus the options control
printed with it: an empty `field_value` must come back empty *while options is
non-empty*, otherwise the run proves nothing (an empty catalog cannot substitute).
On 1.12.0.dev19 that row returned `claude-opus-5@Anthropic`; on 1.12.0.dev23,
after langflow#14465, it returns [].

The report's deterministic row: POST /api/v1/custom_component/update with an
EMPTY `field_value` on a LanguageModelComponent's `model` field came back filled
with `options[0]` — the first default-enabled model of the first *configured*
provider, regardless of the node's own. Three control rows must stay preserved.
"""
import gzip
import io
import json
import sys
import urllib.request

BASE = "http://localhost:7860"


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    req.add_header("Accept-Encoding", "gzip")
    try:
        r = urllib.request.urlopen(req)
        raw = r.read()
        status = r.status
        enc = r.headers.get("Content-Encoding")
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        enc = e.headers.get("Content-Encoding")
    if enc == "gzip":
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    try:
        return status, json.loads(raw)
    except Exception:
        return status, raw[:400].decode(errors="replace")


st, tok = call("GET", "/api/v1/auto_login")
TOKEN = tok["access_token"]

st, allc = call("GET", "/api/v1/all", TOKEN)
node = None
for category, comps in allc.items():
    if not isinstance(comps, dict):
        continue
    for type_name, tpl in comps.items():
        if type_name == "LanguageModelComponent" and isinstance(tpl, dict):
            node = (category, type_name, tpl)
if node is None:
    sys.exit("LanguageModelComponent not found in /api/v1/all")
category, type_name, tpl = node
template = tpl["template"]
code = template.get("code", {}).get("value", "")
print(f"node: {category}/{type_name}  model.value = {template.get('model', {}).get('value')!r}")

CASES = [
    ("[] (explicitly cleared)", []),
    ('[gpt-4o-mini @ OpenAI Compatible]', [{"name": "gpt-4o-mini", "provider": "OpenAI Compatible"}]),
    ('[definitely-not-a-model @ Nope]', [{"name": "definitely-not-a-model", "provider": "Nope"}]),
    ('[gpt-4o-mini @ OpenAI]', [{"name": "gpt-4o-mini", "provider": "OpenAI"}]),
]

for label, field_value in CASES:
    tmpl = json.loads(json.dumps(template))
    tmpl["model"]["value"] = field_value
    st, resp = call(
        "POST",
        "/api/v1/custom_component/update",
        TOKEN,
        {"code": code, "field": "model", "field_value": field_value, "template": tmpl},
    )
    if st != 200:
        print(f"{label:38s} -> HTTP {st}: {str(resp)[:160]}")
        continue
    returned = resp.get("template", {}).get("model", {}).get("value")
    if isinstance(returned, list):
        short = [f"{m.get('name')}@{m.get('provider')}" for m in returned if isinstance(m, dict)]
    else:
        short = returned
    print(f"{label:38s} -> {short!r}")
    if not field_value:
        opts = resp.get("template", {}).get("model", {}).get("options") or []
        providers = []
        for o in opts:
            prov = o.get("provider") if isinstance(o, dict) else None
            if prov and prov not in providers:
                providers.append(prov)
        first = (opts[0].get("name"), opts[0].get("provider")) if opts and isinstance(opts[0], dict) else None
        print(f"{'  control':38s} -> options={len(opts)} providers={providers} options[0]={first}")
