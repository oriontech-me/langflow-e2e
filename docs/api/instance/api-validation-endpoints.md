# API Validation — code, prompt and custom-component endpoints

**File:** `tests/tests-automations/regression/api/instance/api-validation-endpoints.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev25`)

Owning issue: #1710 (Wave 7 — OSS API coverage). Gauge, definitions and denominator:
`docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Four hidden operations the UI leans on constantly and no `@api` spec asserts:
`POST /api/v1/validate/code`, `POST /api/v1/validate/prompt`,
`POST /api/v1/custom_component` and `POST /api/v1/custom_component/update`. The first
`custom_component` route is driven (undeclared) by
`api/flows/api-custom-component-creation.spec.ts`; the other three are new here.

**The finding: both validators answer `200` for input they consider broken.** The
verdict is in the body, exactly like `POST /api/v1/models/validate-provider` (#1709) —
a status-only assertion would report a compile error as valid code.

Measured on `1.13.0.dev2`:

| Operation | Answer |
|---|---|
| `POST /validate/code` `{"code": "def f():\n    return 1\n"}` | `200 {"imports": {...}, "function": {...}}` |
| `POST /validate/code` with a **syntax error** | **`200`**, the same two keys, with the failure described *inside* `function` |
| `POST /validate/prompt` `{name, template}` — **no `frontend_node`** | `200 {"input_variables": [], "frontend_node": null}` — it **short-circuits**: the template is *not* parsed, so `{x}` yields nothing |
| `POST /validate/prompt` with a real `frontend_node` (the `Prompt Template` node out of `GET /api/v1/all`) and `template: "Hello {who}"` | `200`, `input_variables: ["who"]`, and the **returned node's `template` has gained a `who` field** — the endpoint is what turns a template's variables into node inputs |
| `POST /validate/prompt` without `template` | `422` |
| `POST /custom_component` `{code, frontend_node:{template:{}}}` | `200 {"data": {...}, "type": …}` — `data.template` carries the component's declared inputs. From `1.14.0.dev24` the body carries a third key, `warnings: []` — see *Contract change on 1.14.0.dev24* below |
| `POST /custom_component/update` `{code, field, field_value, template}` | `200 {"template": {...}}` with the submitted code echoed back inside `template.code.value` |

The `input_variables: []` short-circuit is the half most likely to be misread: it looks
like a parse failure and is actually the documented path
(`if not prompt_request.frontend_node: return …`), which is why the spec asserts **both**
branches in the same test — the empty one and the one that extracts `who`.

### Contract change on `1.14.0.dev24` — `warnings` (#2423)

The daily of 2026-11-12 (`1.14.0.dev25`) turned test 3 red on all three attempts: the
body of `POST /custom_component` carried `warnings` beside `data` and `type`. It is an
**intended, additive** contract change, not a regression: upstream #16255 (*"integrate
administrator upgrade reports and repairs"*, commit `2c403778d80`, merged into
`release-1.14.0` on 2026-11-10 and first tagged in `v1.14.0.dev24`) moved the route onto
`update_rebuilt_node(…, warnings=…)` and added `warnings: list[ComponentUpdateWarning]`
(default `[]`) to `CustomComponentResponse`. Each warning is
`{code: "generated_fields_not_restored", fields, refresh_fields, unverified,
inputs_unverified, outputs_unverified}` — emitted when an Update could not restore a
saved node's generated fields or its refresh hooks failed. Not on `main` and not on any
`release-1.13.x` line when measured.

So the key set is **version-gated** through `servedVersionAtLeast(request,
"1.14.0.dev24")`, decided by the version the instance declares and never by the body
(asking *"does it carry `warnings`?"* would pass a build that lost the key by accident):
`["data", "type", "warnings"]` from `dev24`, `["data", "type"]` below it. On the new side
`warnings` is also asserted to deep-equal `[]`: the probe component has no generated
fields and no refresh hooks, so a warning there would mean the route reports an Update
problem for a component that cannot have one. Measured on `1.14.0.dev25`: `[]`, with
and without `frontend_node`.

Not asserted here, but recorded so the next author does not trip on it:
`/validate/code` passes the code through the **catalog policy** gate
(`resolve_component_code_for_action`), so a governance-restricted instance answers
`"Custom component validation is disabled"` or `"…restricted to administrators"`. That
matrix belongs to the `@governance` lane, not to this file.

---

## Tags *(required)*

`@api` `@components` `@stable`

`@stable`: no provider, no model, no run — the payloads are a two-line component and a
prompt template.

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`. Nothing
persists (these endpoints validate and return; they create no rows), so there is no
cleanup.

**Test 1 — `code validation answers 200 for broken code, with the verdict in the body`**
1. Valid component code → `200`, keys exactly `{imports, function}`.
2. `"def f(:"` → **`200`** with the same keys, and the `function` object non-empty —
   asserted as *the verdict is here*, never as a status.

**Test 2 — `prompt validation extracts variables only when given a node`**
1. `{name, template: "Hello {who}"}` → `200`, `input_variables` `[]`,
   `frontend_node` `null`.
2. `GET /api/v1/all` → take `models_and_agents["Prompt Template"]` (the catalog is keyed
   by **display name**), send it as `frontend_node` with the same template → `200`,
   `input_variables` deep-equal `["who"]`, and the returned
   `frontend_node.template` now contains a `who` key that the input node did not have.
3. Omit `template` → `422`.

**Test 3 — `a custom component is described, and a field update echoes the code`**
1. `GET /api/v1/version` decides the side of the `1.14.0.dev24` contract change.
2. `POST /custom_component` with a two-input component → `200`, keys exactly
   `{data, type, warnings}` from `dev24` (with `warnings` deep-equal `[]`) or
   `{data, type}` below it, and `data.template` contains the declared input name.
3. `POST /custom_component/update` with the same code and a field → `200`, and
   `template.code.value` is the code that was sent.

---

## Validation criterion *(required)*

The three tests pass three consecutive times at `--retries=0 --workers=1`, with the
broken-code case asserted as **`200` plus a non-empty verdict object** (the assertion
that makes the status trap visible), the prompt validator asserted on **both** branches
in one test, the extracted variable asserted as a deep equality on `["who"]` *and* as a
new key on the returned node, and the declared coverage — the four operations —
matching what the fixture recorded.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser,
  with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS` at its lane default (every lane and both
  start scripts set it `true`, #668).
- `src/backend/base/langflow/api/v1/validate.py` — both validators.
- `src/backend/base/langflow/api/v1/base.py` — `Code`, `ValidatePromptRequest`,
  `CodeValidationResponse`, `PromptValidationResponse`.
- `src/backend/base/langflow/api/v1/schemas/__init__.py` — `CustomComponentResponse`,
  whose `warnings` field is the `1.14.0.dev24` change.
- `src/lfx/src/lfx/custom/utils.py` — `update_rebuilt_node`, which fills `warnings`;
  `src/lfx/src/lfx/custom/schema.py` — the `ComponentUpdateWarning` shape.
- `src/backend/base/langflow/api/v1/endpoints.py` — `GET /api/v1/all`, the source of
  the real `frontend_node`, and the two `custom_component` routes.
- No provider key, no model, no network egress.
