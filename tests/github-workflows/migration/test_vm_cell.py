"""Unit tests for ops/vm/migration/cell.py, the migration routine's seed and checks.

The checks themselves are proved on the machine, against real Langflow releases (the
routine's rehearsal, 2026-10-06). What these pin is the pure decisions inside them,
each one a mistake the rehearsal made first: the model selection the unified selector
needs, how the provider probe's verdict file is read, and whose flows are counted.

Lives here, not beside cell.py, because this is the directory the PR gate's pytest step
collects (pr-validation.yml).
"""

import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("vm_cell", ROOT / "ops" / "vm" / "migration" / "cell.py")
cell = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cell)


def _flow(node_type, template):
    return {"nodes": [{"data": {"type": node_type, "node": {"template": template}}}]}


def test_the_unified_selector_gets_a_provider_and_a_name():
    # 1.11.1+ carries `model` (type `model`); get_llm rejects a selection with no provider.
    data = _flow("LanguageModelComponent", {"model": {"type": "model", "value": ""}, "ollama_base_url": {"value": ""}, "api_key": {"value": ""}})
    assert cell.select_model(data, "Ollama", "llama3.2:1b", ollama_url="http://10.0.0.9:11464") == 1
    t = data["nodes"][0]["data"]["node"]["template"]
    assert t["model"]["value"] == [{"name": "llama3.2:1b", "provider": "Ollama"}]
    assert t["ollama_base_url"]["value"] == "http://10.0.0.9:11464"
    assert t["api_key"]["value"] == ""


def test_legacy_fields_are_filled_when_there_is_no_selector():
    data = _flow("OpenAIModel", {"provider": {"value": ""}, "model_name": {"value": ""}, "api_key": {"value": ""}})
    cell.select_model(data, "OpenAI", "gpt-4o-mini", api_key_var="MIGRATION_OPENAI_KEY")
    t = data["nodes"][0]["data"]["node"]["template"]
    assert t["provider"]["value"] == "OpenAI"
    assert t["model_name"]["value"] == "gpt-4o-mini"
    # The credential by name, loaded from the database: that is what must decrypt.
    assert t["api_key"]["value"] == "MIGRATION_OPENAI_KEY"
    assert t["api_key"]["load_from_db"] is True


def test_nodes_that_are_not_models_are_left_alone():
    data = _flow("ChatInput", {"model": {"type": "model", "value": "x"}})
    assert cell.select_model(data, "Ollama", "m") == 0
    assert data["nodes"][0]["data"]["node"]["template"]["model"]["value"] == "x"


def test_no_probe_file_means_the_account_can_pay(tmp_path, monkeypatch):
    # provider_credentials.py writes its file for a BLOCKING verdict only: absence is
    # live. The first version read absence as inconclusive and blocked every cell.
    monkeypatch.setenv("CREDENTIAL_VERDICT_FILE", str(tmp_path / "none.json"))
    assert cell.probe_verdict() == ""
    monkeypatch.delenv("CREDENTIAL_VERDICT_FILE")
    assert cell.probe_verdict() == ""


def test_a_probe_file_says_what_blocks_and_a_broken_one_is_inconclusive(tmp_path, monkeypatch):
    f = tmp_path / "v.json"
    monkeypatch.setenv("CREDENTIAL_VERDICT_FILE", str(f))
    f.write_text(json.dumps({"verdict": "billing"}))
    assert cell.probe_verdict() == "billing"
    f.write_text("{not json")
    assert cell.probe_verdict() == "inconclusive"
    f.write_text(json.dumps({"reason": "no verdict key"}))
    assert cell.probe_verdict() == "inconclusive"


class _FakeApi:
    def __init__(self, flows):
        self.flows = flows
        self.paths = []

    def json(self, method, path, **_):
        self.paths.append(path)
        return self.flows


def test_only_the_users_own_flows_are_counted():
    # The listing also carries the starter examples (no owner), which an auto-login
    # session sees and a signed-in user does not: counting them made every AUTO_LOGIN-off
    # cell red for 26 flows that were never the user's (rehearsal, 2026-10-06).
    api = _FakeApi([{"user_id": "u1"}, {"user_id": "u1"}, {"user_id": None}, {"user_id": "u2"}, {}])
    assert cell.owned_flows(api, "u1") == 2
    # The full listing, not the header one, which may leave user_id out.
    assert api.paths == ["/api/v1/flows/?get_all=true"]


def test_a_check_that_crashes_is_a_failed_check(capsys):
    c = cell.Checks()
    c.run("boom", lambda: 1 / 0)
    c.run("ok", lambda: (True, "fine"))
    c.add("credential", "blocked", "probe says billing")
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("CHECK boom fail ZeroDivisionError")
    assert out[1] == "CHECK ok pass fine"
    assert out[2] == "CHECK credential blocked probe says billing"
    assert c.failed


def test_blocked_alone_is_not_failed():
    c = cell.Checks()
    c.add("credential", "blocked", "x")
    assert not c.failed


def _credential_with(monkeypatch, exc):
    def boom(api, state):
        raise exc
    monkeypatch.setattr(cell, "_credential_call", boom)
    c = cell.Checks()
    cell._credential_check(c, None, {})
    return c.rows[-1]


def test_a_provider_refusing_mid_run_is_blocked(monkeypatch):
    for body in ('{"detail": "Error code: 429 - rate limit reached"}', '{"error": {"code": "insufficient_quota"}}'):
        name, verdict, _ = _credential_with(monkeypatch, cell.ApiError(500, body, "u"))
        assert (name, verdict) == ("credential", "blocked"), body


