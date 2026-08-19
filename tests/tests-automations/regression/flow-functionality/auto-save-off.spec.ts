import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";

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

/**
 * The id of the flow currently open in the editor, cross-checked against the
 * flows THIS page created.
 *
 * The cross-check is the point: an id in the URL that this page never created
 * means the spec is driving somebody else's flow — the state #1336 spent two
 * dailies failing on, and one better named here than six steps later as a
 * 45 s timeout.
 */
async function editorFlowId(page: Page): Promise<string> {
  const id = new URL(page.url()).pathname.match(/\/flow\/([0-9a-f-]{36})/)?.[1];
  // The POST body is parsed asynchronously, so the entry can land a tick after
  // the navigation; poll briefly rather than racing it.
  await expect
    .poll(() => createdFlowIds.includes(id ?? ""), { timeout: 10000 })
    .toBe(true);
  return id!;
}

/**
 * Leaving the canvas is itself part of the contract under test, so assert it
 * instead of inferring it from whatever the next step happens to find. When the
 * save behind "Save And Exit" fails, the editor simply stays put — under the
 * old spec that surfaced 45 s later as a card-click timeout on the flows list
 * (#1336), which named neither the step nor the cause. Verified by forcing the
 * save PATCH to 500: the failure now lands on this call.
 */
async function expectLeftEditor(page: Page): Promise<void> {
  await page.waitForURL((url) => !url.pathname.startsWith("/flow/"), {
    timeout: 30000,
  });
}

/**
 * Re-open THIS test's flow by id and wait until its graph has been applied to
 * the canvas.
 *
 * Why by id and not through the flows-list card (#1336). The spec used to click
 * the first `list-card` whose name contained "New Flow". Langflow names every
 * blank flow "New Flow"/"New Flow (N)", so under `fullyParallel` the list holds
 * one per worker — and the flows list is **paginated at 12, ordered by
 * `updated_at DESC`**. Both halves bite:
 *
 *  - the card that filter resolved was routinely ANOTHER worker's flow (proved
 *    on nightly 1.12.0.dev18: the page created ids `8e767306` and `ee8e0ab9`
 *    and the re-open landed on `164b3c19`, which it never created). When that
 *    worker's own id-scoped cleanup deleted it mid-test, the save PATCH came
 *    back 404, the editor never navigated back to the list, and the next
 *    re-open waited out its 45 s — the exact 2026-07-22 / 2026-08-06 daily
 *    signature, reproduced 3/8 at `--workers=4`;
 *  - this test's own card is frequently NOT on page 1 at all (measured: 12 of
 *    12 slots taken by fresher flows), so no card-based selector — not even the
 *    id-scoped `flow-name-<uuid>` testid the card carries — can find it.
 *
 * Opening by URL removes both. The trade-off is deliberate: what this spec
 * validates is server-side persistence across an exit/re-open, and a full
 * reload proves that more strictly than an SPA route change. The
 * "open a flow from its list card" path stays covered by the specs whose
 * subject it is (`bulk-actions`, `mcp-server`).
 *
 * The entry itself is `openFlowById` (#1214/#1342), not a local `goto` — #1336's
 * fix hand-rolled this block and became the fourth copy of exactly what that
 * helper was extracted to stop. Two of its guarantees matter here and the copy
 * had neither: the onboarding overlay cannot appear, and the editor is not handed
 * back while `POST /api/v1/authz/me/permissions` is still in flight — the #1005
 * window where a mutation is silently swallowed, and this spec adds a component
 * immediately after two of the three re-opens.
 *
 * What does NOT come from the helper is the flow-load wait below. Keep it.
 */
async function reopenFlow(page: Page, flowId: string): Promise<void> {
  // Ordering gate, registered BEFORE the navigation the helper performs.
  //
  // `openFlowById` returns on `canvas_controls_dropdown` + writability, and
  // neither implies the graph has been applied — the canvas chrome renders before
  // the nodes do. That matters for exactly one assertion and it is the one most
  // easily fooled: the discard check is `div-generic-node` count === 0, which
  // PASSES VACUOUSLY on a canvas that has not painted its nodes yet. So the count
  // is ordered after the flow's own GET, which is what applies the graph.
  const flowLoaded = page.waitForResponse(
    (resp) =>
      new URL(resp.url()).pathname === `/api/v1/flows/${flowId}` &&
      resp.request().method() === "GET" &&
      resp.status() === 200,
    { timeout: 45000 },
  );
  await openFlowById(page, flowId);
  await flowLoaded;
}

// Quarantined for #1489 — manual save never navigates to the new flow URL
// (recurrent 2×: dailies 2026-08-18 and 2026-08-19).
test.fixme(
  "user should be able to manually save a flow when the auto_save is off",
  { tag: ["@release", "@api", "@database", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    // Seeded HERE, not left to `openFlowById`'s own call, and the difference is
    // measurable rather than tidiness: upstream arms the onboarding tooltip at
    // canvas mount + 10 s and paints it OVER the canvas-controls bar, which is
    // what `adjustScreenView` clicks (#1220's measurement). This test calls
    // `adjustScreenView` four times across a ~15–25 s run, so the first editing
    // phase — before any re-open — is inside that window. `addInitScript` only
    // applies to loads that follow it, so it has to precede the bootstrap's
    // navigation; the helper's later calls are idempotent per page.
    await seedAssistantDiscovered(page);

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

    // `awaitBootstrapTest` reaches the templates modal through the "New Flow"
    // entry point, which already parked the page on a freshly created
    // PLACEHOLDER flow — and Langflow deletes that placeholder as soon as the
    // modal navigates elsewhere. So the id has to be read after the blank-flow
    // navigation, never from the URL standing before it (#490/#681).
    const placeholderUrl = page.url();
    await page.getByTestId("blank-flow").click();
    await page.waitForURL(
      (url) =>
        /\/flow\/[0-9a-f-]{36}/.test(url.pathname) &&
        url.toString() !== placeholderUrl,
      { timeout: 30000 },
    );

    // Resolve the flow under test once, before any edit: every re-open below is
    // pinned to this id, so the spec can never drive a parallel worker's
    // identically-named "New Flow" (#1336).
    const flowUnderTest = await editorFlowId(page);

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
    await expectLeftEditor(page);

    await reopenFlow(page, flowUnderTest);

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
    await expectLeftEditor(page);

    await reopenFlow(page, flowUnderTest);

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
    await expectLeftEditor(page);

    await reopenFlow(page, flowUnderTest);

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
