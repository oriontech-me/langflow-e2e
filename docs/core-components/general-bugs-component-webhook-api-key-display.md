# Spec: Webhook Component — API Key Display in the Generated cURL

**Test file:** `tests/tests-automations/regression/core-components/general-bugs-component-webhook-api-key-display.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates

The Webhook component generates a ready-to-use cURL command. Whether that command
includes the `x-api-key` header depends on the instance's webhook-auth config:

1. **Webhook auth enabled** (`webhook_auth_enable: true`, auto-login disabled) —
   the generated cURL **must** contain `x-api-key` so the user knows an API key
   is required to call the webhook.
2. **Webhook auth disabled** (`webhook_auth_enable: false`) — the cURL **must
   not** contain `x-api-key` (no key is needed).

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
| `webhook_auth_enable: true` | the generated cURL (`text-area-modal` value) contains `x-api-key` |
| `webhook_auth_enable: false` | the generated cURL does **not** contain `x-api-key` |

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

- dev46 migration (issue #818): removed the dead `enable`/`disableInspectPanel`
  calls (the inspect-panel toggle feature was removed upstream), added the
  `inspector-add-curl` step (the cURL field became advanced), and renamed the
  modal-open testid `button_open_text_area_modal_str_edit_curl_advanced` →
  `button_open_text_area_modal_str_curl`. Added id-scoped `afterEach` flow
  cleanup (the spec had none).
- Validated on `1.11.0.dev46` (2026-07-19): 2 passed (~1.6m), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: the pre-fix run fails at the removed
  `canvas_controls_dropdown_toggle_inspector` testid (old `disableInspectPanel`).
