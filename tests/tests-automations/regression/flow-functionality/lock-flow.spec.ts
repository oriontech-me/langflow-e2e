import type { Page } from "@playwright/test";
import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { lockFlow, unlockFlow } from "../../../helpers/flows/lock-flow";
import { unselectNodes } from "../../../helpers/ui/unselect-nodes";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { dismissOnboardingIfPresent } from "../../../helpers/ui/dismiss-onboarding";

// Id of the flow this file creates, so afterEach deletes exactly it (#515).
const createdFlowIds: string[] = [];

// Open a flow (freshly created, or a reopen of the same one) addressed by id and
// wait for the canvas. Reopening by id — not `list-card.first()` — is what makes
// the persistence checks parallel-safe: `.first()` would open whichever card is
// on top of the shared home grid, i.e. another worker's flow (#684).
async function openFlowById(page: Page, flowId: string): Promise<void> {
  await page.goto(`/flow/${flowId}`);
  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 100000,
    state: "visible",
  });
  await page.waitForTimeout(500);
  // The onboarding popup overlays the canvas on entry and intercepts the
  // settings clicks lockFlow/unlockFlow issue — dismiss it first (#684).
  await dismissOnboardingIfPresent(page);
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  await page.goto("/");
  const auth = await getAuthToken(page.request);
  const opts = auth ? { headers: { Authorization: auth } } : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

test(
  "user must be able to lock a flow and it must be saved",
  { tag: ["@release", "@components", "@workspace"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // Isolated, uniquely-named flow addressed by id — parallel-safe (#684).
    const flowId = await createFlowFromStarter(
      page.request,
      "Basic Prompting",
      `lock-flow ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    createdFlowIds.push(flowId);
    await openFlowById(page, flowId);

    await lockFlow(page);

    // Reopen the SAME flow by id to prove the lock persisted across a reload.
    await openFlowById(page, flowId);

    //ensure the UI is updated — lock persisted across the reopen. On 1.11 the
    // locked-state indicator is the per-node `icon-lock` (lowercase) badge; the
    // old header `icon-Lock` (capital) no longer renders (#684).
    await page.waitForSelector('[data-testid="icon-lock"]', {
      timeout: 3000,
    });

    await unlockFlow(page);

    // Reopen again — now unlocked; editing must work below.
    await openFlowById(page, flowId);

    await tryDeleteEdge(page);
    await page.waitForTimeout(500);

    // Delete edges one by one (when unlocked, should work)
    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    let numberOfEdges = await page.locator(".react-flow__edge").count();
    expect(numberOfEdges).toBe(2);

    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    numberOfEdges = await page.locator(".react-flow__edge").count();
    expect(numberOfEdges).toBe(1);

    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    numberOfEdges = await page.locator(".react-flow__edge").count();
    expect(numberOfEdges).toBe(0);

    await tryConnectNodes(page);

    await unselectNodes(page);

    await page.getByText("Chat Input", { exact: true }).click();

    await adjustScreenView(page);

    await page.getByTestId("handle-prompt-shownode-prompt-right").click();
    await page
      .getByTestId("handle-languagemodelcomponent-shownode-system message-left")
      .click();

    await page
      .getByTestId("handle-chatinput-shownode-chat message-right")
      .click();
    await page
      .getByTestId("handle-languagemodelcomponent-shownode-input-left")
      .click();

    await page
      .getByTestId(
        "handle-languagemodelcomponent-shownode-model response-right",
      )
      .click();
    await page.getByTestId("handle-chatoutput-shownode-inputs-left").click();
    await page.waitForTimeout(300);
    numberOfEdges = await page.locator(".react-flow__edge").count();

    expect(numberOfEdges).toBe(3);
  },
);

async function tryConnectNodes(page: Page) {
  await lockFlow(page);

  const numberOfTries = 5;
  let numberOfEdges = await page.locator(".react-flow__edge").count();

  for (let i = 0; i < numberOfTries; i++) {
    try {
      await page.getByTestId("handle-prompt-shownode-prompt-right").click({
        timeout: 500,
      });
    } catch (_e) {
      numberOfEdges = await page.locator(".react-flow__edge").count();
      expect(numberOfEdges).toBe(0);
    }

    try {
      await page
        .getByTestId(
          "handle-languagemodelcomponent-shownode-system message-left",
        )
        .click({
          timeout: 500,
        });
    } catch (_e) {
      numberOfEdges = await page.locator(".react-flow__edge").count();
      expect(numberOfEdges).toBe(0);
    }
  }
  await unlockFlow(page);
}

async function tryDeleteEdge(page: Page) {
  await lockFlow(page);

  let numberOfEdges = await page.locator(".react-flow__edge").count();
  expect(numberOfEdges).toBe(3);
  const numberOfTries = 5;

  // When locked, clicking edges and pressing delete should not remove them
  for (let i = 0; i < numberOfTries; i++) {
    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    numberOfEdges = await page.locator(".react-flow__edge").count();
    expect(numberOfEdges).toBe(3);
  }
  await unlockFlow(page);
}