def test_an_invalid_key_is_red_because_it_is_what_a_failed_decrypt_looks_like(monkeypatch):
    body = '{"detail": "Error code: 401 - Incorrect API key provided"}'
    _, verdict, detail = _credential_with(monkeypatch, cell.ApiError(500, body, "u"))
    assert verdict == "fail"
    assert "401" in detail


def test_an_unreadable_seed_state_is_this_machines_not_the_products(tmp_path, monkeypatch):
    monkeypatch.setattr(cell, "wait_up", lambda api, seconds=240: True)
    monkeypatch.setattr(cell, "login", lambda api, how: None)
    rc = cell.main(["verify", "--url", "http://x", "--state", str(tmp_path / "missing.json")])
    assert rc == 5


def test_a_credential_reply_must_be_the_one_asked_for():
    # A 200 whose chat output is an error string is what a key that did not decrypt can
    # look like; any non-empty text used to pass (review of #2194).
    assert cell.credential_verdict("Ready.")[1] == "pass"
    for text in ("Error: 401 Incorrect API key provided", "", "Sure! How can I help?"):
        assert cell.credential_verdict(text)[1] == "fail", text
    assert cell.credential_verdict("Error code: 429 - rate limit reached")[1] == "blocked"


def test_a_witness_reply_that_reads_like_an_error_is_not_a_reply():
    assert not cell.looks_like_error("ready")
    assert cell.looks_like_error("Error: connection refused to http://10.0.0.9:11464")


class _MsgApi:
    def __init__(self, answers):
        self.answers = list(answers)

    def json(self, method, path, **_):
        return self.answers.pop(0) if self.answers else []


def test_the_seed_waits_briefly_for_messages_and_returns_none_when_there_are_none(monkeypatch):
    monkeypatch.setattr(cell.time, "sleep", lambda s: None)
    assert cell.seeded_messages(_MsgApi([[], [{"id": "m1"}]]), "s") == [{"id": "m1"}]
    assert cell.seeded_messages(_MsgApi([]), "s", seconds=0) == []


class _AdoptApi:
    def __init__(self, users, patch_error=None):
        self.users = users
        self.patch_error = patch_error
        self.logged_in = None

    def json(self, method, path, **_):
        if method == "GET":
            return self.users
        if self.patch_error:
            raise self.patch_error
        return {}

    def login_password(self, username, password):
        self.logged_in = username


STATE = {"user": {"id": "u1", "username": "langflow"}}


def test_adopt_reads_a_users_page_and_a_bare_list_alike():
    for users in ({"users": [{"id": "u1", "username": "langflow"}]}, [{"id": "u1", "username": "langflow"}]):
        api, c = _AdoptApi(users), cell.Checks()
        assert cell.adopt_default_user(api, STATE, c) is True, users
        assert api.logged_in == "langflow"


def test_a_kept_account_the_admin_api_cannot_reactivate_is_not_reported_as_deleted():
    api, c = _AdoptApi({"users": [{"id": "u1", "username": "langflow"}]}, patch_error=cell.ApiError(422, "no password field", "u")), cell.Checks()
    assert cell.adopt_default_user(api, STATE, c) is False
    assert [(n, v) for n, v, _ in c.rows] == [("default-user-kept", "pass"), ("default-user-adopt", "fail")]


def test_already_is_not_ready_and_the_verdict_reaches_the_check(monkeypatch):
    assert cell.credential_verdict("The key was already revoked.")[1] == "fail"
    # The wiring, not only the function: the check records what credential_verdict says.
    for text, want in (("Ready.", "pass"), ("Error: 401 Incorrect API key provided", "fail"), ("Ready, error: none", "fail")):
        monkeypatch.setattr(cell, "_credential_call", lambda api, state, t=text: t)
        c = cell.Checks()
        cell._credential_check(c, None, {})
        assert c.rows[-1][:2] == ("credential", want), text


def test_the_witness_rejects_an_empty_or_error_shaped_reply():
    assert cell.witness_reply_ok("Ready")
    assert not cell.witness_reply_ok("  ")
    assert not cell.witness_reply_ok("Error: model 'llama3.2:1b' not found")


def test_a_seed_whose_run_stored_no_messages_fails_on_the_source():
    import pytest
    with pytest.raises(RuntimeError, match="stored no messages"):
        cell.require_messages([], "s", "ready")
    assert cell.require_messages([{"id": "m"}], "s", "ready") == [{"id": "m"}]


def test_a_users_listing_that_fails_is_not_reported_as_the_default_user_deleted(tmp_path, monkeypatch, capsys):
    # default-user-kept draws the #15326 note on an old target: a 500 on the listing is
    # a regression of its own (review of #2194).
    state = tmp_path / "s.json"
    state.write_text(json.dumps(STATE))
    monkeypatch.setattr(cell, "wait_up", lambda api, seconds=240: True)
    monkeypatch.setattr(cell, "login", lambda api, how: None)

    def boom(api, state, checks):
        raise cell.ApiError(500, "boom", "u")
    monkeypatch.setattr(cell, "adopt_default_user", boom)
    assert cell.main(["verify", "--url", "http://x", "--state", str(state), "--login", "adopt"]) == 1
    out = capsys.readouterr().out
    assert "CHECK user-listing fail" in out
    assert "default-user-kept" not in out
