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

/**
 * The Chat Input node's `files` value AS THE SERVER HOLDS IT.
 *
 * The run below is `POST /api/v2/workflows`, which executes the PERSISTED flow by
 * `flow_id` — it does not carry the canvas. The upload shows on the node at once
 * and is autosaved on a ~2 s debounce, so clicking run on the strength of the UI
 * starts a run whose Chat Input still has `files: ""`: measured on `1.13.0.dev9`,
 * the value landed ~3 s AFTER the run had already begun, the model answered that
 * it cannot see images, and nothing ever matched the image assertion (#1791 —
 * 5/5 failures on this machine, 2/3 green on the slower CI runner, which is the
 * same race won from the other side).
 */
async function readPersistedFiles(page: Page, flowId: string): Promise<unknown[]> {
  const res = await page.request.get(`/api/v1/flows/${flowId}`);
  if (!res.ok()) return [];
  const body = (await res.json()) as {
    data?: {
      nodes?: Array<{
        id: string;
        data?: { node?: { template?: { files?: { value?: unknown } } } };
      }>;
    };
  };
  const node = (body.data?.nodes ?? []).find((n) => /^ChatInput/.test(n.id));
  const value = node?.data?.node?.template?.files?.value;
  return Array.isArray(value) ? value : [];
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
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // A real build runs below, so gate on provider HEALTH rather than on the mere
    // presence of the env var: a key that exists but is drained blocks the backend
    // past gunicorn's 300s timeout and kills the shard's Langflow worker (#1029).
    // After the .env load, so a key that lives only in .env is visible to the gate
    // on a local run.
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

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

    // Wait for the WRITE the run depends on, not for the UI that precedes it.
    const flowId = (page.url().match(/\/flow\/([0-9a-f-]{36})/) ?? [])[1];
    expect(flowId, "the editor URL must carry the flow id").toBeTruthy();
    await expect
      .poll(async () => readPersistedFiles(page, flowId!), {
        timeout: 30000,
        message:
          "the re-uploaded file must be persisted before the run — /api/v2/workflows executes the SAVED flow, not the canvas",
      })
      .not.toHaveLength(0);

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
