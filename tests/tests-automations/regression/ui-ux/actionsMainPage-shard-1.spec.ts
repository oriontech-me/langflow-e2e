import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { loadTemplateByName } from "../../../helpers/flows/load-template-by-name";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// All three tests instantiate template flows; track every POST /api/v1/flows
// → 201 id and delete them in afterEach (id-scoped — never name-based or
// delete-all). Test 1 deletes its own flow as the behavior under test
// (deleteFlow tolerates 404 = already gone); tests 2-3 previously leaked up
// to 3 template flows each.
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
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
  }
});

test(
  "select and delete a flow",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@ui-ux"] },
  async ({ page, request }) => {
    trackCreatedFlows(page);

    // Create the flow to delete — loadTemplateByName returns the
    // authoritative POST-201 flow id (the canvas URL id is transient on
    // 1.11), which scopes every step below to THIS flow.
    const flowId = await loadTemplateByName(page, "Basic Prompting");

    await page.goto("/");
    const flowCard = page
      .getByTestId("list-card")
      .filter({ has: page.getByTestId(`flow-name-${flowId}`) });
    await expect(flowCard).toBeVisible({ timeout: 15000 });

    // Open THIS card's dropdown — id-scoped, never .first(): under parallel
    // workers the first card can belong to another worker's flow, and
    // deleting it kills that test mid-flight (#553 class).
    await flowCard.getByTestId("home-dropdown-menu").click();
    await page.getByTestId("btn_delete_dropdown_menu").click();

    // The confirmation modal gates the action and names the consequence.
    await expect(
      page.getByText("This will permanently delete the flow and its message history."),
    ).toBeVisible({ timeout: 10000 });
    await page.getByTestId("btn_delete_delete_confirmation_modal").click();

    // Prove removal in all three layers: toast, grid, backend.
    await expect(
      page.getByText("Selected items deleted successfully"),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`flow-name-${flowId}`)).toHaveCount(0, {
      timeout: 10000,
    });
    const bearer = await getAuthToken(request);
    const res = await request.get(`/api/v1/flows/${flowId}`, {
      headers: { Authorization: bearer },
    });
    expect(res.status(), "deleted flow must be gone from the backend").toBe(404);
  },
);

test(
  "search flows",
  { tag: ["@release", "@mainpage", "@workspace"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    // Two flows with known ids — search assertions are anchored to
    // flow-name-{id} cards, never to template display names (which other
    // workers' flows can duplicate).
    const basicId = await loadTemplateByName(page, "Basic Prompting");
    const memoryId = await loadTemplateByName(page, "Memory Chatbot");

    await page.goto("/");
    await expect(page.getByTestId(`flow-name-${basicId}`)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId(`flow-name-${memoryId}`)).toBeVisible({
      timeout: 15000,
    });

    // Searching filters the grid down to matching names only. The search is
    // debounced: assert the NEGATIVE first (it only passes once the filter
    // actually applied — the non-matching card left the grid), and only
    // then the positive, so it is evaluated against the POST-filter grid.
    // Positive-first would resolve on the first poll, before the debounce,
    // and pass even for a search that matches nothing (#706 FF finding).
    await page.getByPlaceholder("Search flows").fill("Memory Chatbot");
    await expect(page.getByTestId(`flow-name-${basicId}`)).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(page.getByTestId(`flow-name-${memoryId}`)).toBeVisible({
      timeout: 10000,
    });

    // Clearing the search restores the full grid.
    await page.getByPlaceholder("Search flows").clear();
    await expect(page.getByTestId(`flow-name-${basicId}`)).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId(`flow-name-${memoryId}`)).toBeVisible({
      timeout: 10000,
    });
  },
);

test(
  "search components",
  { tag: ["@release", "@components", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    // The old home "components-btn" tab left the product on 1.11 (the
    // pre-#706 test guarded its whole body on it and ran nothing). Saved
    // components now surface in the CANVAS sidebar under the "saved"
    // category — this is the live surface, scouted on 1.11.0.dev41.
    await loadTemplateByName(page, "Basic Prompting");
    await adjustScreenView(page, { numberOfZoomOut: 2 });

    // Save the Chat Input node as a component. The save itself is a
    // POST /api/v1/flows (is_component) — the tracker above captures it,
    // so afterEach also removes the saved component.
    await page.getByText("Chat Input").first().click();
    await page.getByTestId("more-options-modal").click();
    await page.getByTestId("icon-SaveAll").first().click();
    await page.keyboard.press("Escape");

    // Order matters (debounced search, same trap as the flows grid): run
    // the NEGATIVE first — "Prompt" exists as a regular component (renders
    // under "models & agents", scouted live) but was NOT saved, so once the
    // filter settles the saved category must be gone. Only then search the
    // saved name: the saved category reappearing is a 0→1 transition, so
    // the positive assert necessarily observes the POST-filter sidebar.
    const sidebarSearch = page.getByTestId("sidebar-search-input");
    await sidebarSearch.fill("Prompt");
    await expect(page.getByTestId("disclosure-saved")).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(page.getByTestId("disclosure-models & agents")).toBeVisible({
      timeout: 10000,
    });

    // Searching the saved name surfaces the "saved" category again.
    await sidebarSearch.fill("Chat Input");
    await expect(page.getByTestId("disclosure-saved")).toBeVisible({
      timeout: 10000,
    });
  },
);
