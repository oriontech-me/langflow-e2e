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
