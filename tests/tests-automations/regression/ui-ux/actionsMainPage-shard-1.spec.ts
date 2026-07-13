import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { openNewFlowTemplatesModal } from "../../../helpers/flows/open-new-flow-templates-modal";
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

test("search flows", { tag: ["@release", "@mainpage"] }, async ({ page }) => {
  trackCreatedFlows(page);
  await awaitBootstrapTest(page);

  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();

  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 100000,
  });

  await page.getByTestId("icon-ChevronLeft").first().click();

  await openNewFlowTemplatesModal(page);
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Memory Chatbot" }).click();

  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 100000,
  });

  await page.getByTestId("icon-ChevronLeft").first().click();
  await openNewFlowTemplatesModal(page);
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Document Q&A" }).click();

  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 100000,
  });

  await page.getByTestId("icon-ChevronLeft").first().click();
  await page.getByPlaceholder("Search flows").fill("Memory Chatbot");
  await page.getByText("Memory Chatbot", { exact: true }).isVisible();
  await page.getByText("Document Q&A", { exact: true }).isHidden();
  await page.getByText("Basic Prompting", { exact: true }).isHidden();
});

test(
  "search components",
  { tag: ["@release", "@mainpage"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    if (await page.getByTestId("components-btn").isVisible()) {
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await adjustScreenView(page, { numberOfZoomOut: 2 });

      await page.getByText("Chat Input").first().click();
      await page.waitForSelector('[data-testid="more-options-modal"]', {
        timeout: 1000,
      });
      await page.getByTestId("more-options-modal").click();

      await page.getByTestId("icon-SaveAll").first().click();
      await page.keyboard.press("Escape");
      await page
        .getByText("Prompt", {
          exact: true,
        })
        .first()
        .click();
      await page.getByTestId("more-options-modal").click();

      await page.getByTestId("icon-SaveAll").first().click();
      await page.keyboard.press("Escape");

      await page
        .getByText("OpenAI", {
          exact: true,
        })
        .first()
        .click();
      await page.getByTestId("more-options-modal").click();

      await page.getByTestId("icon-SaveAll").first().click();
      await page.keyboard.press("Escape");

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 100000,
      });

      await page.getByTestId("icon-ChevronLeft").first().click();

      const exitButton = await page.getByText("Exit", { exact: true }).count();

      if (exitButton > 0) {
        await page.getByText("Exit", { exact: true }).click();
      }

      await page.getByTestId("components-btn").click();
      await page.getByPlaceholder("Search components").fill("Chat Input");
      await page.getByText("Chat Input", { exact: true }).isVisible();
      await page.getByText("Prompt", { exact: true }).isHidden();
      await page.getByText("OpenAI", { exact: true }).isHidden();
    }
  },
);
