import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../../helpers/flows/track-created-flows";
import {
  clickModelOption,
  enumerateModelOptions,
} from "../../../../helpers/provider-setup/model-option";
import { waitForAttributedSelector } from "../../../../helpers/other/page-entry-barrier";

// The Model Input selector on the canonical Language Model component
// (QA-CHECKLIST §7.5 "Model Input component"). Hardened for @stable (issue
// #505): the previous version targeted the legacy `modelsOpenAI` sidebar entry
// with every assertion inside `if (visible)` guards — it passed when the
// component never rendered. Now the canonical models_and_agents Language Model
// component is added unconditionally and every behavior is a hard assertion.

// PROVIDER PREREQUISITE — the whole file needs at least one provider CREDENTIAL
// configured in Langflow (measured on 1.12.0.dev17, #1265). With none, the node
// still mounts but its Language Model field renders a **"Setup Provider"** CTA
// behind `parameter-permission-gate` instead of `model_model`, and all four
// tests fail on an observable that has nothing to do with what they assert. It
// is the credential that matters, not a funded key: today's local run has a
// drained `openai` (no credits) alongside an active anthropic/google and all
// four pass. Nothing to wire up — `@model-provider` already makes
// `scripts/provider-dependent-specs.mjs` force the `Collect models` sweep for
// this file, and the daily always runs it — but locally, run
// `npx playwright test tests/collect-models.spec.ts` first or the failures look
// like a model-selector regression.

// UI-created flows need explicit cleanup or they accumulate on the instance.
// The canvas URL carries a TRANSIENT id on 1.11 (the persisted flow gets a
// different one — deleting the URL id 404s), so ids come from the page's own
// `POST /api/v1/flows` 201 bodies. Targeted delete, never cleanAllFlows:
// parallel workers own their own flows.
//
// Via the shared tracker (#1108) rather than a local `waitForResponse`, because
// this entry point creates TWO flows and the local capture only ever saw one
// (#1265). `awaitBootstrapTest` → `openNewFlowTemplatesModal` clicks "New Flow",
// which on this build creates a flow of its own before the templates modal opens
// (#1002) — and it runs BEFORE the old capture was armed, so that flow leaked on
// every call: 2 orphaned "New Flow"/"New Flow (2)" were sitting on the local
// instance when this issue was worked. The tracker listens from `beforeEach`, so
// it catches both, and it settles its in-flight body reads before deleting (the
// axis 50 of the 51 hand-rolled copies got wrong).
let flows: FlowTracker;

async function addLanguageModelNode(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
  // Attributed, not a bare `locator.waitFor` (#1265). Every test in this file
  // reaches the Language Model node THROUGH the component sidebar, so this wait
  // — not the model selector the tests are named for — is what times out when
  // Langflow stalls. Both recorded flakes were exactly that: on the 2026-08-04
  // daily the failing attempt spanned two measured shard-2 outages (76s + 92s,
  // gunicorn `WORKER TIMEOUT` + SIGKILL at 10:46:30) and took 287s where its own
  // siblings took ~6s once the backend recovered. The budget is unchanged at 30s
  // — the barrier attributes the failure, it does not paper over a slow surface.
  await waitForAttributedSelector(
    page,
    '[data-testid="sidebar-search-input"]',
    30000,
    { surface: "component-sidebar" },
  );
  await addComponentFromSidebar(
    page,
    "language model",
    "add-component-button-language-model",
  );
  // `addComponentFromSidebar` now returns only once a node landed (#1304), so
  // this is the file's own observable — the node is VISIBLE, not merely in the
  // DOM — and no longer the place a swallowed add gets reported.
  const node = page.locator('[data-testid^="rf__node-"]').first();
  await expect(node).toBeVisible({ timeout: 15000 });
  return node;
}

