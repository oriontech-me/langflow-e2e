# Spec: Webhook Component — API Key Display in the Generated cURL

**Test file:** `tests/tests-automations/regression/core-components/general-bugs-component-webhook-api-key-display.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev7`)

---

## What this test validates

The Webhook component generates a ready-to-use cURL command. Whether that command
includes the `x-api-key` header depends on the instance's webhook-auth config:

1. **Webhook auth enabled** (`webhook_auth_enable: true`, auto-login disabled) —
   the generated cURL **must** contain `x-api-key` so the user knows an API key
   is required to call the webhook.
2. **Webhook auth disabled** (`webhook_auth_enable: false`) — the cURL **must
   not** contain `x-api-key` (no key is needed) — asserted **only after** the
   value is confirmed to be a generated cURL, because an absent key and an
   absent cURL are otherwise the same observation. See *The absence needs an
   anchor* below.

Both cases are driven by mocking `GET /api/v1/config` (and, for case 1, forcing
`auto_login` off), then reading the generated cURL out of the component's cURL
text-area modal.

### dev46 node-inspector model

The nightly removed the inspect-panel on/off toggle and made the generated cURL
an **advanced** field. To read it: select the node, open the inspector
(`parameters-button`), add the cURL field to the node body
(`inspector-add-curl`), close the inspector (`inspection-panel-close`), then open
the cURL text-area modal from the node body via
`button_open_text_area_modal_str_curl` (previously
`button_open_text_area_modal_str_edit_curl_advanced`).

---

## Tags

`@release`

---

## Step by step

Both tests bootstrap the app, open a blank flow, and add the **Webhook**
component. Every flow the page creates is captured from its
`POST /api/v1/flows → 201` response and deleted id-scoped in `afterEach`.

**Test 1 — auth enabled → key shown:**
1. Route `GET /api/v1/auto_login` to `500` (auto-login off) and `GET /api/v1/config`
   to `{ webhook_auth_enable: true }`; `loginLangflow`.
2. Open a blank flow, add the Webhook component, select it.
3. Open the inspector, `inspector-add-curl`, close the inspector.
4. Open the cURL modal (`button_open_text_area_modal_str_curl`), read the
   text-area value, assert it **contains** `x-api-key`, close the modal.

**Test 2 — auth disabled → key hidden:**
1. Route `GET /api/v1/config` to `{ webhook_auth_enable: false }`.
2–4. Same as test 1, but assert the cURL **does not contain** `x-api-key`.

---

## Validation criterion

| Case | Criterion |
|---|---|
| both | the `text-area-modal` value is a generated cURL — it contains `curl -X POST` |
| `webhook_auth_enable: true` | that cURL contains `x-api-key` |
| `webhook_auth_enable: false` | that cURL does **not** contain `x-api-key` |

### The absence needs an anchor

Case 2's criterion used to be *"the generated cURL does not contain
`x-api-key`"* and nothing more, which is satisfied by the **empty string** —
`"".includes("x-api-key")` is `false`. A modal that opened without populating,
or populated with something else entirely, therefore read as a pass: the test
could be green having verified nothing.

The failure mode is concrete rather than hypothetical. The component declares
the field as a **placeholder the frontend substitutes** —
`MultilineInput(name="curl", value="CURL_WEBHOOK")` in
`lfx/components/input_output/webhook.py` — and the real command is assembled in
the frontend as `curl -X POST '<endpoint>' …` with the auth header in a
conditional slot. So if substitution ever fails, the field reads the literal
`CURL_WEBHOOK`, which contains no `x-api-key` and would have **passed** case 2
while the feature was broken.

The anchor is therefore `curl -X POST`, asserted in **both** cases before the
key claim: it is present in every generated command and absent from the
unsubstituted sentinel (`"CURL_WEBHOOK".includes("curl")` is `false` — the
sentinel is upper-case). Case 1 needs no anchor of its own for correctness, but
carries it so the two tests fail the same way when generation breaks, instead of
one failing on the key and the other passing.

---

## External dependencies

- `src/lfx/src/lfx/components/input_output/webhook.py` — Webhook component; the
  generated cURL and the `curl` advanced field.
- `GET /api/v1/config` (`webhook_auth_enable`) and `GET /api/v1/auto_login` — both
  mocked via `page.route`, so no real auth config is required.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` /
  `closeAdvancedOptions` (the dev46 inspector panel).
- `tests/helpers/auth/login-langflow.ts` — `loginLangflow` (test 1).

---

## What this test does not cover

- Actually invoking the webhook endpoint with/without the key.
- The API key rotation / regeneration flow.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No real API key required — config is
  mocked.

---

## Notes

- 1.13.0.dev7 (2026-09-09, issue #1786): promoted to `@stable`. The measured
  evidence is 3/3 green across nine `manual.yml` dispatches, recorded in
  `docs/triage/inherited-spec-triage.md`. The promotion added case 2's payload
  anchor (above), found by the force-failability audit design §3 requires before
  a green baseline is trusted — the assertion was green-able on an empty value.
- dev46 migration (issue #818): removed the dead `enable`/`disableInspectPanel`
  calls (the inspect-panel toggle feature was removed upstream), added the
  `inspector-add-curl` step (the cURL field became advanced), and renamed the
  modal-open testid `button_open_text_area_modal_str_edit_curl_advanced` →
  `button_open_text_area_modal_str_curl`. Added id-scoped `afterEach` flow
  cleanup (the spec had none).
- Validated on `1.11.0.dev46` (2026-07-19): 2 passed (~1.6m), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: the pre-fix run fails at the removed
  `canvas_controls_dropdown_toggle_inspector` testid (old `disableInspectPanel`).
