import type { Page } from "@playwright/test";
import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { uploadFile } from "../../../helpers/filesystem/upload-file";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

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
  "user must be able to send an image on chat using advanced tool on ChatInputComponent",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    // A real build runs below, so gate on provider HEALTH rather than on
    // the mere presence of the env var: a key that exists but is drained blocks
    // the backend past gunicorn's 300s timeout and kills the shard's Langflow
    // worker (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await initialGPTsetup(page);

    await page.waitForSelector("text=Chat Input", { timeout: 30000 });

    await page.getByText("Chat Input", { exact: true }).click();
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-files").click();
    await closeAdvancedOptions(page);
    const userQuestion = "What is this image?";
    await page.getByTestId("textarea_str_input_value").fill(userQuestion);

    await uploadFile(page, "chain.png");

    const uploadButton = page.getByTestId("button_upload_file");

    await uploadButton.hover();
    await expect(uploadButton.getByTestId("icon-X")).toHaveCSS("opacity", "1");
    await uploadButton.click();
    await expect(page.getByText("chain.png")).not.toBeVisible();

    await uploadFile(page, "chain.png");

    await page.getByTestId("button_run_chat output").click();

    await page.getByRole("button", { name: "Playground", exact: true }).click();

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    // await page.waitForSelector("text=chain.png", { timeout: 30000 });

    // expect(await page.getByAltText("generated image").isVisible()).toBeTruthy();

    await expect(page.locator('img[alt$="chain.png"]')).toBeVisible({
      timeout: 100000,
    });

    expect(
      await page.getByTestId(`chat-message-User-${userQuestion}`).isVisible(),
    ).toBeTruthy();
  },
);
