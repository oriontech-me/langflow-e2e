# Model Input component — the Language Model node's model picker

**Last validated:** Langflow 1.12.x (measured on `1.12.0.dev33`)

---

## What this test validates *(required)*

Covers the **Model Input** selector rendered by the canonical `models_and_agents`
**Language Model** component (QA-CHECKLIST §7.5 *Model Input component*) — the
unified model picker that replaced the per-provider inline fields in 1.11. Four
behaviours, all pure UI/state (no LLM call is made, no flow is run):

1. A freshly added Language Model node renders the picker trigger `model_model`.
2. Opening the picker lists more than one model option.
3. The open picker exposes the **Manage Model Providers** entry — the only route
   from the node to the global credential surface since credentials stopped being
   node-level fields.
4. **The trigger reflects the model the user selects** — the picker is not merely
   present, it is *usable*: the trigger goes from the `"Select a model"`
   placeholder to exactly the model name that was clicked.

### The premise behind behaviour 4 changed in 1.12 — this is the current one

Until 1.12 this test asserted the opposite of what it asserts now. A freshly
added node used to come up with a model **pre-selected**, because both the
frontend and the backend filled an empty `model` field with `options[0]` — the
first default-enabled model of the first *enabled* provider. The assertion was
"the trigger is not a `Select…` placeholder", and it never selected anything.

