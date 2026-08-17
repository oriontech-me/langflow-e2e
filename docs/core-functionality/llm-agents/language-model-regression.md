# Language Model Component Regression

**Last validated:** Langflow 1.12.x (dev30)

---

## What this test validates *(required)*

The **Language Model** component on the Basic Prompting template
(QA-CHECKLIST §7.5 "Language Model component — configuration"): it executes
with a configured provider, a provider switch persists, and the provider
management dialog opens from the node.

| Test | Contract |
|---|---|
| `language model must respond with OpenAI provider` | Component configured with OpenAI builds (`built successfully`) and the Playground answers `2+2` with `4` |
| `language model must respond with Google provider` | Same journey with Google: build completes and the Playground returns a non-empty reply |
| `language model provider switch from OpenAI to Google must persist` | After OpenAI → Google setup, the node's `model_model` trigger shows a Gemini model |
| `model provider dialog opens from the Language Model node` | Selecting the **Language Model component node** (the `genericNode` carrying `title-Language Model`, never the README sticky note) opens `manage-model-providers` from its model dropdown, and the dialog lists `provider-item-OpenAI` |

---

## Tags *(required)*

`@stable` `@release` `@components` `@model-provider` (+`@workspace` on the
dialog test).

`@stable` was removed from the Google test by the daily-failure triage for
#596 (flaky 07-07/07-08 → hard fail 07-09) and **restored by the #596 fix**
(explicit model + pre-run widget gate — see Step by step and Notes). It was
removed again in the 2026-07-14 quarantine PR #749 (recurrent flake) and
**restored by the #750 fix** (deterministic build-completion observable —
see Notes).

`@stable` was removed from the **OpenAI** test by the quota quarantine #772 /
PR #775 — the key had no quota, not the test — and **restored in #992** once
the quota was confirmed back (live HTTP 200 completion on `gpt-4o-mini`) and
the test ran clean at `--retries=0`.