test.describe("ModelInputComponent", () => {
  // Armed before the test body, so the flow "New Flow" creates during bootstrap is
  // captured too — that is the leak the local capture could not see.
  test.beforeEach(({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    // The tracker authenticates with the Bearer token itself: `page.request`
    // carries only browser cookies and the flows API wants the header, so a
    // silent 401 here would leak every flow.
    await flows.cleanup(request);
    flows.dispose();
  });

  test(
    "the Language Model node renders its model selector",
    {
      tag: [
        "@stable",
        "@release",
        "@components",
        "@workspace",
        "@model-provider",
      ],
    },
    async ({ page }) => {
      const node = await addLanguageModelNode(page);
      await expect(node.getByTestId("model_model")).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "opening the model dropdown lists model options",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await addLanguageModelNode(page);
      await page.getByTestId("model_model").click();

      // The unified catalog renders one `<model>-option` entry per model.
      await expect(
        page.locator('[data-testid$="-option"]').first(),
      ).toBeVisible({ timeout: 10000 });
      expect(
        await page.locator('[data-testid$="-option"]').count(),
      ).toBeGreaterThan(1);
    },
  );

  test(
    "the model dropdown exposes the Manage Model Providers entry",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await addLanguageModelNode(page);
      await page.getByTestId("model_model").click();

      await expect(page.getByTestId("manage-model-providers")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "the trigger shows the model the user selects",
    // Renamed in #1445 because the old title ("the trigger shows the SELECTED
    // model name") promised a selection this test never made: it read the
    // trigger of a freshly added node and asserted only that the text was not a
    // "Select…" placeholder. That passed on a pre-fill nobody asked for, and it
    // is now a selection the test performs itself.
    //
    // The premise it used to encode — "the catalog pre-selects a default model"
    // — EXPIRED with upstream langflow#14505 ("fix: stop pre-selecting an
    // unconfigured model", merged 2026-08-12 into release-1.12.0), which removed
    // the empty-field fallback to `options[0]` on both sides: the frontend
    // (`useAutoSelectModel.ts` now replaces only a STALE selection;
    // `derive-selected-model.ts` renders the placeholder instead of
    // `flatOptions[0]`) and the backend (`unified_models/build_config.py` gates
    // that fallback behind `user_triggered = field_name is not None`, citing
    // LE-2168). The reason is that a provider counts as enabled purely because a
    // credential exists, so an env-harvested key made the node advertise a
    // provider the user never set up. That PR's own verification says a freshly
    // added Language Model node now shows "Select a model" — and it inverted
    // four of its own assertions for the same reason while stating the Playwright
    // E2E suite was not run, which is why this file reddened the next morning
    // (daily run 31685261355, 3/3 attempts; reproduced 5/5 locally on
    // 1.12.0.dev25). NOT langflow#14465, the lead the issue carried: that one
    // only stopped substituting an EXPLICITLY CLEARED selection and left the
    // initial-load default intact.
    //
    // Neither the failing daily nor the local repro was a provider artefact —
    // the catalog offered 89 models across three providers and `options[0]` was
    // `claude-opus-5` from the ACTIVE Anthropic, so there was a healthy model to
    // pre-select and it was still not pre-selected (OpenAI's key was drained on
    // both, see #1442/#1443).
    //
    // The earlier quarantine (#1304) was a different mechanism and is not in this
    // test nor in this file: the SHARED sidebar add dropped its click (4/20 on
    // 1.12.0.dev17), which `addComponentFromSidebar` now verifies and repairs.
    {
      tag: [
        "@stable",
        "@release",
        "@components",
        "@workspace",
        "@model-provider",
      ],
    },
    async ({ page }) => {
      await addLanguageModelNode(page);
      const trigger = page.getByTestId("model_model");

      // Post-#14505 initial state. Asserted, not tolerated: a silent return of
      // the auto-fill is exactly the regression LE-2168 fixed, and only this
      // half of the test can catch it.
      await expect(trigger).toHaveText(/^select a model$/i, { timeout: 10000 });

      await trigger.click();

      // The expected label is read FROM THE DOM rather than hardcoded, so a
      // catalog reorder or a retired model id cannot make this test wrong —
      // whichever model the instance offers first is the one selected.
      //
      // It is read through `enumerateModelOptions`, NOT with the option's own
      // `innerText()`, and that is #1460: since 1.12.0.dev26 every option
      // renders its position inside itself —
      //
      //     <div data-testid="Anthropic-claude-opus-5-option" role="option">
      //       <div class="truncate text-[13px]">claude-opus-5</div>
      //       <span class="sr-only">1 of 59</span>
      //     </div>
      //
      // The span is invisible to a user but part of `textContent`, so the raw
      // read returned "claude-opus-5\n1 of 59" and this assertion failed with a
      // polluted EXPECTED value while the trigger — the product side — was
      // correct all along. The helper strips `sr-only` and badge nodes inside
      // the page and hands back `visibleLabel`: what a user actually reads.
      // Reproduced on 1.12.0.dev33 before this change (expected
      // "claude-opus-5\n1 of 5" against a 5-model local catalog, 1 of 1 runs) and
      // green after it.
      const options = await enumerateModelOptions(page, 15000);
      expect(
        options.length,
        "the open picker must offer at least one model option",
      ).toBeGreaterThan(0);
      const modelLabel = options[0].visibleLabel;
      expect(modelLabel.length).toBeGreaterThan(0);
      expect(modelLabel).not.toMatch(/select a model/i);

      await clickModelOption(page, options[0]);

      // Exact equality, which subsumes "the placeholder is gone" — the old
      // assertion only demanded the text differ from the placeholder and would
      // have accepted any value the picker happened to hold.
      await expect(trigger).toHaveText(modelLabel, { timeout: 10000 });
    },
  );
});
