#!/usr/bin/env python3
"""One migration cell's work against a running Langflow: seed it, or verify it.

Called by ops/vm/run-migration.sh, which owns installing, starting, stopping and
upgrading the instance. This file only talks to the API. Standard library only: it runs
with the machine's python3, outside any venv, so a Langflow that cannot install still
gets a verdict that says so instead of an import error.

    cell.py seed   --url U --state FILE [--login auto|password] [--ollama URL] [--model M]
    cell.py verify --url U --state FILE [--login auto|password|adopt] [--ollama URL] [--model M]

Credentials for the password and adopt logins come from the environment (never argv):
LANGFLOW_SUPERUSER / LANGFLOW_SUPERUSER_PASSWORD. The credential witness reads
OPENAI_API_KEY and the probe verdict file named by CREDENTIAL_VERDICT_FILE.

## What the seed leaves behind, and why each piece

Each piece is something a user owns that a migration has lost before, or could:

  - two projects, a witness flow in each   -- the 1.7.0 loss (#11107) took flows AND
                                              projects; ids, names and folder links are
                                              compared, not only counts
  - a Credential variable                  -- stored encrypted; after the upgrade it must
                                              still DECRYPT, proved by one real call
  - a credential witness flow              -- the flow that makes that call
  - messages, from running a witness       -- history lives in its own table
  - an uploaded file                       -- the file row AND the bytes on disk
  - an API key                             -- hashed in the database; it must still
                                              authenticate after the upgrade

The witness flows run on the local ollama (no provider credit, no false red). The
credential flow runs on OpenAI's cheapest model, once, and only when the probe says the
account can pay: otherwise that check is `blocked`, not red.

## Output

Seed writes the state file (JSON) the verify reads. Verify prints one line per check,
`CHECK <name> <pass|fail|blocked> <detail>`, and exits 0 when every check passed or was
blocked, 1 when any failed, 3 when the instance could not be reached at all, 5 when the
seed's state could not be read (this machine's, not the product's).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

TIMEOUT = 60
SEED_TAG = "migration-seed"
FILE_BYTES = b"migration routine witness file\nline two\n"


class ApiError(Exception):
    def __init__(self, status: int, body: str, url: str):
        super().__init__(f"HTTP {status} on {url}: {body[:300]}")
        self.status = status
        self.body = body


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.token = ""
        self.api_key = ""

    def _req(self, method, path, body=None, form=None, raw=None, headers=None, timeout=TIMEOUT, auth=True):
        url = f"{self.base}{path}"
        h = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        elif form is not None:
            data = urllib.parse.urlencode(form).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif raw is not None:
            data, ctype = raw
            h["Content-Type"] = ctype
        if auth and self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if auth and self.api_key:
            h["x-api-key"] = self.api_key
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                # The flow list comes gzipped whether asked or not (measured on 1.12.4).
                if r.headers.get("Content-Encoding") == "gzip" or payload[:2] == b"\x1f\x8b":
                    payload = gzip.decompress(payload)
                return r.status, payload
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode(errors="replace"), url) from None

    def json(self, method, path, **kw):
        _, payload = self._req(method, path, **kw)
        return json.loads(payload) if payload else None

    def bytes(self, method, path, **kw):
        return self._req(method, path, **kw)[1]

    # --- login ------------------------------------------------------------------------

    def login_auto(self):
        self.token = self.json("GET", "/api/v1/auto_login", auth=False)["access_token"]

    def login_password(self, username, password):
        self.token = self.json("POST", "/api/v1/login", form={"username": username, "password": password}, auth=False)["access_token"]


def wait_up(api: Api, seconds: int = 240) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            api._req("GET", "/health_check", auth=False, timeout=5)
            return True
        except Exception:
            time.sleep(2)
    return False


def multipart(field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = f"----migration{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
        f"Content-Type: text/plain\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


# --- flows ----------------------------------------------------------------------------

def basic_prompting(api: Api) -> dict:
    for p in api.json("GET", "/api/v1/starter-projects/"):
        if p.get("name") == "Basic Prompting":
            return p
    raise RuntimeError("the starter 'Basic Prompting' is not in this version's starter projects")


def select_model(flow_data: dict, provider: str, model: str, ollama_url: str = "", api_key_var: str = "") -> int:
    """Point every language model node at one model. Returns how many nodes it set.

    The unified selector (`model`, type `model`) takes a list of {name, provider}; older
    builds carry `provider` / `model_name` instead (#1004 in this repository). Both are
    filled when present, so one seed serves a source and a target of different shapes.
    """
    n = 0
    for node in flow_data.get("nodes", []):
        data = node.get("data", {})
        if data.get("type") not in {"LanguageModelComponent", "OpenAIModel", "OllamaModel"}:
            continue
        t = data.get("node", {}).get("template", {})
        if "model" in t and t["model"].get("type") == "model":
            t["model"]["value"] = [{"name": model, "provider": provider}]
        else:
            if "provider" in t:
                t["provider"]["value"] = provider
            if "model_name" in t:
                t["model_name"]["value"] = model
        if ollama_url and "ollama_base_url" in t:
            t["ollama_base_url"]["value"] = ollama_url
        if "base_url" in t and ollama_url and provider == "Ollama":
            t["base_url"]["value"] = ollama_url
        if api_key_var and "api_key" in t:
            t["api_key"]["value"] = api_key_var
            t["api_key"]["load_from_db"] = True
        n += 1
    return n


def run_text(api: Api, flow_id: str, message: str, session: str, api_key: str) -> str:
    """Runs need an API key since 1.5, auto-login or not: the seeded one, which this
    also exercises."""
    runner = Api(api.base)
    runner.api_key = api_key
    out = runner.json(
        "POST",
        f"/api/v1/run/{flow_id}",
        body={"input_value": message, "input_type": "chat", "output_type": "chat", "session_id": session},
        timeout=240,
    )
    try:
        msg = out["outputs"][0]["outputs"][0]["results"]["message"]
        return (msg.get("text") if isinstance(msg, dict) else str(msg)) or ""
    except (KeyError, IndexError, TypeError):
        return ""


# --- seed -----------------------------------------------------------------------------

def seed(api: Api, args) -> dict:
    me = api.json("GET", "/api/v1/users/whoami")
    starter = basic_prompting(api)
    state = {"user": {"id": me["id"], "username": me["username"]}, "projects": [], "flows": [], "seeded_by": args.version or ""}

    for name in ("Migration project A", "Migration project B"):
        p = api.json("POST", "/api/v1/projects/", body={"name": name, "description": SEED_TAG, "flows_list": [], "components_list": []})
        state["projects"].append({"id": p["id"], "name": p["name"]})

    for i, project in enumerate(state["projects"]):
        data = json.loads(json.dumps(starter["data"]))
        select_model(data, "Ollama", args.model, ollama_url=args.ollama)
        f = api.json(
            "POST",
            "/api/v1/flows/",
            body={"name": f"Migration witness {'AB'[i]}", "description": SEED_TAG, "data": data, "folder_id": project["id"]},
        )
        state["flows"].append({"id": f["id"], "name": f["name"], "folder_id": project["id"], "nodes": len(data.get("nodes", []))})

    # The credential and the flow that proves it decrypts.
    key = os.environ.get("OPENAI_API_KEY", "")
    var_name = "MIGRATION_OPENAI_KEY"
    if key:
        v = api.json("POST", "/api/v1/variables/", body={"name": var_name, "value": key, "type": "Credential", "default_fields": []})
        state["variable"] = {"id": v["id"], "name": var_name}
        data = json.loads(json.dumps(starter["data"]))
        select_model(data, "OpenAI", "gpt-4o-mini", api_key_var=var_name)
        f = api.json(
            "POST",
            "/api/v1/flows/",
            body={"name": "Migration credential witness", "description": SEED_TAG, "data": data, "folder_id": state["projects"][0]["id"]},
        )
        state["credential_flow"] = {"id": f["id"]}

    # An API key, kept in clear here only: the database holds its hash. First, because
    # every run needs one.
    k = api.json("POST", "/api/v1/api_key/", body={"name": SEED_TAG})
    state["api_key"] = {"id": k["id"], "value": k["api_key"]}

    # Messages: one run of the first witness, in a session of its own.
    session = f"{SEED_TAG}-{uuid.uuid4().hex[:8]}"
    text = run_text(api, state["flows"][0]["id"], "Reply with the single word: ready", session, state["api_key"]["value"])
    msgs = api.json("GET", f"/api/v1/monitor/messages?session_id={urllib.parse.quote(session)}") or []
    state["messages"] = {"session": session, "count": len(msgs), "ids": sorted(m["id"] for m in msgs), "reply": text[:200]}

    # A file: the row and the bytes.
    body, ctype = multipart("file", "migration-witness.txt", FILE_BYTES)
    up = api.json("POST", "/api/v2/files/", raw=(body, ctype))
    state["file"] = {"id": up["id"], "name": up.get("name"), "sha256": hashlib.sha256(FILE_BYTES).hexdigest()}

    # The flows this user OWNS. The listing also carries the starter examples (no owner),
    # which an auto-login session sees and a signed-in user does not: counting them made
    # every AUTO_LOGIN-off cell red for 26 flows that were never the user's (2026-10-06).
    state["flow_count"] = owned_flows(api, me["id"])
    return state


def owned_flows(api: Api, user_id: str) -> int:
    # The full listing: the header one may leave user_id out.
    return sum(1 for f in (api.json("GET", "/api/v1/flows/?get_all=true") or []) if f.get("user_id") == user_id)


# --- verify ---------------------------------------------------------------------------

class Checks:
    def __init__(self):
        self.rows = []

    def add(self, name, verdict, detail=""):
        self.rows.append((name, verdict, detail))
        print(f"CHECK {name} {verdict} {detail}".rstrip(), flush=True)

    def run(self, name, fn):
        try:
            ok, detail = fn()
            self.add(name, "pass" if ok else "fail", detail)
        except ApiError as e:
            self.add(name, "fail", str(e))
        except Exception as e:  # a check that crashes is a failed check, never a skipped one
            self.add(name, "fail", f"{type(e).__name__}: {e}")

    @property
    def failed(self):
        return any(v == "fail" for _, v, _ in self.rows)


def adopt_default_user(api: Api, state: dict, checks: Checks) -> bool:
    """AUTO_LOGIN off with another superuser configured (#15326): the default account
    must survive with its id, retired rather than deleted. Then the configured superuser
    reactivates it and sets a password, and the rest of the checks run as that account,
    so they see what it owns."""
    users = api.json("GET", "/api/v1/users/?skip=0&limit=200")
    found = [u for u in users.get("users", users if isinstance(users, list) else []) if u["username"] == state["user"]["username"]]
    if not found:
        checks.add("default-user-kept", "fail", f"no user '{state['user']['username']}' after the upgrade: deleted (#15326)")
        return False
    u = found[0]
    if u["id"] != state["user"]["id"]:
        checks.add("default-user-kept", "fail", f"'{u['username']}' was recreated with a new id ({state['user']['id']} -> {u['id']}): its data went with the old one (#15326)")
        return False
    checks.add("default-user-kept", "pass", f"same id, is_active={u.get('is_active')}")
    password = f"Migration-{uuid.uuid4().hex[:12]}!"
    # The admin path #15326 names: PATCH /api/v1/users/{id}. reset-password is the user's
    # own and asks for the current password, which nobody has for this account.
    api.json("PATCH", f"/api/v1/users/{u['id']}", body={"is_active": True, "password": password})
    api.login_password(u["username"], password)
    return True


def verify(api: Api, state: dict, args) -> Checks:
    c = Checks()
    try:
        flows = {f["id"]: f for f in (api.json("GET", "/api/v1/flows/?get_all=true&header_flows=true") or [])}
    except Exception as e:  # a listing that fails is a failed check, with its words
        c.add("flow-listing", "fail", f"{type(e).__name__}: {e}")
        flows = {}

    def projects():
        have = {p["id"]: p["name"] for p in api.json("GET", "/api/v1/projects/")}
        missing = [p["name"] for p in state["projects"] if have.get(p["id"]) != p["name"]]
        return not missing, f"missing or renamed: {missing}" if missing else f"{len(state['projects'])} kept"

    def witness_flows():
        bad = []
        for f in state["flows"]:
            got = flows.get(f["id"])
            if not got:
                bad.append(f"{f['name']}: gone")
                continue
            if got.get("folder_id") != f["folder_id"]:
                bad.append(f"{f['name']}: moved to {got.get('folder_id')}")
            full = api.json("GET", f"/api/v1/flows/{f['id']}")
            n = len((full.get("data") or {}).get("nodes", []))
            if n != f["nodes"]:
                bad.append(f"{f['name']}: {f['nodes']} nodes became {n}")
        return not bad, "; ".join(bad) or f"{len(state['flows'])} flows, ids, projects and nodes kept"

    def flow_count():
        n = owned_flows(api, state["user"]["id"])
        return n >= state["flow_count"], f"{state['flow_count']} owned before, {n} after"

    def messages():
        m = state["messages"]
        got = api.json("GET", f"/api/v1/monitor/messages?session_id={urllib.parse.quote(m['session'])}") or []
        ids = sorted(x["id"] for x in got)
        missing = sorted(set(m["ids"]) - set(ids))
        return not missing and m["count"] > 0, f"{m['count']} seeded, {len(missing)} missing"

    def file_bytes():
        f = state["file"]
        data = api.bytes("GET", f"/api/v2/files/{f['id']}")
        got = hashlib.sha256(data).hexdigest()
        return got == f["sha256"], "bytes identical" if got == f["sha256"] else f"sha256 {f['sha256'][:12]} became {got[:12]} ({len(data)} bytes)"

    def api_key():
        probe = Api(api.base)
        probe.api_key = state["api_key"]["value"]
        got = probe.json("GET", "/api/v1/flows/?get_all=true&header_flows=true") or []
        return len(got) >= len(state["flows"]), f"authenticates, sees {len(got)} flows"

    def run_witness():
        text = run_text(api, state["flows"][1]["id"], "Reply with the single word: ready", f"{SEED_TAG}-verify-{uuid.uuid4().hex[:6]}", state["api_key"]["value"])
        return bool(text.strip()), f"ollama replied: {text.strip()[:60]!r}"

    c.run("projects", projects)
    c.run("flows", witness_flows)
    c.run("flow-count", flow_count)
    c.run("messages", messages)
    c.run("file", file_bytes)
    c.run("api-key", api_key)
    c.run("witness-runs", run_witness)

    # The credential decrypts: one real call, only when the probe says it can be paid.
    if "variable" in state:
        try:
            have = {v["name"] for v in api.json("GET", "/api/v1/variables/")}
        except Exception as e:
            c.add("credential", "fail", f"the variables could not be listed: {type(e).__name__}: {e}")
            return c
        if state["variable"]["name"] not in have:
            c.add("credential", "fail", "the Credential variable is gone")
        else:
            verdict = probe_verdict()
            if verdict not in ("live", ""):
                c.add("credential", "blocked", f"provider probe says {verdict}: the decrypt is not proved today, and not disproved")
            else:
                _credential_check(c, api, state)
    else:
        c.add("credential", "blocked", "no OPENAI_API_KEY at seed time: nothing to decrypt")
    return c


# The provider's own refusals: rate limit and quota. Never 401 / invalid key, which is
# what a credential that failed to decrypt produces -- the case this check exists for.
_PROVIDER_REFUSAL = ("insufficient_quota", "exceeded your current quota", "rate limit", "rate_limit", "error code: 429", "status code 429")


def _credential_check(c: "Checks", api, state):
    """The one real call. A provider refusing mid-run (429, quota) is `blocked`, like
    the pre-flight probe's verdict: the decrypt is neither proved nor disproved."""
    try:
        ok, detail = _credential_call(api, state)
        c.add("credential", "pass" if ok else "fail", detail)
    except ApiError as e:
        body = e.body.lower()
        if any(m in body for m in _PROVIDER_REFUSAL):
            c.add("credential", "blocked", f"the provider refused the call (HTTP {e.status}): not proved today, not disproved")
        else:
            c.add("credential", "fail", str(e))
    except Exception as e:
        c.add("credential", "fail", f"{type(e).__name__}: {e}")


def _credential_call(api, state):
    text = run_text(api, state["credential_flow"]["id"], "Reply with the single word: ready", f"{SEED_TAG}-cred-{uuid.uuid4().hex[:6]}", state["api_key"]["value"])
    return bool(text.strip()), f"decrypted and called OpenAI: {text.strip()[:40]!r}"


def probe_verdict() -> str:
    """The provider probe's verdict. Its file exists only for a BLOCKING verdict
    (provider_credentials.write_marker): absent means the account can pay. The wrapper
    writes `inconclusive` itself when the probe ended without deciding."""
    path = os.environ.get("CREDENTIAL_VERDICT_FILE", "")
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path) as f:
            return json.load(f).get("verdict", "") or "inconclusive"
    except (OSError, ValueError):
        return "inconclusive"


# --- main -----------------------------------------------------------------------------

def login(api: Api, how: str):
    if how == "auto":
        api.login_auto()
    else:
        api.login_password(os.environ["LANGFLOW_SUPERUSER"], os.environ["LANGFLOW_SUPERUSER_PASSWORD"])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["seed", "verify"])
    ap.add_argument("--url", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--login", choices=["auto", "password", "adopt"], default="auto")
    ap.add_argument("--ollama", default="")
    ap.add_argument("--model", default="llama3.2:1b")
    ap.add_argument("--version", default="")
    args = ap.parse_args(argv)
    api = Api(args.url)
    if not wait_up(api):
        print(f"CHECK reachable fail {args.url} did not answer /health_check", flush=True)
        return 3
    try:
        login(api, "password" if args.login == "adopt" else args.login)
    except (ApiError, KeyError) as e:
        print(f"CHECK login fail {e}", flush=True)
        return 1
    if args.command == "seed":
        try:
            state = seed(api, args)
        except Exception as e:  # any failure of the seed is reported, never a traceback alone
            print(f"SEED fail {type(e).__name__}: {e}", flush=True)
            return 3
        with open(args.state, "w") as f:
            json.dump(state, f, indent=2)
        print(f"SEED ok {len(state['projects'])} projects, {len(state['flows'])} witness flows, "
              f"{state['messages']['count']} messages, credential={'yes' if 'variable' in state else 'no'}", flush=True)
        return 0
    try:
        with open(args.state) as f:
            state = json.load(f)
    except (OSError, ValueError) as e:
        # This machine's: the seed's state is the routine's own file.
        print(f"CHECK state fail no seed to verify against: {e}", flush=True)
        return 5
    checks = Checks()
    if args.login == "adopt":
        try:
            if not adopt_default_user(api, state, checks):
                return 1
        except ApiError as e:
            checks.add("default-user-kept", "fail", str(e))
            return 1
    result = verify(api, state, args)
    return 1 if (result.failed or checks.failed) else 0


if __name__ == "__main__":
    sys.exit(main())
