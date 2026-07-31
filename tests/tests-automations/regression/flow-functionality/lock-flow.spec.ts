import type { Page } from "@playwright/test";
import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import {
  lockFlow,
  unlockFlow,
  expectLockState,
} from "../../../helpers/flows/lock-flow";
import { unselectNodes } from "../../../helpers/ui/unselect-nodes";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";

// Id of the flow this file creates, so afterEach deletes exactly it (#515).
const createdFlowIds: string[] = [];

// Entry is the shared helper (#1214). The local copy this replaces addressed the
// flow by id for the same reason — `list-card.first()` opens whichever card is on
// top of the shared home grid, i.e. another worker's flow (#684) — but carried an
// unexplained 100 s canvas deadline, an arbitrary `waitForTimeout(500)`, and an
// onboarding dismiss that is measurably a no-op at entry (upstream arms the
// tooltip on a 10 s idle timer, so the probe looked ~8 s too early). The helper
// suppresses the overlay outright and gates on the flow being writable, which
// this spec needs: every step below mutates the flow through the settings menu.

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
  { tag: ["@stable", "@release", "@components", "@workspace"] },
  async ({ page }) => {
    // Left on env-var presence (#1029 audit): this test never drives a
    // completion. It creates a Basic Prompting flow from the starter, locks it,
    // reopens, asserts the lock persisted, unlocks and deletes edges — the model
    // is never run, so a dead key cannot produce the hung request that wedges a
    // shard, and consulting provider health would only add a false skip.
    //
    // The gate looks vestigial: nothing here reads OPENAI_API_KEY. Removing it
    // would make the test run where it currently skips, which is a behaviour
    // change this sweep deliberately does not make — it belongs to whoever
    // revisits this spec.
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

    // Prove the lock actually PERSISTED across the reopen: the Flow Settings
    // lock switch must read `checked`. The previous check waited for the
    // per-node `icon-lock` badge, but that affordance renders on every flow
    // regardless of lock state, so it passed even when the flow was never
    // locked — a false assertion caught by force-fail (#909).
    await expectLockState(page, "checked");

    await unlockFlow(page);

    // Reopen again — now unlocked; editing must work below.
    await openFlowById(page, flowId);

    await tryDeleteEdge(page);
    await page.waitForTimeout(500);

    // Delete edges one by one (when unlocked, should work). Assert via the
    // polling `toHaveCount` (retries until the canvas settles) instead of a
    // fixed `waitForTimeout` + `count()` + `toBe` — the latter races the
    // ReactFlow re-render under the daily's parallel load and produced the
    // `toBe` Object.is flake (#909).
    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2, {
      timeout: 10000,
    });

    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 10000,
    });

    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await expect(page.locator(".react-flow__edge")).toHaveCount(0, {
      timeout: 10000,
    });

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
    await expect(page.locator(".react-flow__edge")).toHaveCount(3, {
      timeout: 10000,
    });
  },
);

async function tryConnectNodes(page: Page) {
  await lockFlow(page);

  const numberOfTries = 5;
  const edges = page.locator(".react-flow__edge");

  // While locked, clicking source/target handles must NOT wire an edge. The
  // clicks are expected to be inert (the locked canvas ignores them); wrap them
  // so an inert/timed-out click doesn't abort the test. The assertion below is
  // UNCONDITIONAL (not catch-only) so the "locked blocks connect" check runs
  // deterministically whether or not the click throws (#909).
  for (let i = 0; i < numberOfTries; i++) {
    await page
      .getByTestId("handle-prompt-shownode-prompt-right")
      .click({ timeout: 500 })
      .catch(() => {});
    await page
      .getByTestId("handle-languagemodelcomponent-shownode-system message-left")
      .click({ timeout: 500 })
      .catch(() => {});
  }

  // No edge may have been created while locked.
  await expect(edges).toHaveCount(0, { timeout: 10000 });
  await unlockFlow(page);
}

async function tryDeleteEdge(page: Page) {
  await lockFlow(page);

  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(3, { timeout: 10000 });
  const numberOfTries = 5;

  // When locked, clicking edges and pressing delete should not remove them.
  for (let i = 0; i < numberOfTries; i++) {
    await page.locator(".react-flow__edge").nth(0).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    await expect(edges).toHaveCount(3, { timeout: 10000 });
  }
  await unlockFlow(page);
}
