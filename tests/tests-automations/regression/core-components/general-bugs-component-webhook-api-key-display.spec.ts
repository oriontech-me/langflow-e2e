import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { loginLangflow } from "../../../helpers/auth/login-langflow";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
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
  "user must be able to see api key in webhook component when auto login is disabled",
  { tag: ["@release"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await page.route("**/api/v1/auto_login", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { auto_login: false },
        }),
      });
    });

    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          type: "full",
          webhook_auth_enable: true,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await loginLangflow(page);

    await awaitBootstrapTest(page, { skipGoto: true });

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-search-input").click();

    await page.getByTestId("sidebar-search-input").fill("webhook");

    await page.waitForSelector('[data-testid="input_outputWebhook"]', {
      timeout: 3000,
    });

    await page
      .getByTestId("input_outputWebhook")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-webhook").click();
      });

    await adjustScreenView(page);

    await page.getByTestId("title-Webhook").click();

    // dev46: the generated cURL command is an advanced field — add it to the
    // node body via the inspector, then open its text-area modal from the body.
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-curl").click();
    await closeAdvancedOptions(page);

    await page.getByTestId("button_open_text_area_modal_str_curl").click();

    const curl = await page.getByTestId("text-area-modal").inputValue();

    expect(curl).toContain("x-api-key");

    await page.getByText("Close", { exact: true }).last().click();
  },
);

test(
  "user must be able to not see api key in webhook component when auto login is enabled",
  { tag: ["@release"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          type: "full",
          webhook_auth_enable: false,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-search-input").click();

    await page.getByTestId("sidebar-search-input").fill("webhook");

    await page.waitForSelector('[data-testid="input_outputWebhook"]', {
      timeout: 3000,
    });

    await page
      .getByTestId("input_outputWebhook")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-webhook").click();
      });

    await adjustScreenView(page);

    await page.getByTestId("title-Webhook").click();

    // dev46: the generated cURL command is an advanced field — add it to the
    // node body via the inspector, then open its text-area modal from the body.
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-curl").click();
    await closeAdvancedOptions(page);

    await page.getByTestId("button_open_text_area_modal_str_curl").click();

    const curl = await page.getByTestId("text-area-modal").inputValue();

    expect(curl).not.toContain("x-api-key");

    await page.getByText("Close", { exact: true }).last().click();
  },
);
