import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
import { unselectNodes } from "../../../helpers/ui/unselect-nodes";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach (repo convention, #490/#681).
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

test(
  "user should not be able to hide connected inputs",
  { tag: ["@release", "@api", "@database"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector("text=Language Model", { timeout: 30000 });

    await page
      .getByTestId("div-generic-node")
      .getByText("Language Model", { exact: true })
      .click();
    await openAdvancedOptions(page);

    // dev46: the field's visibility toggle is `inspector-remove-<field>` (the
    // field is on the node body by default). While its handle is connected the
    // toggle is present but DISABLED — a connected input cannot be hidden — and
    // hovering surfaces the reason.
    const inputValueToggle = page.getByTestId("inspector-remove-input_value");
    await expect(inputValueToggle).toBeVisible();
    await expect(inputValueToggle).toBeDisabled();

    // The disabled button has `pointer-events-none`; its wrapper span is the
    // tooltip trigger, so hover the wrapper to surface the reason.
    await page.getByTestId("inspector-remove-wrapper-input_value").hover();
    await expect(
      page.getByText("Cannot change visibility of connected handles"),
    ).toBeVisible();

    await closeAdvancedOptions(page);

    // Disconnect the input by deleting its edge (Basic Prompting wires 3 edges;
    // removing one leaves 2).
    await page.locator(".react-flow__edge").nth(0).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);

    await page
      .getByTestId("div-generic-node")
      .getByText("Language Model", { exact: true })
      .click();
    await openAdvancedOptions(page);

    // Once disconnected the toggle is enabled and the field can be hidden.
    await expect(inputValueToggle).toBeEnabled();
    await inputValueToggle.click();

    await closeAdvancedOptions(page);

    await unselectNodes(page);

    // Hiding the (now-disconnected) input removes it from the node body.
    await expect(page.getByText("Input", { exact: true })).toBeHidden();
  },
);
