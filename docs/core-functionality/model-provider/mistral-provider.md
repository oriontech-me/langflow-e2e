# Mistral Provider — configure key on the component, execute flow

**Last validated:** Langflow 1.12.x — and it stays there deliberately. The only
run that ever exercised this test was on `1.12.0.dev8` with `lfx-bundles` +
`langchain-mistralai` installed by hand (see *Tags*); the 1.13 measurement below
re-confirms the component's **absence**, which is not a validation of the test.

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

`@components` `@model-provider` `@playground`

`@components` (cross-cutting — canvas component configuration) ·
`@model-provider` (area) · `@playground` (executes via Playground).
No `@settings`: the Settings surface does not exist for Mistral.

**No `@stable` — the component is not packaged in the image this suite
validates (#1039), and the standing answer is
`docs/component-distribution-policy.md` rather than a tracker, so this is not
re-decided per incident.** Langflow 1.12 moved component families out of
`lfx.components.*` into per-vendor distributions plus an aggregate
`lfx-bundles` package; `langflowai/langflow-nightly:latest` installs ~20 vendor
distributions and no `lfx-bundles`, so the MistralAI component is absent from
`GET /api/v1/all` and the test's availability pre-flight skips it on **every**
run. A tag that can never produce a verdict is worse than no tag: it would
credit coverage in the generated `Phase 0 — Validated` block for assertions
that never execute.

This is a **product packaging decision, not a regression** — Mistral remains a
supported provider, and the test itself is valid. Verified on 1.12.0.dev8: with
`uv pip install lfx-bundles langchain-mistralai` + a restart, the test
**passes** against a real Mistral cloud inference, and a deliberately inverted
reply assert turns it red. Two packages are required, not one — `lfx-bundles`
alone leaves the `mistral` registry category present but **empty**; the
`langchain-mistralai` package is what makes
`ext:mistral:MistralAIModelComponent@official` appear.

Restore `@stable` only if the component returns to the default nightly image.
**Re-confirmed 2026-09-15 on `1.13.0.dev8` and `1.13.0.dev12`** — one minor
line past the 1.12.0.dev8 measurement above, `mistral` occurs 27 times in
`GET /api/v1/all` and every one of them belongs to some other vendor's
component — Bedrock `model_id` options, the Astra Vectorize provider list and
its help text, and prose inside embedded component source. There is no
MistralAI component and no `mistral` category, so nothing about the absence has
moved and the pre-flight still skips before a key is ever read.

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

**Component-availability pre-flight (#907, #1039):** `GET /api/v1/all` and
check the component registry (second-level component-type keys) for a `mistral`
type. The default nightly image does not install the distribution that ships
the MistralAI component, so it is absent from the sidebar AND the registry, and
the later `waitForSelector('[data-testid="mistralMistralAI"]')` would hard-fail
after 30s. This probe runs **first** and `test.skip`s with an explicit reason — a packaging
decision becomes an honest skip, not a misleading UI timeout, and auto-clears
when the component returns. Since #1930 the reason follows the state the probe
reached: **absent** gives "MistralAI component not exposed by this Langflow
build", while an unreadable registry is **undecided** and says so with its own
error rather than naming a distribution nobody looked at (#1012). Distinct from the cloud-API probe below, which only
validates the key.

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

- `src/bundles/lfx-bundles/src/lfx_bundles/mistral/mistral.py` (MistralAI component) — `api_key`
  (SecretStrInput, required), static `model_name` dropdown; shim in
  `lfx.components.mistral` until the lfx-bundles deprecation window closes.
- `src/frontend/` canvas — sidebar search (`sidebar-search-input`,
  `mistralMistralAI`, `add-component-button-mistralai`), node handles
  (`handle-mistralaimodelcomponent-shownode-*`), component inputs
  (`popover-anchor-input-api_key`, `dropdown_str_model_name`).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O.
- Mistral API (`api.mistral.ai`) — probe and the real inference. A live
  `MISTRAL_API_KEY` is required. **CI note — the lanes do carry it, and that
  changes nothing here:** `MISTRAL_API_KEY` is a repository secret created
  **2026-07-09** (`#600`; the 2026-09-13 date `gh secret list` shows is
  `updated_at`, a rotation, not the creation) and it reaches the step that RUNS
  specs in `daily-stable.yml` and `pr-validation.yml`. The key is therefore
  **not** why CI skips this test — the component-availability pre-flight above
  runs first and unconditionally, so the key probe is not reached while the
  component is absent.
  **`manual.yml` is the exception:** there the secret appears only inside the
  `Collect models` step's own `env:`, which does not cross steps, and the
  job-level `env:` carries no `MISTRAL_*` — so a dispatch runs this spec with
  no key and would skip on `"MISTRAL_API_KEY not set in the environment"`.
  Unreachable today, recorded for the day the component returns. No
  `MISTRAL_TEST_MODEL` variable exists on any lane, so the
  `mistral-small-latest` default applies — unlike Groq, where the default was
  measured absent from this account's catalog and a variable had to be added.
  An earlier revision of this note said the workflows carried no secret yet. It
  was **true when it was written** and false about two hours later the same
  afternoon: it landed at 13:51 UTC (`5a02ed4a`, #500) with issue #600 already
  open about exactly those missing keys, and `2c4a7e51` provisioned all three
  at 15:27 UTC. It then stood for two months because **no guard checks a CI
  claim here** — which is not the same as "no guard reads this section", a
  wider claim that is wrong and has cost this repo a review before (PR #1570).
  `pr-validation.yml`'s *Spec-doc dependency paths* job resolves every
  backticked Langflow source path here on every PR — spelling one with an
  ellipsis in this sentence is what failed that job on this PR, since a
  placeholder resolves against no ref and is a defect rather than a skip. And
  `#1783`'s check reads prose
  only in `## Tags` and the Part II bullet, and only issue references. A CI
  claim in this section is checked by nobody.

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
