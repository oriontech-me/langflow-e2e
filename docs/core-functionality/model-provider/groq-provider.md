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

`@components` `@model-provider` `@playground`

`@components` (cross-cutting — canvas component configuration) ·
`@model-provider` (area) · `@playground` (executes via Playground).
No `@settings`: the Settings surface does not exist for Groq (see above).

**No `@stable` — the component is not packaged in the image this suite
validates (#1039), and the standing answer is
`docs/component-distribution-policy.md` rather than a tracker, so this is not
re-decided per incident.** Langflow 1.12 moved component families out of
`lfx.components.*` into per-vendor distributions plus an aggregate
`lfx-bundles` package; `langflowai/langflow-nightly:latest` installs ~20 vendor
distributions and no `lfx-bundles`, so the Groq component is absent from
`GET /api/v1/all` and the test's availability pre-flight skips it on **every**
run. A tag that can never produce a verdict is worse than no tag: it would
credit coverage in the generated `Phase 0 — Validated` block for assertions
that never execute.

This is a **product packaging decision, not a regression** — Groq remains a
supported provider, and the test itself is valid. Verified on 1.12.0.dev8: with
`uv pip install lfx-bundles langchain-groq` + a restart, the test **passes**
against a real Groq cloud inference, and a deliberately inverted reply assert
turns it red. Two packages are required, not one — `lfx-bundles` alone exposes
the component but the run then dies with `ComponentBuildError: Error building
Component Groq: langchain-groq is not installed`.

Restore `@stable` only if the component returns to the default nightly image.
**Re-confirmed 2026-09-15 on `1.13.0.dev8` and `1.13.0.dev12`** — two minor
lines past the 1.12.0.dev8 measurement above, `GET /api/v1/all` still carries
**zero** occurrences of `groq` anywhere in its payload, so nothing about the
absence has moved and the pre-flight still skips before a key is ever read.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `GROQ_API_KEY` set in `.env` (valid, live key — the test probes the Groq
  API directly and **skips with an explicit reason** when the key is missing,
  invalid, or the API is unreachable; never a silent green).
- Optional `GROQ_TEST_MODEL` (default `llama-3.1-8b-instant`) — must exist in
  the live Groq catalog; the probe skips with a reason if it doesn't.
  **The Groq catalog is per ACCOUNT, and the default is not in every one of
  them.** Measured 2026-09-13 against this repository's key: 14 models, none
  of the llama-3.1 line (`openai/gpt-oss-*`, `qwen/qwen3.x`, `groq/compound*`,
  whisper, `allam-2-7b`). The CI lanes therefore pin `openai/gpt-oss-20b`
  through the repository VARIABLE `GROQ_TEST_MODEL` — a variable and not a
  secret, so the probe's skip reason keeps naming the model instead of `***`.
- **A pin outside `groq_constants.py` is a new failure mode, not just a
  different model.** The dropdown is not the account catalog: it is that
  catalog filtered by a live probe per model
  (`groq_model_discovery.py::_test_chat_completion` / `_test_tool_calling`,
  which drop entries as `not_supported`), and when discovery fails
  `_get_fallback_models()` returns the STATIC list. That static list contains
  `llama-3.1-8b-instant` and does **not** contain `openai/gpt-oss-20b`. So
  under a discovery fallback the dropdown offers the retired default, the
  `toContainText` assertion **fails** rather than skipping, and the red means
  "discovery fell back", not "the model is gone".
- Run with `--workers=1` (the test creates a flow; file is serial).

---

## Step by step *(required)*

**Component-availability pre-flight (#907, #1039):** `GET /api/v1/all` and
check the component registry (second-level component-type keys) for a `groq`
type. The default nightly image does not install the distribution that ships
the Groq component, so it is absent from the sidebar AND the registry, and the
later `waitForSelector('[data-testid="groqGroq"]')` would hard-fail after 30s.
This probe runs **first** and `test.skip`s with an explicit reason ("Groq
component not exposed by this Langflow build") — turning a packaging decision
into an honest skip, not a misleading UI timeout. It auto-clears (the test runs
again) the moment the component returns to the build. Distinct from the
cloud-API probe below, which only validates the key, not Langflow's ability to
expose the component.

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
  inference. A live `GROQ_API_KEY` is required. **CI note — the lanes now carry
  it, and that changes nothing here:** `GROQ_API_KEY` (secret) reaches
  `daily-stable.yml`, `pr-validation.yml` and `manual.yml`, and
  `GROQ_TEST_MODEL` (repository variable, `openai/gpt-oss-20b`) reaches the
  first two, all since 2026-09-13. The key is therefore **not** why CI skips
  this test — the component-availability pre-flight above runs first and
  unconditionally, so the key probe is not reached while the component is
  absent. An earlier revision of this note said the workflows carried no secret
  yet; that named a second cause which no longer exists, and a parked spec
  whose doc names the wrong cause is the expired justification #1783 exists to
  report. One gap left standing because it is unreachable today:
  `manual.yml` receives the key but **not** `GROQ_TEST_MODEL`, so a dispatch
  there would fall back to the `llama-3.1-8b-instant` default this account does
  not serve and skip on the probe — visible only if the component ever returns.

---

## When to review this test *(optional)*

- If Groq gains a Settings → Model Providers surface (add the Settings
  configure test back — family pattern in
  `anthropic-provider.spec.ts` Test 1).
- If the Groq component's fields (`api_key`, `model_name`) or its bundle
  location change.
- ~~If the Groq catalog drops `llama-3.1-8b-instant`~~ — this HAPPENED, and it
  was measured on 2026-09-13: the account behind this repository's key does not
  serve it. The lanes now pin `openai/gpt-oss-20b` via the repository variable
  `GROQ_TEST_MODEL`. What is left to review is the pin itself: if that model
  leaves the account's catalog, or if Groq's discovery starts falling back to
  the static list (see Preconditions), this test fails instead of skipping.

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
