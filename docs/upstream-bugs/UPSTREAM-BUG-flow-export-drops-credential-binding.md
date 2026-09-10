# `POST /api/v1/flows/download/` drops the credential variable binding — exported flows no longer import with their variables bound

| Field | Value |
|---|---|
| **Filed upstream** | _still pending_ (report in §1–§4, suggested title in §6; owner: QA team) — **the blocking deliverable**: nothing has been reported to the people who can fix this, and the quarantine hides it from our own dailies |
| **Last re-checked** | 2026-09-10 — **no upstream fix has landed**; the quarantine stands. Evidence in §6 |
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

## 6. Re-check log, and why re-measuring is not the next step

**2026-09-10 — no upstream fix. The quarantine stands and nothing about the
product has changed.** Checked against `langflow-ai/langflow` rather than against
a nightly, because "did the fix land" is answerable from the code itself.

**Named refs, because the answer is ref-dependent and this repo has been bitten
by that**: the nightly is cut from the release line under development, *not* from
`main`, and merge-back is sporadic — so a `main`-only walk can report "not fixed"
about a fix that shipped. Checked on `origin/main` **and** `origin/release-1.12.0`,
`release-1.12.1`, `release-1.12.2`, `release-1.13.0`.

**Every file the causing commit touched is byte-identical to its own tree, on all
five refs** — the six product files and its own unit test. That is stronger than a
commit walk, and it is what the trigger below keys on:

```bash
for p in utils/flow_secrets.py api/v1/flows_helpers.py api/v1/projects_files.py \
         api/v1/flow_version.py api/utils/core.py api/utils/__init__.py; do
  for r in fc3810da origin/main origin/release-1.12.{0,1,2} origin/release-1.13.0; do
    git rev-parse "$r:src/backend/base/langflow/$p"
  done
done
# flow_secrets.py    12f2a5e   flow_version.py     b946d66
# flows_helpers.py   96dab51   api/utils/core.py   a7e336c
# projects_files.py  05ecd47   api/utils/__init__  d78506f
# each identical on fc3810da and on all five watched refs
```

Four of the six carry the logic: the scrubber, plus the three call sites the cause
migrated onto it — `flows_helpers.py` (`POST /api/v1/flows/download/`),
`projects_files.py` (`download_project_flows`, i.e.
`GET /api/v1/projects/download/{id}`) and `flow_version.py` (`strip_version_data`,
which serves `GET /api/v1/flows/{flow_id}/versions/{version_id}`; the header row
lists it under *Sibling surfaces* because the same PR moved it onto the same
scrubber, not because it is an export endpoint). `api/utils/` contributes
`normalize_flow_for_export`, which runs **after** `strip_flow_secrets` on both
download surfaces (`flows_helpers.py:808`, `projects_files.py:78`) and so cannot
restore a value already nulled.

Outside the six sit the two route handlers — `flows.py:1292`
(`download_multiple_file`) and `projects.py:1074` (`download_file`) — which fetch
and authorize but hold no scrubber call. There is no `lfx` copy of the scrubber
either: `git grep -l strip_secret_field_values <ref> -- 'src/lfx/**'` is empty on
all five refs, where the control `secret_value_to_str` returns four files.

**Two mistakes the first version of this section made**, recorded because both
made the trigger narrower than it looked. Its watch table omitted
`flow_version.py` and watched `api/v1/projects.py` instead — which declares the
`GET /download/{project_id}` route and calls `download_project_flows`
(`projects.py:1103`), but holds no scrubber call and was not touched by the cause
— so a fix landing on either real sibling surface was invisible to it. And it
listed `c3bfdb7d` as a commit "since 2026-08-19" when it is dated 2026-08-18,
before the cause.

### The trap: the binding-preserving mode predates the bug

**Reading `flow_secrets.py` and concluding "already fixed" is the mistake to avoid,
and the true story is not the one this section first recorded.** The file carries
`_is_variable_reference` and a `variable_references` mode that preserves
`load_from_db` bindings — which reads exactly like the repair §4 asks for. Both
arrived in `0a1833f234` (#14437, *deterministic project deployment artifacts*,
2026-08-10), **nine days before** the cause:

```bash
git log origin/main --reverse -S'_is_variable_reference' --oneline \
  -- src/backend/base/langflow/utils/flow_secrets.py
# 0a1833f234 feat: add deterministic project deployment artifacts (#14437)
git show fc3810da^:src/backend/base/langflow/utils/flow_secrets.py | grep -c _is_variable_reference
# 3   ← already there, pre-cause
```

`fc3810da`'s change to that file is +24/−1: it adds `strip_flow_secrets` and
tightens `strip_secret_field_values`'s short-circuit from `if not flow_data:` to
`if flow_data is None:`.
What it did was move the export call sites off the legacy `remove_api_keys`
(`password`-marked **and** API-key-named) onto the broader metadata-driven scrubber
— `password` **or** secret-named, `flow_secrets.py:308` — **without** passing the
`variable_references` mode #14437 had already added. So the correct machinery is
sitting in the file, unreferenced by the export path. (§2 point 3 credits #14437
correctly; an earlier version of this section contradicted it.)

### Why a re-measurement is not the next step

Two reasons, and the mechanical one comes first: the test is `test.fixme`, so **no
`manual.yml` dispatch runs it at all** — not by tag, not by `--grep`. Re-measuring
today means §3's by-hand reproduction, or lifting the quarantine first. And even
then it would spend CI to confirm what the blob identity above already settles.

It becomes the right move the moment any of those blobs changes on any watched
ref — and at that point the order is: reproduce by hand (§3), then lift.

### What filing it needs

§1–§4 are the report; §3 is a deterministic reproduction that needs no LLM key.
The one thing missing is the act of posting. **The usual channel here is DataStax
Jira** — every other `UPSTREAM-BUG-*` file in this directory names an `LE-####`
except one, which reads *"Not yet — evidence collected here first"* — and
`REGRESSIONS.md:12` accepts either a Jira ticket or a `langflow-ai/langflow`
issue —
so this does not require an upstream GitHub account or a public statement; a Jira
ticket is enough to unblock the deliverable. Suggested title, covering all three
surfaces rather than only the one the H1 names:

> Flow and project export null `load_from_db` credential bindings — `POST /api/v1/flows/download/` and `GET /api/v1/projects/download/{id}` drop the variable name, and version reads (`strip_version_data`) do the same

Once filed, put the ticket in the **Filed upstream** row above and, if upstream
disputes the intent (§2), record the answer in §4 rather than in the ticket thread
alone — the quarantine's lifetime depends on it.
