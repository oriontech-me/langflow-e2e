import { expect, Page } from "@playwright/test";
import { adjustScreenView } from "../ui/adjust-screen-view";
import { awaitBootstrapTest } from "../other/await-bootstrap-test";
import { zoomOut } from "../ui/zoom-out";
import { deleteFlow } from "./delete-flow";

export async function setupPlayground(page: Page): Promise<string> {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });

  const flowCreationPromise = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 15000 },
  );

  await page.getByTestId("blank-flow").click();

  const creationResponse = await flowCreationPromise;
  const flowData = await creationResponse.json();
  const flowId = flowData.id as string | undefined;
  if (!flowId || flowId.trim() === "") {
    throw new Error(
      "Flow creation response did not include a valid non-empty id.",
    );
  }

  try {
    // The flow editor sidebar mounts after the POST /api/v1/flows response
    // resolves; wait for sidebar-search-input before interacting (see #278).
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await zoomOut(page, 2);

    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 100 },
      });

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });
  } catch (err) {
    // Best-effort rollback of the created flow — swallow so the original
    // failure (err) is the one that surfaces, not a secondary cleanup error.
    await deleteFlow(page.request, flowId).catch(() => {});
    throw err;
  }

  return flowId;
}
