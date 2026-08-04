import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The Model Input selector on the canonical Language Model component
// (QA-CHECKLIST §7.5 "Model Input component"). Hardened for @stable (issue
// #505): the previous version targeted the legacy `modelsOpenAI` sidebar entry
// with every assertion inside `if (visible)` guards — it passed when the
// component never rendered. Now the canonical models_and_agents Language Model
// component is added unconditionally and every behavior is a hard assertion.

// UI-created flows need explicit cleanup or they accumulate on the instance.
// The canvas URL carries a TRANSIENT id on 1.11 (the persisted flow gets a
// different one — deleting the URL id 404s), so capture the real id from the
// page's own POST /api/v1/flows/ response instead. Targeted delete, never
// cleanAllFlows: parallel workers own their own flows.
const createdFlowIds: string[] = [];

async function addLanguageModelNode(page: any) {
  await awaitBootstrapTest(page);
  const flowCreated = page
    .waitForResponse(
      (r: any) =>
        r.url().includes("/api/v1/flows/") &&
        r.request().method() === "POST" &&
        r.status() < 300,
      { timeout: 30000 },
    )
    .then(async (r: any) => (await r.json()).id as string)
    .catch(() => undefined);
  await page.getByTestId("blank-flow").click();
  await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
  const flowId = await flowCreated;
  if (flowId) createdFlowIds.push(flowId);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 30000 });
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
  test.afterEach(async ({ request }) => {
    // page.request carries only browser cookies — the flows API wants the
    // Bearer token, so authenticate explicitly (a silent 401 here leaks flows).
    if (createdFlowIds.length === 0) return;
    const bearer = await getAuthToken(request);
    while (createdFlowIds.length > 0) {
      const id = createdFlowIds.pop();
      if (!id) continue;
      await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
    }
  });

  // Quarantined for #1265 — recurrent flake: the wait that times out is
  // `sidebar-search-input`, not the model selector this test is named for
  // (same signature on the 2026-07-15 and 2026-08-04 dailies). Lifting the
  // quarantine (remove test.fixme + restore @stable) is a deliverable of #1265.
  test.fixme(
    "the Language Model node renders its model selector",
    { tag: ["@release", "@components", "@workspace", "@model-provider"] },
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
    "the trigger shows the selected model name",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await addLanguageModelNode(page);

      // The catalog pre-selects a default model (key-independent), so the
      // trigger must show a concrete model name, not a "Select…" placeholder.
      const text = (await page.getByTestId("model_model").textContent())?.trim() ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/select a model/i);
    },
  );
});
