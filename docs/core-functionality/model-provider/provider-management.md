# Provider Management — modal, provider count, components, add/remove API key

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev17`)

---

## What this test validates *(required)*

The **Model Providers** management surface (QA-CHECKLIST §7.5), across six
existing specs promoted to `@stable` after hardening (issue #505):

| Spec | Behaviors |
|---|---|
| `modelProviderModal.spec.ts` | Provider list renders; selecting a provider opens its detail; a configured provider shows its model-selection panel |
| `model-provider-modal-actions.spec.ts` | Page opens with description; **available provider count**; an invalid API key is rejected (does not enable the provider) |
| `model-provider-api-key.spec.ts` | OpenAI/Anthropic listed; **adding a real key via the page enables the provider** (delete→re-add cycle with the OpenAI key) |
| `remove-provider-api-key.spec.ts` | A provider credential (global variable) can be removed via UI and via API |
| `modelInputComponent.spec.ts` | The Language Model component's model selector renders, opens, lists models, and shows the selected model |
| `language-model-regression.spec.ts` | LM answers with OpenAI; answers with Google; provider switch (OpenAI → Google) persists on the node; "Manage Model Providers" opens the provider dialog from the node |

> **Hardening note (issue #505):** the six specs pre-dated the model-bundle
> refactor and "passed" without testing — dead assertions
> (`expect(x || true).toBe(true)`), whole bodies inside `if (visible)` guards,
> and silent early-return chains (observed: 2 tests "passing" while logging
> `skipping`; the variables API test "passed" on a 422). Promotion to `@stable`
> requires the force-failure check, so every weak assertion was replaced with a
> real one against live-scouted testids before tagging.

> **Provider strategy (no Anthropic needed):** key-validation on Save performs
> a real 1-token inference (`llm.invoke("test")`, `max_tokens=1` —
> `lfx/base/models/unified_models/credentials.py`), so add-key tests need a
> **funded, real key**. The suite already has two: `OPENAI_API_KEY` (the only
> one present in CI) and `GOOGLE_API_KEY` (local). The add-key test recycles
> the OpenAI credential (delete → re-add, net state identical); multi-provider
> behavior uses Google. **OpenAI is the "configured provider" reference** —
> it is configured in both environments (CI runs `collect-models` with the
> OpenAI secret; the fresh CI container has no Google key until the
> `GOOGLE_API_KEY` secret is added — flagged on the PR).

If these fail, provider configuration — the gateway for every LLM feature — is
broken or its UI has drifted.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@model-provider` (per test,
at least one cross-cutting + `@model-provider`; `@components` on the
node-level specs).

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly, per test file.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` in `.env` (funded) — the add-key cycle, the
  configured-provider assertions, and the LM execution test T1.
- `GOOGLE_API_KEY` in `.env` (funded) — the LM Google/switch tests
  (`test.skip` without it). **CI note:** `daily-stable` currently injects only
  `OPENAI_API_KEY`; the Google-dependent tests skip there until the
  `GOOGLE_API_KEY` secret is added (workflow env updated in this PR; secret is
  a maintainer action — flagged).
- The settings-page specs are parallel-safe; the LM execution spec keeps the
  template machinery serial (`--workers=1`).

---

## Step by step *(required)*

Live-scouted testids (dev33; re-scouted on 1.12.0.dev9): `provider-list`,
`provider-item-<Name>` — 8 providers on 1.11 (Google Generative AI, OpenAI,
Anthropic, IBM WatsonX, Ollama, OpenAI Compatible, OpenRouter, vLLM), **9 on
1.12** (`Azure AI Foundry` added). `GET /api/v1/models/providers` returns a
wider set (11 on dev9 — it also lists Groq and Azure OpenAI, which the page
does not render); the page, not the API, is the contract here.
`provider-search-input`,
`provider-variable-input-<VAR>` (e.g. `OPENAI_API_KEY`, `OPENROUTER_API_KEY`),
`model-provider-selection`, `model-search-input`, `llm-toggle-<model>`,
`embeddings-toggle-<model>`; Save/Cancel/Confirm buttons (by role+name);
configured providers show a **"N models"** suffix in their list item and a
**Replace** button in their detail. LM node: `add-component-button-language-model`,
`model_model` / `value-dropdown-model_model`, dropdown options `<model>-option`.

**`modelProviderModal.spec.ts`**
1. *Provider list renders* — Settings → Model Providers; assert `provider-list`
   visible and the 8 known `provider-item-*` present. **This spec owns the
   by-name contract**: a known provider silently dropping from the page fails
   here. Providers added after 1.11 (`Azure AI Foundry`) are deliberately not
   pinned — a new catalog entry is not a regression.
2. *Provider detail opens* — click `provider-item-OpenRouter` (unconfigured):
   assert its `provider-variable-input-OPENROUTER_API_KEY` becomes visible.
3. *Configured provider shows model selection* — click `provider-item-OpenAI`
   (configured in both environments; skip without `OPENAI_API_KEY`): assert
   `model-provider-selection` and at least one `llm-toggle-*` visible.

**`model-provider-modal-actions.spec.ts`**
1. *Page opens with description and provider count* — assert the description
   text and `provider-item-*` count **≥ `MIN_PROVIDER_COUNT` (8)** (§7.5
   "Available provider count").

   > **Count contract: floor, not exact** (decided on issue #993). The
   > assertion is `toBeGreaterThanOrEqual`, never `toHaveCount` — the risk this
   > test exists to catch is *the provider list failing to render*, not Langflow
   > shipping a new provider. An exact count couples the suite to the live
   > catalog and breaks on unrelated additions: it was authored as
   > `toHaveCount(8)`, went red when 1.11 shipped a 9th provider (#704 → #721,
   > which closed with `@stable` off and the assertion untouched), and was still
   > red on 1.12.0.dev9 (9 items: the 1.11 eight plus `Azure AI Foundry`).
   > `MIN_PROVIDER_COUNT` stays at the 1.11 baseline of **8** — a page rendering
   > fewer providers than 1.11 did is a real shrink. By-name coverage is not
   > lost: `modelProviderModal.spec.ts` pins each known provider individually,
   > so a provider disappearing still fails there.
2. *Invalid key is rejected* — OpenRouter detail → fill
   `provider-variable-input-OPENROUTER_API_KEY` with a fake key → Save →
   assert the item does **not** gain the "models" suffix AND the API confirms
   no `OPENROUTER_API_KEY` variable was created (backend validates the key —
   scouted live: fake key leaves no variable and no badge).
3. *Detail panel toggles per provider* — clicking another provider switches
   the visible detail (the previously open input disappears, the new one
   renders).

**`model-provider-api-key.spec.ts`**
1. *OpenAI listed* — `provider-item-OpenAI` visible (exact testid, no
   text-match fallback).
2. *Anthropic listed* — `provider-item-Anthropic` visible.
3. *Configured provider exposes the key edit surface* (skip with a reason if
   the instance has no stored `OPENAI_API_KEY`) — the OpenAI item shows the
   `N models` badge and its detail shows **Replace** (masked key, no raw
   input); Replace opens `provider-variable-input-OPENAI_API_KEY`; Cancel
   restores the masked state. **Zero writes** — see the cache-poisoning note
   below for why a real add cycle is not exercised.

**`remove-provider-api-key.spec.ts`**
1. *UI removal* — create a uniquely-named credential variable via
   `POST /api/v1/variables/` (fix: the endpoint now **requires**
   `default_fields: []` — the old spec 422'd and "passed"), then delete it
   through the Settings → Global Variables UI and assert the row is gone. No
   silent early-returns: every intermediate element is a hard assertion.
   **There is no confirmation dialog for this action** — ticking the row and
   hitting the header trash deletes immediately (`GET` by id → `404`, row out of
   the DOM). Confirming that is why the spec asserts `delete-row-button` is
   *enabled* before clicking it (the only client-side observable that the
   release-1.12 RBAC gate has opened) and scopes its optional-confirmation branch
   to a real `[role="dialog"]`: matched page-wide, `/delete|confirm|yes/i`
   resolves to the header button itself, disabled once the row is gone, and
   clicking it burned the full 20 s timeout in ~75 % of runs (#1235).
2. *API removal* — POST (with `default_fields`), DELETE → 200/204, GET-by-id
   → 404/422, list no longer contains it (hard-fail on non-2xx create).

**`modelInputComponent.spec.ts`** — migrated from the legacy `modelsOpenAI`
sidebar entry to the canonical **Language Model** component:
1. *Model selector renders* — blank flow → add
   `add-component-button-language-model` → assert node + `model_model`
   visible.
2. *Dropdown opens with model options* — click `model_model` → assert the first
   `*-option` is visible **and** that more than one renders (the unified
   catalog behavior; a floor, never an exact count).
3. *Dropdown exposes "Manage Model Providers"* — click `model_model` → assert
   `manage-model-providers` is visible, i.e. the catalog dropdown still offers
   the route into provider configuration.
4. *Trigger shows the selected model* — assert `model_model` text is a
   non-empty model name and is NOT a "Select a model" placeholder (the catalog
   pre-selects a default). **Not key-independent**, as this step used to claim:
   with no provider credential configured at all the node still mounts but its
   Language Model field renders a **"Setup Provider"** CTA behind
   `parameter-permission-gate` and `model_model` is absent, so all four tests
   fail on an observable unrelated to what they assert (measured on
   1.12.0.dev17, #1265). It is the credential that matters, not a funded key — a
   drained `openai` alongside an active anthropic/google passes.

> **Flake verdict & attributed sidebar barrier (issue #1265).** Test 1 flaked on
> the 2026-07-15 and 2026-08-04 dailies with the same signature
> (`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.`) and was
> quarantined at triage. Root cause on both days is the **run environment, not
> this spec and not the model selector** — the wait that timed out is the
> component sidebar's `sidebar-search-input`, reached by all four tests through
> the shared `addLanguageModelNode` entry point, before any model selector is
> touched. Evidence: on 2026-08-04 (run 30901311395, shard 2) the failing
> attempt ran 10:45:07→10:49:55 across two measured backend outages (76 s and
> 92 s of a 26.8 % down-share), gunicorn logged `WORKER TIMEOUT (pid:37)` +
> SIGKILL at 10:46:30, and the attempt took **287 s** against **5.8–10.4 s** for
> its own file-siblings once the backend recovered; the whole shard reported the
> same shape (`apiRequestContext.post/get: Timeout` on localhost). On 2026-07-15
> the attempt took 45 s and the retry 7 s on an unsharded run with 15 hard
> failures / 29 flakes across every area. So `@stable` was restored **with no
> timeout raised and no assertion weakened** — the 30 s budget is unchanged, and
> the local burst on 1.12.0.dev17 measures the cold sidebar open well inside it.
> What did change is **attribution**: the wait now goes through
> `waitForAttributedSelector(…, { surface: "component-sidebar" })`
> (`tests/helpers/other/page-entry-barrier.ts`, the #1262 mechanism), so a
> timeout probes `/api/v1/version` and says whether Langflow was reachable —
> carrying `[backend-unreachable]` when it was not. `locator.waitFor: Timeout`
> can never be added to `scripts/lib/infra-signatures.ts` (a real UI regression
> emits it too), which is why the bare message is unclassifiable by
> construction; the attributed one embeds the probe's own transport error, so a
> wedge already matches the existing `api-request-timeout` signature while a
> healthy probe stays unclassified — both pinned in
> `tests/helpers/other/page-entry-barrier.test.ts` against the real classifier.
> The residual limitation is stated in that helper's header: the probe runs
> after the budget is spent, so a wedge shorter than the wait reads healthy.

> **Verdict on the no-node hard failure (issue #1304).** Test 4 hard-failed on the
> 2026-08-05 daily (run 30997773754, all 3 attempts) waiting for
> `[data-testid^="rf__node-"]`, i.e. `addLanguageModelNode` returned and the canvas
> had no node. Root cause is **the shared sidebar add dropping its click**, not
> this file and not the model selector: Langflow accepts the click on
> `add-component-button-language-model`, never registers the add, and no flow write
> follows. An instrumented scout on nightly `1.12.0.dev17` measured **4 of 20**
> adds producing no node within 4 s, and in **all 4** an identical second
> fill+click produced it — with the `+` button still visible, the search input
> still holding the term, and zero `POST/PATCH /api/v1/flows` after the first click
> in 3 of the 4. That is the swallowed-click class (#420/#966) one layer later, on
> the surface #537 already recorded as re-rendering while its catalog streams in.
> Pre-fix solo baseline: **2 of 11** runs at `--workers=1 --retries=0`, and one of
> them failed on a *different* test of this file (test 3) — whichever test is
> running when the drop happens is the one that reports it.
> **Why it hard-failed that day rather than flaking:** the window WAS degraded,
> which the triage could not see because the liveness recorder's probe-measured
> windows (10:36:37→10:38:25, 10:42:39→10:44:11) by construction miss degradation
> that does not fail the probe. Inside 100 s on the same shard the run also lost
> `flow-functionality/stop-building.spec.ts:24` (on `div-generic-node`) and
> `ui-ux/langflowShortcuts.spec.ts:47` ("the Chat Output component should be on the
> canvas") — the **same mechanism under two more messages** — while 152–157 s
> page-entry barrier failures straddled it. This file's own siblings passing on the
> **same worker** 7 s and 17 s earlier rule out instance-wide breakage.
> **The fix is in `tests/helpers/flows/add-component-from-sidebar.ts`, not here:**
> it verifies the node count moved, re-issues the fill+click **once** when it did
> not, and otherwise fails naming the swallowed click and the observed sidebar
> state (unit-pinned in `add-component-from-sidebar.test.ts`, including that the
> message is deliberately **not** infra-classifiable, per the #1262 rule). No
> assertion here was weakened and no timeout raised — a longer wait provably cannot
> fix it, since this test already waited 15 s and lost 3/3. Provider-credential
> churn, the standing hypothesis, is **refuted**: the drop reproduces solo with no
> neighbour, and the same class hit `edit-name-description-node.spec.ts:42` on that
> daily with no provider-mutating spec running. #1265 stays a separate issue — its
> observable is the sidebar never opening, upstream of any add.

**`language-model-regression.spec.ts`**
1. *OpenAI answers* (skip without `OPENAI_API_KEY`) — Basic Prompting +
   `initialGPTsetup`, run, playground "What is 2+2?" → reply matches `/4/`.
2. *Google answers* (skip without `GOOGLE_API_KEY`) — same flow via
   `setupGoogle`, non-empty reply. (Replaces the former Anthropic test — same
   contract, a second provider the suite already holds a funded key for.)
3. *Provider switch persists* (skip without both keys) — after switching
   OpenAI → Google, the node's `model_model` shows a `gemini` model.
4. *Manage Model Providers opens from the node* — click the LM node's
   `model_model` dropdown → "Manage Model Providers" → assert
   `provider-item-OpenAI` visible in the dialog (hard assertions, no
   if-wrapping).

---

## Validation criterion *(required)*

Every test asserts a **specific, live-scouted observable** (testid visibility,
count floor, API state) with no conditional bypass: each one fails when its
behavior breaks (verified by force-failure during promotion). Counts are
asserted as a **floor against the 1.11 baseline**, never as an exact match —
see the #993 note under `model-provider-modal-actions.spec.ts` above. The §7.5
behaviors — modal, provider count, component configuration, add key (real
accepted / fake rejected), remove key — are each pinned by at least one test.

## Guarding against false positives *(how)*

- **No dead assertions** — every `expect(x || true)`-style always-pass and
  every `if (visible) { expect }` wrapper was removed; missing UI now fails.
- **No silent early-returns** — unmet preconditions are hard failures (or an
  explicit `test.skip` with a reason, for missing provider keys only).
- **Fake-key negative control** — the rejected-key test proves Save actually
  validates, so the add-key test's "models suffix" cannot appear spuriously.
- **API cross-checks** — variable creation/removal asserted through
  `/api/v1/variables/` in addition to the UI.
- **State restore** — the add-key cycle ends in the same configured state it
  started from; the fake-key test verifies nothing was created.

---

## What this test does not cover *(optional)*

- Anthropic execution (no funded key in the environment; the multi-provider
  contract is covered via Google — re-scope if an Anthropic key lands).
- Groq/Mistral provider specs (issues #499/#500 — those providers are not in
  the current provider list; flagged there).
- Per-model enable/disable toggles (covered by
  `model-provider-model-toggle.spec.ts`).
- Provider key expiry/invalidation after configuration.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` — Model Providers page
  (`provider-list`, `provider-item-*`, `provider-variable-input-*`,
  `model-provider-selection`).