`@stable` was removed from the **dialog** test by the 2026-08-17 daily's
auto-removal (run 32011412906, commit `14a77eb`) and is **restored by the
#1469 fix**. The removal was collateral of a backend the shard could not
reach, but `page.waitForSelector: Timeout` is deliberately not an exempting
signature — which is the whole reason the fix is an *attribution* one (see
Notes, #1469).

`@stable` was removed from the **Google** test again by the 2026-08-04 daily's
auto-removal (run 30901311395) and is **restored by the #1262 fix**. The
removal was collateral: the attempt that set the recorded signature ran while
the shard's backend was restarting after a gunicorn `WORKER TIMEOUT`, so the
recorded error is a page-entry timeout, not this test's own observable — see
Notes (#1262).

---

## Preconditions *(optional)*

- `OPENAI_API_KEY` / `GOOGLE_API_KEY` in the env, **and** the corresponding
  provider recorded `active` in `providers.json`. Each test gates on provider
  *health* via `providerSkipGate` (`helpers/provider-setup/provider-health.ts`),
  not on the env var alone: a key that exists but is drained used to pass the old
  gate and hang the live call past gunicorn's 300s timeout, killing the shard's
  Langflow worker (#1029). The skip reason quotes the error `collect-models`
  recorded. Set `IGNORE_PROVIDER_HEALTH=1` to override a stale local
  `providers.json`.
- `models.json` fresh (`collect-models.spec.ts`) for the setup helpers.
- `--workers=1` (template loads create named flows; id-scoped afterEach
  cleanup is in place).

---

## Step by step *(required)*

Common: open the Basic Prompting template (flow id captured from the page's
own `POST /api/v1/flows/` response; deleted in `afterEach`). The page-entry
barrier inside `awaitBootstrapTest` now fails **attributed** (#1262): on
timeout it probes `GET /api/v1/version` and says whether the backend answered,
so an unreachable backend can no longer be reported as "`mainpage_title` never
rendered".

`openBasicPrompting()` no longer returns on `page.waitForURL` alone (#1469):
after the flow URL is reached it holds a **canvas-mount barrier** — the canvas
controls bar, then at least one rendered `.react-flow__node` — through
`waitForAttributedSelector` with the `flow-canvas` surface. A canvas that never
mounts therefore fails at a named seam that says whether Langflow answered,
instead of inside whichever assertion each test happens to run first.

**OpenAI test:** `initialGPTsetup` — which pins a deterministic GPT model
from `models.json` via `resolveGptModel()` (#606; UI preference-ranking is
the fallback when `models.json` is absent or the pinned model left the
lineup) → `waitForFlowSaveSettled` (autosave debounce — building earlier
runs the template's DEFAULT model) → **pre-run widget gate (#596/#491
class, #606):** if the node's `model_model` widget does not show `/gpt/i`,
the selection was silently reverted by a `custom_component/update` race —
re-apply (bounded, 3 attempts), then hard-assert → run the Chat Output
node → wait `built successfully` (30s) → Playground → send `What is 2+2?`
→ last AI bubble contains `4`.

**Google test:** `setupGoogle(page, resolveGeminiModel())` — a deterministic
Gemini **flash** model pinned from `models.json` (never "first gemini in the
dropdown") → save-settle guard → **pre-run widget gate (#596/#491 class):**
if the node's `model_model` widget does not show `/gemini/i`, the selection
was silently reverted to the workspace-default model by a
`custom_component/update` race — re-apply the selection (bounded, 3
attempts), then hard-assert the widget shows a Gemini model → run → wait for
build completion on the Chat Output node's persistent `node_duration_chat
output` badge (60s, #750 — replaces the transient `built successfully` toast)
→ Playground → send `Say hello.` → last AI bubble non-empty.

**Switch test:** `initialGPTsetup` + `setupGoogle` → save settle → the
page-level `model_model` trigger shows `/gemini/i`.

**Dialog test:** select the Language Model **component** node —
`.react-flow__node:has([data-testid="title-Language Model"])`, the only node
carrying that title testid — → `hideInspectorPanel` → open `model_model` →
`manage-model-providers` → `provider-item-OpenAI` visible → Escape. The node
is NOT resolved by `.filter({ hasText: "Language Model" })`: the template's
README sticky note contains "Large **Language Model** (LLM)", so that filter
matches two nodes and `.first()` picks the note (#1469).

---

## Validation criterion *(required)*

- Build completion is observed via the Chat Output node's persistent
  `node_duration_` badge within 60s (OpenAI test still uses the `built
  successfully` toast — #750 hardened only the flaking Google test); the
  Playground reply is the end-to-end proof the selected provider executed.
- **Dialog test:** the node the test selects is the Language Model
  **component** — proven by the node it clicks carrying
  `data-testid="title-Language Model"`, which the README sticky note does not —
  and the dialog reached from its `model_model` trigger lists
  `provider-item-OpenAI`.
- **Fix #1469 exit criterion:** (a) `openBasicPrompting()` fails at a named,
  attributed canvas seam when the canvas does not mount — the message says
  whether Langflow answered `GET /api/v1/version`, so this collateral is
  classifiable instead of reading as a bare `page.waitForSelector: Timeout`;
  (b) the dialog test resolves the component node unambiguously (one match,
  never the sticky note); (c) the test proves N clean `--retries=0` runs on the
  current nightly before `@stable` is restored on the `test()` call.
- **Fix #1262 exit criterion:** the recorded page-entry signature is
  attributed (backend-reachability probed at the barrier), the Google test's
  own recurrent observable is addressed at its cause (the provider-panel
  re-fill race below), and the test proves clean `--retries=0` runs on the
  current nightly before `@stable` is restored.
- **Fix #596 exit criterion:** the Google test's root cause is identified
  with evidence (test defect vs product vs environment — triage verdicts),
  the fix does NOT weaken asserts (no timeout inflation to mask latency),
  and the test proves N clean `--retries=0` runs on the fresh nightly before
  `@stable` is restored on the `test()` call.

---

## External dependencies *(required)*

- Basic Prompting starter template (Language Model node — `genericNode`
  carrying `title-Language Model` — `model_model` trigger,
  `button_run_chat output`, `canvas_controls_dropdown`). The template also
  ships two sticky notes; the README one contains the words "Language Model"
  and must not be mistaken for the component (#1469).
- `setup-google.ts` / `initialGPTsetup` helpers — **model choice happens
  here**: `setupGoogle(page)` with no argument selects the FIRST Gemini
  option in the dropdown, so the Google catalog's ordering directly affects
  which model builds (see #596 investigation).
- OpenAI / Google APIs — real inference; funded keys.
- `built successfully` toast markup.

---

## Notes *(optional)*

- File predates the spec-doc convention; this doc was authored during #596
  (daily-failure fix) to satisfy the PR checklist and record the fix's exit
  criterion.
- History (from `reports/daily-history.jsonl`): the Google test was flaky
  (attempts=2) on 2026-07-07 and 07-08 dailies and hard-failed on 07-09;
  the 07-07/07-08 dailies also show a broad flaky background (10-13 tests),
  so environment saturation is part of the verdict space.
- **#596 root cause (2026-07-09):** model-selection drop race, the #491
  class. The node's default resolves through a missing internal
  `__default_language_model__` variable (backend `ValueError` on every canvas
  load) and falls back to the first configured provider's model; a
  `custom_component/update` racing the selection reverts the node to that
  fallback. Locally the fallback (claude-sonnet-5) fails with Anthropic
  `400 — 'temperature' is deprecated for this model`; on CI the fallback is
  an inaccessible OpenAI model. Both product observations are documented on
  the fix PR; per the user's decision the resolution is test-side only
  (explicit model + re-apply gate), no upstream ask — the race is not
  reproducible at manual UI speed.
- **#750 root cause (2026-07-14):** recurrent flake (flaky 07-07/07-08,
  hard-fail 07-09, flaky again 07-14) on `waitForSelector("text=built
  successfully", 30s)` at line 173. Evidence: the 07-14 daily JSON artifact
  pins the timeout to that exact selector, and the retry passed (the build
  DOES complete — not a product hang). Frontend source
  (`FlowBuildingComponent`) shows the success toast auto-dismisses ~2s after
  `buildInfo.success`, so the 30s wait only starts catching a 2s window once
  the whole Gemini build finishes; under CI saturation the build tips past
  30s and the toast is missed. This is NOT the #596 model-drop bug — the
  pre-run widget gate already guarantees the correct Gemini model built.
  Verdict: **test defect** (fragile transient observable + tight budget), not
  a Langflow regression. **Fix:** wait on the Chat Output node's persistent
  `node_duration_chat output` badge (deterministic build-completion signal,
  the repo's established convention — used by agent/knowledge/flow specs) with
  a 60s budget matching this file's playground wait. Not timeout inflation to
  mask latency: the observable is a real completion signal, not a bigger
  gamble on the toast window. Locally 5/5 clean `--retries=0` on
  1.11.0.dev38.
- **Latent sibling — resolved (#606):** the OpenAI tests went through
  `initialGPTsetup` → `setupOpenAI(page)` with no explicit model.
  `initialGPTsetup` now defaults the model to `resolveGptModel()`
  (deterministic pick from `models.json`, extracted from
  `openai-provider.spec.ts` into `tests/helpers/provider-setup/`), falling
  back to `setupOpenAI`'s UI preference-ranking when `models.json` is
  absent or the pinned model is not in the dropdown
  (`fallbackToRanking: true` — the fallback happens in-dropdown, never via
  close-and-retry, which races the providers refetch and clicks a detached
  option; the 13 consumer specs never break on stale collected data).
  Premise correction vs the issue text: the no-model branch of
  `setupOpenAI` was already preference-ranked, not blind "first
  available" — the nondeterminism was the last-resort fallback and the
  missing race gate, both addressed.
- **#1262 root cause (2026-08-04):** the issue was filed as an entry-point
  failure — `mainpage_title` never rendering inside `openBasicPrompting()` —
  and that framing does not survive the evidence. Three separate findings:
  - **The recorded signature was the LAST attempt's.** Attempt 1 failed on
    `node_duration_chat output` (60s, this file's own build observable), retry
    #1 on `new-project-btn`, retry #2 on `mainpage_title`. The shard's Langflow
    logged `WORKER TIMEOUT (pid:37)` at 10:46:42 UTC and SIGKILLed the worker;
    the restart completed ~10:47:00, inside the triage's recorded outage window
    (10:47:01→10:48:33). Both retries ran against a restarting backend —
    **environment**, verdict 4, no test change earns anything there.
  - **"Recurrent 3×, same signature" was an artifact** of the shared Playwright
    prefix `TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.`. On
    2026-07-09, 07-14 and (the OpenAI sibling) 07-15 the locator was
    `text=built successfully` — the #750 observable, a different failure. The
    entry point was never the recurring cause.
  - **The file's real recurrent cause is the provider panel's re-fill race.**
    `setupGoogle` decided "already configured" from a 1s `isVisible` probe on
    the Disconnect button, which is painted only after the panel's own backend
    fetch resolves; a slow fetch read as "not configured" and the helper filled
    the key field over a provider that already held a credential. Langflow then
    called Google with an unusable key —
    `Error calling model 'gemini-flash-latest' (INVALID_ARGUMENT): 400 … 'API
    key not valid. Please pass a valid API key.' … API_KEY_INVALID` — so the
    build never completed and the test timed out on its build observable, which
    is exactly the 07-09/07-14/07-15 and attempt-1 shape. Reproduced on
    1.12.0.dev15: **1 failure in 7 runs**, the 6 clean runs all observing the
    provider already configured with the key masked (`AIza•••…`).
    **Verdict: test defect.** Fix: `providerAlreadyConfigured()`
    (`helpers/provider-setup/provider-config-state.ts`, unit-tested) polls both
    signals to a 5s deadline and treats a **non-empty (masked) key field** as
    configured on its own — a masked value can never be one this helper typed,
    so it cannot skip a setup that was genuinely needed.
- **#1469 root cause (2026-08-17):** the dialog test hard-failed on all three
  attempts of run 32011412906 (shard 2) before reaching anything it is about,
  each attempt dying on a different canvas observable. Findings:
  - **The gunicorn wedge is ruled OUT for the attempt window.** The shard's
    Langflow logged exactly two `WORKER TIMEOUT` — `(pid:31)` at 08:46:09 and
    `(pid:341)` at 08:51:27, both SIGKILLed — and **both precede attempt 0**
    (08:55:08). Nothing in 08:55:08→09:01:45.
  - **The backend was nevertheless unreachable, by event-loop blocking rather
    than by a worker restart.** Shard 2's `backend-liveness.jsonl` fails 5/43
    (12 %), 16/46 (35 %) and 33/57 (58 %) of probes across the three attempts,
    in contiguous runs of 45 s, 66 s and 60 s — long enough to burn a 30 s
    budget, short enough never to reach gunicorn's 300 s timeout. Concurrent on
    the same single-worker backend: `memory-history-regression`'s "session
    isolation" test, itself failing, running 08:55:21→09:00:26 and again
    09:00:27→09:01:21. Verdict for all three attempts: **environment**
    (#1077's lever), not a product regression.
  - **Attempt 0 needs no product regression either.** Its shape — canvas
    controls rendered, zero nodes — is reproducible on demand on 1.12.0.dev30
    by failing the canvas's backend GETs (`page.route` abort: controls visible,
    `.react-flow__node` count 0). On a quiet instance the same sequence renders
    the controls in 64–824 ms and the Language Model node in 353–826 ms, 5 runs
    of 5, so the 15 s budget was never tight. The template's node also still
    carries `display_name: "Language Model"` on dev30 (`GET
    /api/v1/flows/basic_examples/`), so the absence is not a rename.
  - **Two real test defects surfaced by the investigation, and they are what
    the fix addresses.** (1) `.react-flow__node` filtered on `hasText:
    "Language Model"` matches **two** nodes, because the template's README
    sticky note reads "Large Language Model (LLM)"; the note precedes the
    component in DOM order, so `.first()` selected the note — the test named
    after selecting the node never selected it (it still passed, because the
    following `model_model` locator is page-level). (2) `openBasicPrompting()`
    returned on `waitForURL` alone, so a canvas that never mounts failed at
    whichever observable each test happens to wait on first, with no
    attribution — which is how a `@release` test lost `@stable` to a backend
    outage. Both fixed here; the second reuses `waitForAttributedSelector`
    (#1265) rather than a new mechanism.
- **Page-entry attribution (#1262, suite-wide):** the shared barrier now lives
  in `helpers/other/page-entry-barrier.ts` and is used by `awaitBootstrapTest`,
  `MainPage.waitForLoad`, `loadTemplateByName` and
  `addFlowToTestOnEmptyLangflow`. On timeout it probes `/api/v1/version` and
  prefixes the failure with `[backend-unreachable]` when the backend did not
  answer (or answered non-2xx), keeps the failure attributed to the UI when it
  did answer, and reports UNKNOWN when the probe itself could not run (#1012 —
  an unevaluated probe is not a clean one). Success-path behaviour is unchanged;
  only the failure message differs.
