# Language Model Component Regression

**Last validated:** Langflow 1.12.x

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
| `model provider dialog opens from the Language Model node` | The node's model dropdown opens `manage-model-providers` and lists `provider-item-OpenAI` |

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
own `POST /api/v1/flows/` response; deleted in `afterEach`).

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

**Dialog test:** select the Language Model node → `hideInspectorPanel` →
open `model_model` → `manage-model-providers` → `provider-item-OpenAI`
visible → Escape.

---

## Validation criterion *(required)*

- Build completion is observed via the Chat Output node's persistent
  `node_duration_` badge within 60s (OpenAI test still uses the `built
  successfully` toast — #750 hardened only the flaking Google test); the
  Playground reply is the end-to-end proof the selected provider executed.
- **Fix #596 exit criterion:** the Google test's root cause is identified
  with evidence (test defect vs product vs environment — triage verdicts),
  the fix does NOT weaken asserts (no timeout inflation to mask latency),
  and the test proves N clean `--retries=0` runs on the fresh nightly before
  `@stable` is restored on the `test()` call.

---

## External dependencies *(required)*

- Basic Prompting starter template (Language Model node, `model_model`
  trigger, `button_run_chat output`).
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
