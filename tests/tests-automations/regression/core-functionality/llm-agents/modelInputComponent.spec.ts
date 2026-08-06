import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../../helpers/flows/track-created-flows";
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

  test.fixme(
    "the trigger shows the selected model name",
    // Quarantined at triage of #1296 (PR #1308) — NOT lifted here: #1265 owns the
    // sidebar flake above, #1304 owns this one. Hard failure on 2026-08-05: the
    // canvas renders no node at all (`[data-testid^="rf__node-"]` never resolves),
    // on all 3 attempts, with zero overlap against any measured backend-outage
    // window on its shard.
    //
    // #1265's investigation found a MECHANISM for it, which is why the two stay
    // separate rather than merging as #1304 offered: this test is green 44/44 solo
    // on 1.12.0.dev17, and fails only when a spec that mutates ACCOUNT-WIDE
    // provider credentials runs beside it. Reproduced in the daily's own shape
    // (`PW_SHARD_FILE_LEVEL=1 --workers=2 --retries=0`) against
    // `model-provider/openai-compatible-provider-setup.spec.ts`, whose `afterEach`
    // purges the OpenAI-Compatible credential pair unconditionally: 3 of 12 of
    // this file's test executions failed with exactly this signature (rounds 1 and
    // 3; in round 2 it passed but took 19.3 s against 3.5–8.1 s solo), and the
    // neighbour failed 3/3 with its own credential dropped to `""` (LE-2124). The
    // control — same shape, same worker count, `core-components/tool-mode.spec.ts`
    // as the neighbour instead — is the discriminator, and its result belongs in
    // #1304 with the rest of the evidence.
    { tag: ["@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await addLanguageModelNode(page);

      // The catalog pre-selects a default model, so the trigger must show a
      // concrete model name, not a "Select…" placeholder. NOT key-independent,
      // as this comment used to claim: with no provider credential at all the
      // trigger is a "Setup Provider" CTA and `model_model` is absent — see the
      // provider prerequisite at the top of the file (#1265).
      const text = (await page.getByTestId("model_model").textContent())?.trim() ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/select a model/i);
    },
  );
});
