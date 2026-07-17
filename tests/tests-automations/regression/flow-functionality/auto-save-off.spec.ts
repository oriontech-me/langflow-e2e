import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach. awaitBootstrapTest runs
// first, so a bare page.url() capture races the bootstrap flow's stale id
// (#490/#681); the response ids are authoritative and worker-safe. Without this
// the spec leaked a "New Flow" per run.
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

// The /flows a11y refactor (Langflow #13891) makes `flow-name-div`
// `pointer-events-none`; open the flow via the card's overlay button.
async function reopenNewFlow(page: Page): Promise<void> {
  // Explicit timeout above the 20s default actionTimeout: this heavy spec (two
  // bootstraps + repeated exit/re-open cycles) blew the default card-open click
  // under CI saturation on load-degraded dailies (#790). The extra headroom
  // absorbs transient load without masking a real regression.
  await page
    .getByTestId("list-card")
    .filter({
      has: page.getByTestId("flow-name-div").filter({ hasText: "New Flow" }),
    })
    .getByTestId("list-card-open-button")
    .first()
    .click({ timeout: 45000 });
}

test(
  "user should be able to manually save a flow when the auto_save is off",
  { tag: ["@stable", "@release", "@api", "@database", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          type: "full",
          auto_saving: false,
          frontend_timeout: 0,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 5000,
    });

    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");

    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 3000,
    });

    // The Chat Input sidebar row briefly toggles `pointer-events-none`; hover its
    // draggable wrapper (which always takes pointer events) to reveal the add
    // button, then click the button (chained so the hover holds) — dragging the
    // row is unreliable while it is pointer-events-none.
    await page
      .getByTestId("input_output_chat input_draggable")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-input").click();
      });

    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 5000,
    });

    await adjustScreenView(page);

    // With auto-save off, the manual save button is present and enabled.
    await expect(page.getByTestId("save-flow-button")).toBeEnabled({
      timeout: 5000,
    });

    await page.waitForSelector("text=loading", {
      state: "hidden",
      timeout: 5000,
    });

    // Exit without saving: the unsaved-changes dialog is deterministic here
    // (auto-save off + an unsaved node). Discard via "Exit Anyway".
    await page.getByTestId("icon-ChevronLeft").last().click();
    await expect(
      page.getByText("Unsaved changes will be permanently lost."),
    ).toBeVisible({ timeout: 10000 });
    await page.getByText("Exit Anyway", { exact: true }).click();

    await reopenNewFlow(page);

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 5000,
    });

    // The unsaved node was discarded — the canvas is empty.
    const chatInputNode = await page.getByTestId("div-generic-node").count();
    expect(chatInputNode).toBe(0);

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");

    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 3000,
    });

    await page
      .getByTestId("input_output_chat input_draggable")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-input").click();
      });

    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 5000,
    });

    await adjustScreenView(page);

    // Exit and persist via the exit dialog's "Save And Exit".
    await page.getByTestId("icon-ChevronLeft").last().click();
    const saveAndExit = page.getByText("Save And Exit", { exact: true }).last();
    await expect(saveAndExit).toBeVisible({ timeout: 10000 });
    await saveAndExit.click();

    await reopenNewFlow(page);

    await page.waitForSelector("text=loading", {
      state: "hidden",
      timeout: 5000,
    });

    // The saved node persisted across the exit/re-open.
    await expect(page.getByTestId("title-Chat Input").first()).toBeVisible({
      timeout: 5000,
    });

    // Second edit uses a DIFFERENT core component (Chat Output): Langflow hides a
    // component's quick-add button once a copy is on the canvas, so re-adding the
    // same Chat Input via hover is not possible — a distinct component keeps the
    // add reliable and still proves a subsequent edit persists.
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");

    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 3000,
    });

    await page
      .getByTestId("input_output_chat output_draggable")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 5000,
    });

    await adjustScreenView(page);

    // Exercise the on-canvas manual save button, then exit. The exit guard is
    // timing-dependent here: if the manual save settled, the exit is clean;
    // otherwise the unsaved-changes dialog appears and "Save And Exit" persists.
    // Either path is fine — the node count === 2 below is the gate that proves
    // both nodes persisted server-side, regardless of which path ran.
    // Explicit timeout above the 20s default: the manual-save click was the
    // signature that blew the default action timeout under CI saturation (#790).
    await page.getByTestId("save-flow-button").click({ timeout: 45000 });
    await page.getByTestId("icon-ChevronLeft").last().click();
    const saveAndExit2 = page.getByText("Save And Exit", { exact: true }).last();
    if (
      await saveAndExit2.isVisible({ timeout: 5000 }).catch(() => false)
    ) {
      await saveAndExit2.click();
    }

    await reopenNewFlow(page);

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 5000,
    });

    // Both saved nodes (Chat Input + Chat Output) persisted server-side.
    await expect(page.getByTestId("title-Chat Input").first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("title-Chat Output").first()).toBeVisible({
      timeout: 5000,
    });
    const nodeCount = await page.getByTestId("div-generic-node").count();
    expect(nodeCount).toBe(2);
  },
);
