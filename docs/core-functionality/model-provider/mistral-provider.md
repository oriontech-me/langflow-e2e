# Mistral Provider — configure key on the component, execute flow

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Mistral provider path (QA-CHECKLIST §7.6 "Configure and execute flow with
Mistral") as a single component-centric journey, mirroring the §7.6 siblings
`ollama-provider.spec.ts` and `groq-provider.spec.ts`:

A blank canvas flow (Chat Input → MistralAI → Chat Output) is configured with
the Mistral API key **on the component**, a model is selected from the
component's dropdown, and a Playground run returns a non-empty reply —
proving the configured provider performs a real cloud inference.

**Why component-centric:** like Groq (#499), Mistral has no Settings → Model
Providers surface on 1.11 — `GET /api/v1/models/providers` does not list it
at all. The component's `api_key` field is the configure surface.

If this fails, Mistral can no longer be configured or executed in a flow.

---

## Tags *(required)*

`@stable` `@components` `@model-provider` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@components` (cross-cutting — canvas component configuration) ·
`@model-provider` (area) · `@playground` (executes via Playground).
No `@settings`: the Settings surface does not exist for Mistral.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `MISTRAL_API_KEY` set in `.env` (valid, live key — the test probes the
  Mistral API directly and **skips with an explicit reason** when the key is
  missing, invalid, or the API is unreachable; never a silent green).
- Optional `MISTRAL_TEST_MODEL` (default `mistral-small-latest`) — must be
  one of the component's static dropdown options AND in the live Mistral
  catalog; the probe skips with a reason if absent from the catalog.
- Run with `--workers=1` (the test creates a flow; file is serial).

---

## Step by step *(required)*

**Probe:** `GET https://api.mistral.ai/v1/models` with the key from the env.
Missing key / non-200 / test model absent from the catalog → `test.skip`
with the concrete reason (zero-credit lesson from #503; free-tier keys can
also be rate-limited — a 429 surfaces as an explicit skip reason, not a
mid-test mystery).

**Test — a canvas flow configures the Mistral key and executes** (§7.6)

1. Create a **blank flow**; capture the flow id from the `POST /api/v1/flows`
   201 response (transient-id-safe; deleted in `finally`).
2. Add **Chat Output**, **Chat Input**, and the **MistralAI** component
   (`mistralMistralAI` → `add-component-button-mistralai`); connect Chat
   Input → MistralAI (`handle-mistralaimodelcomponent-shownode-input-left`)
   and MistralAI (`handle-mistralaimodelcomponent-shownode-model
   response-right`) → Chat Output (click-source-then-target handle pattern;
   expect 2 edges).
3. **Configure the API key on the MistralAI node** — fill
   `popover-anchor-input-api_key` with `MISTRAL_API_KEY`. Unlike Groq, the
   field is NOT `real_time_refresh` and the `model_name` dropdown is a
   **static list** (6 options hardcoded in `lfx_bundles/mistral/mistral.py`)
   — there is no live-catalog request to await; the execution carries the
   key-works proof.
4. **Select the test model** in `dropdown_str_model_name` (option with the
   exact `MISTRAL_TEST_MODEL` text); assert
   `value-dropdown-dropdown_str_model_name` shows it; wait for the debounced
   autosave to settle (`waitForFlowSaveSettled`) so the Playground builds the
   persisted flow.
5. Open the Playground; send
   `Repeat this token exactly and nothing else: MISTRAL-<per-run sentinel>`;
   wait for the run to finish.
6. **Validation:** the last `div-chat-message` (AI bubble) is **non-empty**
   (hard — the Mistral cloud inference executed with the configured key;
   there is no keyless path to a reply). The sentinel echo is **logged, not
   asserted** (family convention).
7. **Cleanup:** delete the flow by id in `finally` (`deleteFlow`, 404-safe).

---

## Validation criterion *(required)*

With the key configured on the component: the `model_name` selection shows
the exact `MISTRAL_TEST_MODEL` text, and the Playground run returns a
non-empty AI reply — a real authenticated Mistral inference, impossible
without a valid key (the fixture also fails the test on any flow-execution
error event, so an auth failure cannot pass silently).

## Guarding against false positives *(how)*

- **Probe-gated skips:** missing/invalid key or absent model → explicit
  `test.skip` reason, never a silent pass.
- The model assert uses the **exact** `MISTRAL_TEST_MODEL` text in the
  selected value — a stale or default (`codestral-latest`) selection fails.
- The non-empty reply requires a genuine authenticated inference — Mistral
  has no anonymous path; the fixtures' flow-error monitor fails the test if
  the build errors instead.
- **Force-failure check** (CONTRIBUTING §2) runs during VERIFY: each
  assertion broken on purpose once, confirmed red, before `@stable`.

---

## What this test does not cover *(optional)*

- A Settings → Model Providers journey — the surface does not exist for
  Mistral on 1.11 (not even in `GET /api/v1/models/providers`).
- Live model-catalog refresh — the component's dropdown is static by design
  (unlike Groq); catalog drift is caught by the probe, not the dropdown.
- Mistral embeddings (`MistralAI Embeddings` is a separate component).
- Mistral-specific parameters (temperature, top-p, max tokens, retries).
- Global-variable binding for the key (the `api_key` field defaults to the
  `MISTRAL_API_KEY` global variable name; this spec fills the raw key —
  deterministic and family-consistent).

---

## External dependencies *(required)*

- `lfx_bundles/mistral/mistral.py` (MistralAI component) — `api_key`
  (SecretStrInput, required), static `model_name` dropdown; shim in
  `lfx.components.mistral` until the lfx-bundles deprecation window closes.
- `src/frontend/` canvas — sidebar search (`sidebar-search-input`,
  `mistralMistralAI`, `add-component-button-mistralai`), node handles
  (`handle-mistralaimodelcomponent-shownode-*`), component inputs
  (`popover-anchor-input-api_key`, `dropdown_str_model_name`).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O.
- Mistral API (`api.mistral.ai`) — probe and the real inference. A live
  `MISTRAL_API_KEY` is required; **CI note:** the workflows don't carry a
  `MISTRAL_API_KEY` secret yet — in CI the test skips with the probe reason
  until the secret is added (same degradation contract as Groq/Ollama).

---

## When to review this test *(optional)*

- If Mistral gains a Settings → Model Providers surface (add the Settings
  configure test — family pattern in `anthropic-provider.spec.ts` Test 1).
- If the MistralAI component's fields or its static model list change
  (`mistral-small-latest` leaving the options breaks the selection step —
  override via `MISTRAL_TEST_MODEL` only works within the static list).
- If the component's bundle location changes (lfx-bundles M4 window).

---

## Notes *(optional)*

- **Static dropdown caveat:** `MISTRAL_TEST_MODEL` must satisfy BOTH the
  component's hardcoded option list and the live catalog. The probe checks
  the live catalog; the dropdown-selection step inherently checks the static
  list (a model absent from the options fails the exact-name assert).
- **Per-run sentinel** logged, not asserted (family convention).
- **`.env.example`** gains `MISTRAL_API_KEY` (+ optional `MISTRAL_TEST_MODEL`)
  alongside the Groq block.