Upstream [langflow#14505](https://github.com/langflow-ai/langflow/pull/14505) —
*"fix: stop pre-selecting an unconfigured model"*, merged **2026-08-12** into
`release-1.12.0` — removed that fill deliberately, on both sides:

- **frontend** — `hooks/useAutoSelectModel.ts` now replaces only a *stale*
  selection (provider disconnected, model deactivated); an empty field is left
  empty. `helpers/derive-selected-model.ts` renders the placeholder instead of
  `flatOptions[0]`.
- **backend** — `unified_models/build_config.py` gates the `options[0]` fallback
  behind `user_triggered = field_name is not None`, i.e. a bare initial load no
  longer fills. The inline comment names the ticket (LE-2168) and the reason: a
  provider counts as *enabled* purely because a credential exists
  (`skip_validation=True`), and env-harvested keys therefore made the node
  advertise a provider the user never set up.

That PR's own verification reads: *"After the fix, a freshly added Language Model
node shows **Select a model**; the dropdown still lists every model and a manual
pick persists."* It also inverted four of its own assertions for the same reason
and states *"the Playwright E2E suite was not run"* — which is why this suite
reddened the next morning (issue #1445, daily run 31685261355).

So behaviour 4 now encodes both halves of the current contract, in one causal
test: the fresh node **must** show the placeholder (which pins the LE-2168 fix
against a silent return of the auto-fill), and after a pick the trigger **must**
show that exact model name. This is strictly stronger than the pre-1.12
assertion, which only demanded "not the placeholder" and could be satisfied by
any accidental value.

**What is deliberately *not* asserted here:** the preserved
`__default_language_model__` auto-selection path. Measured on `1.12.0.dev25`,
setting that variable via `POST /api/v1/models/default_model` does **not** change
the trigger on a freshly dropped node — the stored default acts only through a
backend `update_build_config` round-trip, not through the frontend's mount-time
render. Covering it would require a different entry point and belongs in its own
spec.

---

## Tags *(required)*

`@stable` `@release` `@components` `@workspace` `@model-provider`

All four tests carry the same set. `@model-provider` is load-bearing beyond
categorisation: `scripts/provider-dependent-specs.mjs` reads it to force the
`Collect models` sweep for this file on the PR lane, which is what satisfies the
provider prerequisite below.

---

## Step-by-step *(required)*

Every test starts from the same entry point (`addLanguageModelNode`):

1. `awaitBootstrapTest(page)` → click `blank-flow` → wait for `/flow/{id}`.
2. Wait for `sidebar-search-input` through `waitForAttributedSelector` with
   `surface: "component-sidebar"` — the component sidebar, not the model
   selector, is what times out when Langflow stalls, and the barrier attributes
   the failure instead of blaming the assertion the test is named for.
3. `addComponentFromSidebar(page, "language model", "add-component-button-language-model")`
   — returns only once a node landed, repairing one swallowed click (#1304).
4. Assert `[data-testid^="rf__node-"]` is **visible**.

Then, per test:

**4.1 — the Language Model node renders its model selector**

5. Assert `model_model` is visible on the node.

**4.2 — opening the model dropdown lists model options**

5. Click `model_model`.
6. Assert the first `[data-testid$="-option"]` is visible and the option count is
   greater than 1.

**4.3 — the model dropdown exposes the Manage Model Providers entry**

5. Click `model_model`.
6. Assert `manage-model-providers` is visible.

**4.4 — the trigger shows the model the user selects**

5. Read `model_model` and assert it is the placeholder — matches
   `/^select a model$/i`. This is the post-#14505 initial state.
6. Click `model_model` to open the picker.
7. Wait for the first `[data-testid$="-option"]`, read **its own label** (the
   option's inner text is the bare model name) and its `data-testid` — the
   option testid shape is `{Provider}-{model}-option`, e.g.
   `Anthropic-claude-opus-5-option` (frontend `ModelList.getModelOptionTestId`).
   The model is never hardcoded: whichever option the catalog puts first is the
   one used, so the test is provider-agnostic and survives model retirement.
8. Click that option.
9. Assert `model_model` now reads **exactly** the label captured in step 7, and
   no longer matches the placeholder.

Cleanup (all tests): flows created through the UI are tracked from `beforeEach`
by `trackCreatedFlows` and deleted id-scoped in `afterEach`. This entry point
creates **two** flows — `awaitBootstrapTest` → `openNewFlowTemplatesModal` clicks
"New Flow", which creates a flow of its own before the modal opens (#1002) —
which is why the tracker is armed before the test body and a local
`waitForResponse` is not enough (#1265). Never `cleanAllFlows`: parallel workers
own their own flows.

---

## Validation criterion *(required)*

- **4.1** — `model_model` is visible on the freshly added node.
- **4.2** — at least two `[data-testid$="-option"]` entries render in the open
  picker.
- **4.3** — `manage-model-providers` is visible in the open picker.
- **4.4** — the trigger reads `Select a model` before the pick, and after
  clicking the first option it reads exactly that option's model label (e.g.
  `claude-opus-5`), with the placeholder gone. The label comes from the DOM, not
  from a constant, so a catalog reorder or a retired model cannot make this test
  wrong.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/`
  — renders the `model_model` trigger, the `value-dropdown-model_model` value
  span, the `{Provider}-{model}-option` entries and the `manage-model-providers`
  footer entry. Renaming these `data-testid` attributes breaks every test here.
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/components/ModelTrigger.tsx`
  — derives the displayed label; the `Select a model` placeholder string is
  test 4.4's initial-state anchor.
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/components/ModelList.tsx`
  — `getModelOptionTestId` defines the `{Provider}-{model}-option` shape the test
  reads the picked label from.
- The two frontend halves of the #14505 change — `useAutoSelectModel.ts` (under
  the component's `hooks/`) and `derive-selected-model.ts` (under its
  `helpers/`). Restoring the empty-field auto-fill in either would flip test
  4.4's first assertion; that is the regression this test now guards. **They are
  deliberately named here as bare filenames rather than as full upstream
  dependency paths, because they do not resolve on upstream `main`** — measured
  2026-08-13, they exist only on
  `origin/release-1.12.0`, together with `build-grouped-options.ts` and
  `useRefreshAfterProviderClose.ts`, while `main`'s `hooks/` holds only
  `useModelConnectionLogic.ts` and its `helpers/` only `model-option-identity.ts`
  and `recover-model-option.ts`. The release line is the one the nightly is cut
  from and the one this spec is validated against — the same ref distinction
  `CLAUDE.md` records for the component-distribution measurements. Citing them as
  dependency paths would fail `watch-upstream-areas.mjs --mode=check-docs`, which
  resolves against `main`, and the honest fact is that the refactor has not been
  merged back rather than that the files are missing.
- `src/lfx/src/lfx/base/models/unified_models/build_config.py` — the backend half
  (`user_triggered = field_name is not None`, LE-2168). Defence in depth for
  API-driven flows; the same guard. Unlike the two frontend files, this one is
  present on both refs.
- `tests/helpers/provider-setup/` + `data/models.json` / `providers.json` —
  produced by `tests/collect-models.spec.ts`; what puts a credential on the
  instance so the picker renders at all.

---

## Preconditions *(optional)*

**Provider credential prerequisite — the whole file needs it.** At least one
provider **credential** must be configured in Langflow. With none, the node still
mounts but its Language Model field renders a **"Setup Provider"** CTA behind
`parameter-permission-gate` and `model_model` is absent entirely, so all four
tests fail on an observable unrelated to what they assert (#1265, measured on
`1.12.0.dev17`).

It is the *credential* that matters, not a funded key: the 2026-08-13 validation
ran with a drained `openai` (no credits) alongside an active anthropic and
google, and the catalog still offered 89 models across all three providers.
That is also the control that rules the key out as a cause of the #1445 failure —
`options[0]` was `claude-opus-5` from the **active** Anthropic, so there was a
healthy model to pre-select and it was still not pre-selected.

Nothing to wire up in CI (`@model-provider` forces the sweep, and the daily
always runs it), but **locally run `npx playwright test tests/collect-models.spec.ts`
first** or the failures look like a model-selector regression.

---

## What this test does not cover *(optional)*

- Persistence of the pick across a reload / re-open of the flow (upstream #14505
  claims *"a manual pick persists"*; this test asserts the trigger, not the
  saved flow).
- The `__default_language_model__` auto-selection path — see the note under
  *What this test validates*.
- Running a flow with the selected model (covered by the agent and
  provider-execution specs).
- Provider credential configuration itself (covered by the provider-management
  specs under `core-functionality/model-provider/`).

---

## Change log

| Date | Langflow | Change |
|---|---|---|
| 2026-08-13 | `1.12.0.dev25` | Spec doc created (the file had none). Behaviour 4 rewritten: the pre-selected-default premise expired with upstream [#14505](https://github.com/langflow-ai/langflow/pull/14505); the test now asserts placeholder → pick → exact model name. Issue #1445, from daily triage #1444. |
| 2026-08-20 | `1.12.0.dev33` | **Behaviour 4 read the option's own `innerText()` and broke on the `sr-only` position counter (#1460).** Since 1.12.0.dev26 every option renders `<span class="sr-only">N of M</span>` inside itself, so the raw read returned `claude-opus-5\n1 of 59` and the assertion failed with a polluted EXPECTED value while the trigger — the product side — was correct. The label now comes from `enumerateModelOptions().visibleLabel`, which strips `sr-only` and badge nodes inside the page, and the click goes through `clickModelOption` (identity from `data-value` / `data-testid`) — the rule this folder's `CLAUDE.md` already stated: never resolve a model through the option's rendered text. Reproduced 1 of 1 before the change on `1.12.0.dev33` (expected `claude-opus-5\n1 of 5` against a 5-model local catalog), 4 of 4 tests green after it on 3 consecutive runs, force-fail verified by swapping `visibleLabel` for `rawText`. `@stable` restored (auto-removed by `f6f4c39` for daily 31786538844). Fixed inside PR #1538; #1460 stays open for its second row, `memory-base-registration.spec.ts:232`. |
