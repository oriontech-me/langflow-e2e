# Groq Provider — configure key on the component, execute flow

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

The Groq provider path (QA-CHECKLIST §7.6 "Configure and execute flow with
Groq") as a single component-centric journey, mirroring the §7.6 sibling
`ollama-provider.spec.ts`:

A blank canvas flow (Chat Input → Groq → Chat Output) is configured with the
Groq API key **on the component**, a model is selected from the component's
live-refreshed catalog, and a Playground run returns a non-empty reply —
proving the configured provider performs a real cloud inference.

**Why not a Settings → Model Providers test (premise change, found live):**
on the 1.11 nightly the Settings page does NOT list Groq ("No providers match
your search"), even though `GET /api/v1/models/providers` includes it. The
key has no Settings surface; the component's `api_key` field is the configure
surface. This UI/API divergence is flagged on the PR as a product
observation.

If this fails, Groq can no longer be configured or executed — the first
OpenAI-compatible alt-cloud provider covered by the suite.

---

## Tags *(required)*

`@stable` `@components` `@model-provider` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@components` (cross-cutting — canvas component configuration) ·
`@model-provider` (area) · `@playground` (executes via Playground).
No `@settings`: the Settings surface does not exist for Groq (see above).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `GROQ_API_KEY` set in `.env` (valid, live key — the test probes the Groq
  API directly and **skips with an explicit reason** when the key is missing,
  invalid, or the API is unreachable; never a silent green).
- Optional `GROQ_TEST_MODEL` (default `llama-3.1-8b-instant`) — must exist in
  the live Groq catalog; the probe skips with a reason if it doesn't.
- Run with `--workers=1` (the test creates a flow; file is serial).

---

## Step by step *(required)*

**Component-availability pre-flight (#907 / LE-1987):** `GET /api/v1/all` and
check the component registry (second-level component-type keys) for a `groq`
type. When the nightly ships without `langchain-groq`, Langflow hides the Groq
component entirely (it drops out of the sidebar AND the registry), so the later
`waitForSelector('[data-testid="groqGroq"]')` would hard-fail after 30s. This
probe runs **first** and `test.skip`s with an explicit reason ("Groq component
not available in this Langflow build") — turning an upstream packaging gap into
an honest skip, not a misleading UI timeout. It auto-clears (the test runs
again) the moment the package returns to the build. Distinct from the cloud-API
probe below, which only validates the key, not Langflow's ability to expose the
component.

**Probe:** `GET https://api.groq.com/openai/v1/models` with the key from the
env. Missing key / non-200 / test model absent from the catalog →
`test.skip` with the concrete reason. This turns an unfunded or revoked key
into an explicit skip instead of a mid-test failure (zero-credit lesson from
the Anthropic sibling, #503).

**Test — a canvas flow configures the Groq key and executes** (§7.6)

1. Create a **blank flow**; capture the flow id from the `POST /api/v1/flows`
   201 response (transient-id-safe; deleted in `finally`).
2. Add **Chat Output**, **Chat Input**, and the **Groq** component
   (`groqGroq` → `add-component-button-groq`); connect Chat Input → Groq
   (`handle-groqmodel-shownode-input-left`) and Groq
   (`handle-groqmodel-shownode-model response-right`) → Chat Output
   (click-source-then-target handle pattern; expect 2 edges).
3. **Configure the API key on the Groq node** — fill
   `popover-anchor-input-api_key` with `GROQ_API_KEY`. The field is
   `real_time_refresh`: the fill/blur triggers a
   `POST /api/v1/custom_component/update` that re-fetches the model catalog
   **live from the Groq API** (live-verified: the refreshed dropdown contains
   live-only models absent from the static fallback constants) — wait for it
   to resolve **200** before trusting the dropdown.
4. **Select the test model** in `dropdown_str_model_name` (option with the
   exact `GROQ_TEST_MODEL` text); assert
   `value-dropdown-dropdown_str_model_name` shows it; wait for the debounced
   autosave to settle (`waitForFlowSaveSettled`) so the Playground builds the
   persisted flow.
5. Open the Playground; send
   `Repeat this token exactly and nothing else: GROQ-<per-run sentinel>`;
   wait for the run to finish.
6. **Validation:** the last `div-chat-message` (AI bubble) is **non-empty**
   (hard — the Groq cloud inference executed with the configured key; there
   is no keyless path to a reply). The sentinel echo is **logged, not
   asserted** (family convention).
7. **Cleanup:** delete the flow by id in `finally` (`deleteFlow`, 404-safe).

---

## Validation criterion *(required)*

With the key configured on the component: the `custom_component/update`
triggered by **this** key fill resolves 2xx, the `model_name` dropdown offers
the test model and the selection shows its exact name, and the Playground run
returns a non-empty AI reply — a real Groq inference, impossible without a
valid key.

## Guarding against false positives *(how)*

- **Probe-gated skips:** missing/invalid key or absent model → explicit
  `test.skip` reason, never a silent pass.
- The `custom_component/update` **200** waiter is armed around the key fill —
  a rejected or ignored key cannot satisfy it causally.
- The model assert uses the **exact** `GROQ_TEST_MODEL` text in the selected
  value — a stale or fallback selection fails.
- The non-empty reply requires a genuine authenticated inference — Groq has
  no anonymous path.
- **Force-failure check** (CONTRIBUTING §2) runs during VERIFY: each assertion
  broken on purpose once, confirmed red, before `@stable`.

---

## What this test does not cover *(optional)*

- A Settings → Model Providers journey — the surface does not exist for Groq
  on 1.11 (see the premise-change note; product observation flagged on the PR).
- Groq models inside the **Agent**'s model dropdown.
- Invalid-key error UI (see `provider-invalid-auth-error.spec.ts` pattern).
- Groq-specific parameters (temperature, max tokens, tool models).
- Mistral (§7.6 sibling bullet — #500, own spec).

---

## External dependencies *(required)*

- `lfx_bundles/groq/groq.py` (Groq component) — `api_key`
  (`real_time_refresh`), `model_name` dropdown fed by `get_groq_models`;
  moved from `lfx.components.groq` to the `lfx-bundles` distribution (shim in
  place on 1.11; the deprecation window closes at M4).
- `src/frontend/` canvas — sidebar search (`sidebar-search-input`,
  `groqGroq`, `add-component-button-groq`), node handles
  (`handle-groqmodel-shownode-*`), component inputs
  (`popover-anchor-input-api_key`, `dropdown_str_model_name`).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O.
- Groq API (`api.groq.com`) — probe, live catalog refresh, and the real
  inference. A live `GROQ_API_KEY` is required; **CI note:** the workflows
  don't carry a `GROQ_API_KEY` secret yet — in CI the test skips with the
  probe reason until the secret is added (same degradation contract as
  Ollama-less runs).

---

## When to review this test *(optional)*

- If Groq gains a Settings → Model Providers surface (add the Settings
  configure test back — family pattern in
  `anthropic-provider.spec.ts` Test 1).
- If the Groq component's fields (`api_key`, `model_name`) or its bundle
  location change.
- If the Groq catalog drops `llama-3.1-8b-instant` (override via
  `GROQ_TEST_MODEL`).

---

## Notes *(optional)*

- **Premise change vs the issue (found by live scout during PLAN):** the
  issue and the first draft of this doc assumed the keyed-provider family
  shape (Settings Test 1 + execution Test 2). The Settings page on the 1.11
  nightly does not list Groq — search returns "No providers match your
  search" — while the backend `GET /api/v1/models/providers` DOES list it.
  The spec was re-scoped to the component-only journey (which fully satisfies
  the §7.6 bullet "Configure and execute flow with Groq"); the UI/API
  divergence goes on the PR as a product observation for upstream triage.
- **Live-catalog observable:** the static fallback catalog overlaps the live
  one on the test model, so dropdown *presence* alone can't prove the key
  works — the causal `custom_component/update` 200 wait plus the real
  inference carry that proof. (Scout evidence: with the key set, the dropdown
  lists live-only models such as `meta-llama/llama-4-scout-17b-16e-instruct`,
  absent from `groq_constants.py`.)
- **Per-run sentinel** logged, not asserted (family convention).
- **`.env.example`** gains `GROQ_API_KEY` (+ optional `GROQ_TEST_MODEL`)
  alongside the existing provider keys.
