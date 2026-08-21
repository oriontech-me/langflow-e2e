# `POST /api/v1/flows/download/` drops the credential variable binding — exported flows no longer import with their secrets bound

| Field | Value |
|---|---|
| **Filed upstream** | _pending_ (draft below; owner: QA team) |
| **Repo issue** | [oriontech-me/langflow-e2e#1546](https://github.com/oriontech-me/langflow-e2e/issues/1546) (spun out of daily triage #1544) |
| **Affected builds** | `langflowai/langflow-nightly:latest` since `2026-08-20` (first nightly cut after the causing merge); reproduced 5/5 on `1.12.0.dev33` |
| **Introduced by** | [langflow-ai/langflow#14639](https://github.com/langflow-ai/langflow/pull/14639) — *fix(security): scrub all secret fields on flow and project export* (commit `fc3810da0`, merged 2026-08-19T17:36Z into `release-1.12.0`) |
| **Component** | `src/backend/base/langflow/api/v1/flows_helpers.py` → `_build_flows_download_response` → `langflow/utils/flow_secrets.py` (`strip_flow_secrets` / `strip_secret_field_values_in_place`) |
| **Sibling surfaces** | `GET /api/v1/projects/download/{project_id}` and `flow_version.strip_version_data` were moved onto the same scrubber by the same PR and share the defect |
| **Severity** | Medium. Data-fidelity regression, **not** a secret leak: every exported flow that binds a Credential global variable to a `SecretStrInput` imports back with the binding silently destroyed (`load_from_db: true`, `value: null`), so the re-imported flow cannot resolve its credentials until each field is re-bound by hand. Backup/share/round-trip workflows are all affected; nothing in the UI warns. |
| **Discovered by** | Langflow E2E regression suite — `tests/tests-automations/regression/security/credential-secret-exposure.spec.ts` (test: *the exported flow carries the credential binding, never the secret*), hard-failing on the dailies of 2026-08-20 and 2026-08-21 |

---

## 1. Summary

A `SecretStrInput` field bound to a Credential-type global variable stores the
variable's **name** in `value` with `load_from_db: true` — the name, not the
secret, is what the stored flow carries, and it is what an import needs to
re-resolve the credential. Since PR #14639, `POST /api/v1/flows/download/`
(the endpoint behind the UI's Export action) nulls that name:

```json
"secret_token": {
  "_input_type": "SecretStrInput",
  "load_from_db": true,
  "password": true,
  "type": "str",
  "value": null
}
```

The field is still marked DB-bound while the reference it is bound to is gone
from the entire payload. `GET /api/v1/flows/{id}` returns the same field with
`value: "<variable name>"` — only the export path loses it.

The scrub itself is the right move (#14639 fixed real literal-secret leaks:
`password: true` fields under non-API-key names, credential-bearing connection
strings). The regression is that the export call site uses the scrubber's
**anonymous-consumer default**, which — per its own docstring — nulls
"including the names of global variables bound via `load_from_db`" and is "the
right contract for anonymous consumers such as the public-flow endpoint". The
owner exporting their own flow is not an anonymous consumer, and the variable
name is not a secret (the stored flow and `GET /api/v1/flows/{id}` have always
carried it).

## 2. Why this looks unintended rather than a contract change

1. **The PR's stated scope is literal secrets.** The body describes the two
   leaking classes (`password: true` fields with ordinary names; connection
   strings). Variable bindings / `load_from_db` are not mentioned anywhere.
2. **The PR's test file never covers the bound case.** `src/backend/tests/unit/api/v1/test_export_secret_sanitization.py`
   (212 lines) contains zero occurrences of `load_from_db` — the case where
   `value` holds a variable *name* was never pinned in either direction.
3. **The scrubber already has the correct mode.** `strip_secret_field_values_in_place`
   accepts `variable_references`; when passed, fields the runtime resolves from
   the database keep their variable-name values (and the names are collected
   for a required-variables manifest). Deployment packaging (#14437) uses it
   for exactly the round-trip reason: "a deployment target can re-resolve the
   credential it provisions under that name". The export call site simply does
   not pass it.

## 3. Reproduction (API, deterministic)

Against any nightly ≥ 2026-08-20 (reproduced on `1.12.0.dev33`,
`LANGFLOW_AUTO_LOGIN=true`):

```bash
BASE=http://localhost:7860
TOKEN=$(curl -s $BASE/api/v1/auto_login | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"

# 1. Credential-type global variable
VAR_ID=$(curl -s -X POST $BASE/api/v1/variables/ -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"repro-binding","value":"not-the-point","type":"Credential","default_fields":[]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. Any flow whose template carries a SecretStrInput bound to it, e.g.:
#    "my_secret": { "_input_type": "SecretStrInput", "password": true,
#                   "load_from_db": true, "value": "repro-binding", ... }
#    (in the UI: drop any provider component, click the key icon on its secret
#     field, pick the variable — then grab the flow id from the URL)

# 3. Compare the two read surfaces
curl -s $BASE/api/v1/flows/$FLOW_ID -H "$AUTH" | grep -c repro-binding          # -> 1  (binding kept)
curl -s -X POST $BASE/api/v1/flows/download/ -H "$AUTH" \
  -H 'Content-Type: application/json' -d "[\"$FLOW_ID\"]" | grep -c repro-binding  # -> 0  (binding gone)
```

Observed on `1.12.0.dev33`: the download body carries
`"load_from_db": true, "value": null` and the string `repro-binding` appears
nowhere in it; the flow read returns `"value": "repro-binding"`. Import of the
downloaded JSON therefore produces a flow whose secret fields are unbound.

UI-level equivalent: create any flow with a provider component, bind a
Credential global variable to its API-key field, use **Export** — open the
downloaded JSON and the binding is gone.

## 4. Expected behavior

The export keeps the variable **name** for `load_from_db` fields (as it did
before #14639, and as `GET /api/v1/flows/{id}` still does) while continuing to
null literal secrets. That is precisely the scrubber's `variable_references`
mode; the fix is plausibly one line per call site
(`_build_flows_download_response`, `download_project_flows`,
`strip_version_data` — plus test coverage for the bound case).

## 5. Suite impact while open

- `security/credential-secret-exposure.spec.ts` — test *"the exported flow
  carries the credential binding, never the secret"* is quarantined
  (`test.fixme`, `@stable` removed) referencing this document and issue #1546.
  The spec's contract is unchanged; the quarantine lifts when the upstream fix
  lands in `langflowai/langflow-nightly:latest`.
- The serial sibling *"the run resolves the credential without echoing it"*
  resumes running (it was cascade-skipped while the export test hard-failed).
