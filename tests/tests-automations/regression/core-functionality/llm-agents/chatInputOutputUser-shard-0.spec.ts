import type { Page } from "@playwright/test";
import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

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
  "user must be able to send an image on chat",
  { tag: ["@release", "@workspace", "@components"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }

    // Real completions run below, so gate on provider HEALTH, not on the env var
    // alone — a drained key would block the backend past gunicorn's 300s timeout
    // and kill the shard's Langflow worker (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 100000,
    });

    await initialGPTsetup(page);

    await page.waitForSelector("text=Chat Input", { timeout: 30000 });

    await page.getByText("Chat Input", { exact: true }).click();
    await openAdvancedOptions(page);
    await closeAdvancedOptions(page);
    await page.getByRole("button", { name: "Playground", exact: true }).click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // Upload image using the hidden file input
    const filePath = resolveAssetPath("chain.png");
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(filePath);

    // Wait for file preview to appear (shows loading then the image)
    await page.waitForSelector('img[alt="chain.png"]', { timeout: 30000 });

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    // Verify the image is visible in the chat messages after sending
    // Note: Server renames file with timestamp prefix (e.g., "2026-02-03_13-55-02_chain.png")
    await expect(page.locator('img[alt$="chain.png"]')).toBeVisible();
  },
);
