# Model Provider Model Toggle

**Last validated:** Langflow 1.12.x (measured on `1.12.0.dev30`; the provider-list wait re-measured on `1.12.0.dev44`, #1648)

---

## What this test validates *(required)*

Validates the per-model **enable/disable toggles** in **Settings → Model Providers** (the `ModelSelection` UI, shared by the settings page and the provider modal through `ModelProvidersContent`). Two behaviors are covered:

1. **Immediate change + persistence** — toggling a model updates the switch optimistically (immediately) and the change is persisted by the debounced `POST /api/v1/models/enabled_models` write (`useUpdateEnabledModels`, debounced ~1s by `useModelToggleQueue`). Leaving and reopening Model Providers reflects the persisted state (read back from `useGetEnabledModels`).
2. **Propagation to component dropdowns** — disabling a model in Settings removes it from the model dropdown of an intelligent component (the Agent's `model_model` picker) on the canvas; re-enabling brings it back. This is the cross-cutting effect driven by `useRefreshModelInputs`.

Both are pure UI/state assertions — no LLM call is made. No prior spec covered these toggles: `model-provider-modal-actions.spec.ts` only covers entering/removing API keys, and the only existing toggle tests are upstream Langflow unit tests, not this suite.

---

## Tags *(required)*

`@stable` `@regression` `@components` `@agents` `@model-provider`

- Test 1 (settings-only): `@stable` `@regression` `@components` `@model-provider`
- Test 2 (canvas propagation): adds `@agents`

---

## Step-by-step *(required)*

Both tests resolve a single provider — `MODEL_TEST_PROVIDER` when its env keys are set, otherwise the first provider in `providerConfigMap` with env keys configured. The file skips with an accurate reason when no provider has its env keys configured. The provider's display name (`provider-item-OpenAI`, etc.) comes from `provider-config.ts`.

### Test 1 — toggle changes immediately and persists across reopen

1. `SimpleAgentTemplatePage.load({ provider })` — configures the provider's API key globally and enables all its models (the known baseline). `MODEL_NOT_AVAILABLE` is caught and turned into a skip.
2. Navigate to **Settings → Model Providers**, expand the provider through `waitForProviderRow()` (see *Waiting for the provider list* below — never a bare `provider-item-...` wait), and wait for `model-provider-selection` and `llm-models-section`.
3. Read the first visible `llm-toggle-<model>` to derive a model name, filter the list to it via `model-search-input`, and assert it is enabled (`aria-checked="true"`).
4. Disable it: click the toggle, assert `aria-checked="false"` immediately (optimistic), and wait for the `POST .../enabled_models` response (debounced persistence flush).
5. Reload the app, reopen Model Providers, re-expand the provider, search for the same model and assert its toggle is still `aria-checked="false"` (persisted).
6. Restore the baseline: re-enable the model and assert `aria-checked="true"`.

### Test 2 — disabling a model removes it from a component dropdown

1. `SimpleAgentTemplatePage.load({ provider })` — same baseline (all models enabled, a model selected on the Agent). Capture the flow URL.
2. Open the Agent's `model_model` picker and enumerate every option through
   `enumerateModelOptions()` (`tests/helpers/provider-setup/model-option.ts`),
   which reads each option's **identity** — `data-value` (`${provider}::${model}`)
   with `data-testid` (`${provider}-${model}-option`) as the fallback. A picker
   that offers **zero options of the test's own provider** fails here — scoped to
   that provider on purpose, because an all-provider count passes on Anthropic's and
   Google's options while the one under test is absent, and the run then dies further
   down on an unattributed toggle timeout (three drained-key incidents are on record:
   #772/#1029/#1169). It proves nothing about removal and may never become a skip
   (#1461). **The dropdown mixes models from every configured provider** (#597 — with
   Google configured by sibling specs it listed `gemini-3.5-flash` first while the
   test's provider was OpenAI), so the options alone cannot pick the target.
3. In **Settings → Model Providers**, open the test's provider through
   `waitForProviderRow()` and read its
   `llm-toggle-<model>` ids via `enumerateEnabledModels()` — every toggle the panel
   renders, in the **bare** ids the picker's testid does not use. (The helper's name
   is narrower than its behavior: it returns all of them regardless of
   `aria-checked`, deprecated rows included, so a count taken from it is never a
   count of *enabled* models.) Pick the target as the first option that **belongs to
   this provider** (`option.provider`, not the model id alone — see the note below),
   is **in that toggle set**, is **not deprecated** (its row lives inside the
   collapsed `*-deprecated-disclosure`, so its toggle would never become visible) and
   is **not** the currently selected model (avoids entangling with selection-reset
   logic). The target's identity is then asserted to exist at all: one carrying
   neither `data-value` nor `data-testid` matches no option, which would make every
   removal verdict below vacuous. A provider with **no comparable model** is a
   **failure**, not a skip — not because the sources must agree (the picker is a
   *filtered* subset: the Agent declares a `tool_calling` filter and only enabled
   models are offered) but because zero comparable models means the behavior was
   never exercised, and that must not read as coverage. The only skip left is the
   degenerate case where the provider offers exactly one non-deprecated model and
   it is the selected one, and its reason carries the counts. Then disable the
   target (immediate + persisted, as in Test 1).
4. Return to the flow (`page.goto(flowUrl)`), open the `model_model` picker, and
   assert **by identity** that no option matches the target's `data-value` /
   `data-testid`. Two guards make that zero mean removal rather than nothing: the
   picker must still be **populated**, and the provider's **other** models must
   still resolve by identity. Without them a zero is also what an empty or
   unparsable list produces (#1012). Both figures come from the **same** read as the
   zero, and the populated check runs **before** the poll — `enumerateModelOptions`
   swallows its own wait, so a picker that never opens would otherwise burn the whole
   poll budget in one predicate call and abort with no cause named.
5. Re-enable the target model in Settings, return to the flow, and assert the
   option reappears — again by identity, count `1`, behind the same populated guard
   so a popover that never opened is not reported as "re-enabling did not work".

---

## Waiting for the provider list *(required)*

Both tests reach the provider row through `waitForProviderRow()`
(`tests/helpers/provider-setup/provider-list-state.ts`), never through a bare
`page.getByTestId("provider-item-<Name>")` wait. The reason is attribution, not
timing, and the budgets are deliberately **unchanged** — raising them would hide
the state this wait exists to name.

The list is one component (`provider-list-loading` appears exactly once in the
1.12.0.dev44 bundle) shared by the Settings page and the Agent node's **Model
providers** modal, and it renders four mutually exclusive states, each with its
own testid:

| testid | state |
|---|---|
| `provider-list-loading` | still fetching (`GET /api/v1/models?purpose=configure`), or React Query `paused` |
| `provider-list-error` | the fetch failed |
| `provider-list-empty` | the search box filtered every provider out |
| `provider-list` | settled, holding the `provider-item-*` rows |

Waiting only for the row discards all four, and the resulting
`TimeoutError: locator.click … waiting for getByTestId('provider-item-OpenAI')`
cannot distinguish an unresponsive instance from a provider Langflow stopped
shipping. Measured on #1648: **20 attempts across 8 of 25 dailies**
(2026-08-04 → 2026-08-31), 12 spec files, three providers (Google 9, OpenAI 8,
Anthropic 3) — and in **0 of 20** did the call log get past `waiting for
<locator>`. The failure-time screenshot of daily `33410643882` shows
**`Loading providers...`** on screen while the aria snapshot captured moments
later shows all nine rows, which is why the same artifacts read as a product
defect at triage and as an environment stall on review. None of the five
patterns in `scripts/lib/infra-signature-patterns.json` match a locator timeout,
so `infra_signature` came back `null` for every one of them (#1589), and
`reports/daily-history.jsonl` stores only the normalized first error line, so a
search for `provider-item` across all 21 August dailies returns **zero**
(#1626). The helper is what makes those 20 occurrences say what they are.

`providerRowVerdict()` is a **pure** function over the snapshot, unit-tested in
`provider-list-state.test.ts`, because the branches that matter are otherwise
reachable only from an instance that is misbehaving on purpose. Its verdicts:

| kind | when | reads as |
|---|---|---|
| `stalled` | `provider-list-loading` still on screen | an INSTANCE stall — the backend has not answered |
| `errored` | `provider-list-error` | the fetch failed; a backend verdict, not a missing provider |
| `filtered` | `provider-list-empty`, or a non-empty search box | a SUITE defect — a previous step left the filter set |
| `absent` | `provider-list` rendered, the row is not among its rows | a PRODUCT finding — it names the providers that DID render |
| `unreached` | none of the four states present | the page or the modal never opened (`openProviderPanel` returns `"opened"` without verifying) |

---

## Validation criterion *(required)*

- Toggling a model flips `aria-checked` immediately (optimistic update).
- A `POST /api/v1/models/enabled_models` is sent after the debounce; reopening Model Providers reflects the persisted state.
- A disabled model disappears from the Agent's `model_model` dropdown; re-enabling restores it.
- Every dropdown verdict is reached from the option's **identity**, never its text, and a
  negative verdict is only accepted from a picker that is populated and still parsable —
  so "the model is gone" can fail, and cannot be satisfied by an empty or renamed list.
- A provider row that never appears fails with the product state named — `stalled`,
  `errored`, `filtered`, `absent` or `unreached` — never as a bare locator timeout.
  Force-failable in both directions: hold `GET /api/v1/models?purpose=configure` past
  the budget and the failure must say `PROVIDER_LIST_STALLED`; render the list without
  the target provider and it must say `PROVIDER_ABSENT` and list the ones that rendered.
- The baseline is restored at the end of each test (model left enabled) so sibling specs are unaffected.

---

## Account-global state cleanup *(required)*

Test 2 disables a model in Settings, which is **account-wide** — not per-flow and not
per-worker. Until #1464 that mutation was unreachable (the provider-prefixed model name
made the test skip before the disable), so no failure-path restore existed; waking the
test makes one mandatory. The spec arms `disabledModel` the moment the toggle goes off,
disarms it when the test re-enables the model itself, and a `test.afterEach` restores
anything still armed through `POST /api/v1/models/enabled_models`
(`[{provider, model_id, enabled: true, model_type: "llm"}]`) — over the **API**, because
after a mid-test failure the page can be anywhere and a restore needing Settings to
render is one that fails exactly when it is needed. A failed restore is **logged loudly**
and never swallowed: leaving it silent would hand every later spec a disabled model with
nothing in the log naming why (#1012). Relying on a sibling's `setup-*` enable-all pass
is not sufficient — it repairs only when a later spec configures the **same** provider in
the same lane, which the daily's weekday provider rotation does not guarantee, and
`setup-language-model-openai.ts` enables a single model and repairs nothing.

Behavioral force-fail contract: leave the model disabled with the restore no-op'd, and a
sibling spec pinning that model skips or fails.

---

## Flow cleanup *(required)*

Both tests create a flow via `SimpleAgentTemplatePage.load()`, which does NO
cleanup (post-#553 contract). The spec tracks every `POST /api/v1/flows` →
201 id fired during load and deletes them by id in `test.afterEach`
(id-scoped — never name-based or delete-all; the file previously leaked 2
flows per run). Behavioral force-fail contract: no-op the cleanup and the
flow count grows.

---

## External dependencies *(required)*

- `src/frontend/src/modals/modelProviderModal/components/ModelSelection.tsx` — renders the `llm-toggle-<model_name>` / `embeddings-toggle-<model_name>` switches, the `llm-models-section` / `embeddings-models-section` containers, and `model-search-input`. Renaming these `data-testid` attributes breaks the test.
- `src/frontend/src/modals/modelProviderModal/components/ModelProvidersContent.tsx` and `pages/SettingsPage/pages/ModelProvidersPage/index.tsx` — host the model selection panel and the `provider-item-...` / `model-provider-selection` testids.
- `src/frontend/src/modals/modelProviderModal/hooks/useModelToggleQueue.ts` — the optimistic queue + ~1s debounced `POST .../enabled_models` write under test. Changing the endpoint or debounce affects the persistence wait.
- `src/frontend/src/hooks/use-refresh-model-inputs.ts` — refreshes component model dropdowns when toggles change (the propagation behavior in Test 2).
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/` — renders the Agent's `model_model` trigger, `value-dropdown-model_model` value span, and the `-option` dropdown entries. `components/ModelList.tsx` owns `getModelOptionTestId(provider, modelName)` = `${provider}-${modelName}-option` and the cmdk `value` = `${provider}::${modelName}` that surfaces as `data-value` — the two attributes this spec resolves a model by.
- `tests/helpers/provider-setup/model-option.ts` — the shared identity reader (#1463): `enumerateModelOptions()`, `enumerateEnabledModels()`, `ModelOption`, plus `censusForTarget()` / `hasOptionIdentity()` (#1464). Test 2 matches options exclusively through it; the classification is pure and unit-tested in `model-option.test.ts`, because the branch that must not regress ("a `target: 0` verdict counts only with `total > 0` and `providerOthers > 0`") is otherwise reachable only from a live run.
- `tests/helpers/provider-setup/provider-list-state.ts` — `waitForProviderRow()` and the pure `providerRowVerdict()` (#1648). Reads the four provider-list states listed above; `provider-list-state.test.ts` covers the classification.
- `src/frontend/src/modals/modelProviderModal/components/ProviderList.tsx` — owns all four state testids (`provider-list-loading` line 82, `provider-list-error` 94, `provider-list-empty` 105, `provider-list` 119 on `release-1.12.0`). Renaming any of them turns the verdict into `unreached`, which is a loud failure rather than a silent one.
- `src/frontend/src/modals/modelProviderModal/components/ProviderListItem.tsx` — the row itself, whose testid is built as `provider-item-` plus the provider's display name. Single source of the name this suite waits on.
- `src/frontend/src/modals/modelProviderModal/components/ModelProvidersContent.tsx` — hosts `provider-search-input`, read by the `filtered` verdict so a filter a previous step left set is reported as a SUITE defect and not as a missing provider.
- `tests/helpers/provider-setup/provider-config.ts` — `langflowProviderName()` supplies the provider as Langflow spells it (`OpenAI`, `Google Generative AI`), which is what the picker groups options by and what the restore payload sends.
- `tests/helpers/provider-setup/` and `data/models.json` — provider setup and model source of truth (populated by `collect-models`).

---

## What this test does not cover *(optional)*

- Embedding-model toggles (`embeddings-toggle-...`) — only LLM toggles are exercised.
- The provider modal entry point (`ModelProviderModal` with `onFlushRef`) — only the Settings page entry point is tested, where persistence relies on the debounce rather than a flush-on-close.
- Backend correctness of the enabled-models payload beyond the round-trip UI assertion.
- Deprecated-model rows (collapsed under `*-deprecated-disclosure`).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- At least one provider has its env keys set (e.g. `OPENAI_API_KEY`). A real API key is required to configure the provider so models are listed, but no LLM call is made.
- Run with `--workers=1`: named template loads collide under parallelism, and Test 2's
  toggle is **account-global** state that a concurrent provider setup would fight over.
  The spec also sets file-level serial mode. (`SimpleAgentTemplatePage.load()` does
  **not** delete flows — the cross-worker wipe was removed in #553; this precondition
  claimed the opposite until #1464.)

---

## Notes *(optional)*

- Models are only listed once the provider has an API key configured — the spec cannot run standalone without provider setup.
- The `model-search-input` filter is used before reading a toggle so the target row is always rendered on-screen, regardless of how many models the provider exposes.
- The Settings page mounts `ModelProvidersContent` without `onFlushRef`, so persistence depends on the ~1s debounce; the test waits for the `POST` response rather than a fixed timeout.
- **Why Test 2 resolves a model by identity and not by name or text (#1464).** The two
  surfaces spell the same model differently, and both spellings were measured on
  `1.12.0.dev30`:

  | Surface | Attribute | Measured value |
  |---|---|---|
  | Agent picker option | `data-testid` | `Anthropic-claude-opus-5-option` |
  | Agent picker option | `data-value` | `Anthropic::claude-opus-5` |
  | Agent picker option | `textContent` | `claude-opus-51 of 69` |
  | Provider panel toggle | `data-testid` | `llm-toggle-gpt-5.6-sol` |

  Stripping `-option` therefore yields a **provider-prefixed** name that can never
  intersect the panel's bare ids, which made Test 2 skip on every run while counting as
  `@stable` coverage. And the option's text carries an `sr-only` position counter glued
  to the name with no separator (`claude-opus-5` + `1 of 69`, from `1.12.0.dev26`), so
  the anchored `^model$` matchers the removal and re-enable asserts used to run matched
  nothing — `toHaveCount(0)` passed whether or not the model had been removed. Both are
  closed by reading `data-value` / `data-testid` through `model-option.ts`.