- `src/backend/base/langflow/api/v1/variable.py` — variables CRUD (the
  `default_fields` requirement; key storage behind providers).
- `src/lfx/src/lfx/base/models/unified_models/credentials.py` — key validation on
  Save (real 1-token inference per provider).
- `src/frontend/src/components/` model input — `model_model` dropdown and
  `<model>-option` entries.
- OpenAI + Google live APIs for the execution and add-key tests (real calls).

---

## When to review this test *(optional)*

- If the provider list gains/loses providers (count assertion floor of 8).
- If `provider-variable-input-<VAR>` or `llm-toggle-<model>` testids change.
- If Save stops validating keys server-side (the negative control would then
  need a different observable).
- When the `GOOGLE_API_KEY` secret lands in CI (Google tests stop skipping).

---

## Notes *(optional)*

- **Fake keys never configure a provider** — Save validates against the
  provider's API with a real 1-token inference; a rejected key creates no
  variable and no badge (scouted live). A positive add test would therefore
  need a real, **funded** key — a valid key with no credits fails validation
  the same way a fake one does.
- **Credential delete → re-add poisons a server-side cache (suspected
  Langflow bug, flagged on the PR):** a delete→re-add cycle with the real
  OpenAI key passed its own assertions (badge back, variable stored, Save
  validation succeeded), but every subsequent flow build received the
  **wrong provider's key** — the OpenAI node was sent the Google key and
  401'd (`Incorrect API key provided: AIza…`) until the backend container
  restarted. This reproduced 4/4 and disappeared immediately after a restart.
  That is why the add surface is validated by the fake-key negative control +
  the Replace/Cancel edit surface, with zero writes to real credentials.
- **Configured providers expose only Replace** in their detail — key removal
  happens through the Global Variables surface (UI or API), which is what the
  remove spec exercises.
- **The provider detail is an accordion** — clicking an item toggles its
  panel; assertions must target the specific provider's elements, not
  "any input".
- **The Google key is never touched** — it is the standing local provider the
  agent specs depend on; the add-key cycle recycles the OpenAI credential and
  ends in the identical configured state.
