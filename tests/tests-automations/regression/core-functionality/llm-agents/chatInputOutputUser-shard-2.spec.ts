import type { Page } from "@playwright/test";
import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
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
  "user must interact with chat with Input/Output",
  { tag: ["@release", "@components", "@agents"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }

    // Real completions run below, so gate on provider HEALTH, not on the env var
    // alone — a drained key would block the backend past gunicorn's 300s timeout
    // and kill the shard's Langflow worker (#1029). Evaluated after dotenv so a
    // local `.env`-only key is seen.
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await initialGPTsetup(page);

    // Open Playground
    await page.getByRole("button", { name: "Playground", exact: true }).click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    await page.getByTestId("input-chat-playground").click();
    await page.getByTestId("input-chat-playground").fill("Hello, how are you?");

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.getByTestId("stop_building_button").waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.getByTestId("stop_building_button").waitFor({
      state: "hidden",
      timeout: 180000,
    });

    await expect(
      page.locator('[data-testid^="chat-message-User"]').first(),
    ).toHaveText("Hello, how are you?");

    await expect(
      page.locator('[data-testid^="chat-message-AI"]').first(),
    ).not.toBeEmpty();

    // close the playground (fullscreen covers the toolbar, use the close button)
    await page.getByTestId("playground-close-button").click();

    // dev46: expose the advanced sender_name field on each node body via the
    // inspector (replaces the old show<field> toggle).
    await page.getByText("Chat Input", { exact: true }).click();
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-sender_name").click();
    await closeAdvancedOptions(page);

    await page.getByText("Chat Output", { exact: true }).click();
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-sender_name").click();
    await closeAdvancedOptions(page);

    await page
      .getByTestId("popover-anchor-input-sender_name")
      .nth(0)
      .fill("TestSenderNameUser");
    await page
      .getByTestId("popover-anchor-input-sender_name")
      .nth(1)
      .fill("TestSenderNameAI");

    await page.getByRole("button", { name: "Playground", exact: true }).click();

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("input-chat-playground").click();
    await page.getByTestId("input-chat-playground").fill("Are you doing ok?");

    await page.getByTestId("button-send").click();

    await page.getByTestId("stop_building_button").waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.getByTestId("stop_building_button").waitFor({
      state: "hidden",
      timeout: 180000,
    });

    await expect(
      page.locator('[data-testid^="chat-message-TestSenderNameUser"]').first(),
    ).toHaveText("Are you doing ok?");

    await expect(
      page.locator('[data-testid^="chat-message-TestSenderNameAI"]').first(),
    ).not.toBeEmpty();

    await page.getByTestId("playground-close-button").click();
  },
);
