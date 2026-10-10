import type { Page, Request, Route } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { openFlowSettings } from "../../../helpers/flows/open-flow-settings";
import { saveScheduledDeadlineMs } from "../../../helpers/flows/autosave-interval";
import {
  isComponentUpdate,
  waitForComponentUpdateSettled,
} from "../../../helpers/flows/wait-for-component-update-settled";

// Ids of the flows this file creates, so afterEach deletes exactly those via the
// API (id-scoped, #515).
const createdFlowIds: string[] = [];

// Create a fresh, uniquely-named Basic Prompting flow and return its id.
// The prior approach (Templates → click the shared "Basic Prompting" card) is
// NOT parallel-safe: concurrent workers collide on the flow name/state (a lock
// set by one worker was seen by another) and serialize on the SQLite writer,
// which surfaced as cross-worker contamination + `POST /flows` 500s under the
// parallel `@stable`/impacted jobs (#684). An id-addressed flow is isolated.
async function createIsolatedBasicPrompting(page: Page): Promise<string> {
  const flowId = await createFlowFromStarter(
    page.request,
    "Basic Prompting",
    `flow-lock ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  createdFlowIds.push(flowId);
  return flowId;
}

// Shared entry (#1214): canvas wait, onboarding overlay suppressed before the
// load rather than probed for after it, and a gate on the flow being writable —
// this spec locks and unlocks through the settings menu, so every step mutates.
async function openIsolatedBasicPrompting(page: Page): Promise<string> {
  const flowId = await createIsolatedBasicPrompting(page);
  await openFlowById(page, flowId);
  return flowId;
}

// The persisted flow's `locked` flag (`GET /api/v1/flows/{id}`) — the
// authoritative lock state, as opposed to what the editor currently believes.
async function lockedReader(page: Page, flowId: string): Promise<() => Promise<unknown>> {
  const auth = await getAuthToken(page.request);
  return async () => {
    const res = await page.request.get(`/api/v1/flows/${flowId}`, {
      headers: auth ? { Authorization: auth } : {},
    });
    expect(res.ok(), `GET /api/v1/flows/${flowId} -> ${res.status()}`).toBe(true);
    return (await res.json())?.locked;
  };
}

// Counts the node-update round trips (`POST /api/v1/custom_component/update`)
// the page has open. It must be attached BEFORE the editor loads: the Basic
// Prompting starter issues its updates during the load, and
// `waitForComponentUpdateSettled` cannot see a request that was already open
// when it attached (its documented limit).
function trackComponentUpdates(page: Page): { inFlight(): number } {
  let inFlight = 0;
  page.on("request", (request) => {
    if (isComponentUpdate(request)) inFlight += 1;
  });
  const settle = (request: Request) => {
    if (isComponentUpdate(request)) inFlight = Math.max(0, inFlight - 1);
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return { inFlight: () => inFlight };
}

/**
 * Forces #2075's ordering on one flow: every node-update response
 * (`POST /api/v1/custom_component/update`) is held until the flow's first PATCH
 * — the settings Save — has been committed by the backend, then delivered while
 * that Save's own response is still held. Only the browser's view waits; the
 * backend answers both requests immediately.
 *
 * The record is read by the test's anchors, which is what separates "the defect
 * fired" from "the harness never forced the overlap".
 */
async function forceNodeUpdateDuringSave(page: Page, flowPath: string) {
  const record = {
    heldUpdates: 0,
    deliveredUpdates: 0,
    deliveredMidSave: 0,
    saveHeld: false,
    saveBodyLocked: undefined as unknown,
    saveCommittedLocked: undefined as unknown,
  };
  let releaseUpdates!: () => void;
  const saveCommitted = new Promise<void>((resolve) => {
    releaseUpdates = resolve;
  });

  const isUpdateUrl = (url: URL) =>
    isComponentUpdate({ method: () => "POST", url: () => url.href });
  const isFlowUrl = (url: URL) => url.pathname === flowPath;

  const holdUpdate = async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    record.heldUpdates += 1;
    const response = await route.fetch();
    await saveCommitted;
    await route.fulfill({ response });
    record.deliveredUpdates += 1;
    if (record.saveHeld) record.deliveredMidSave += 1;
  };

  const holdSave = async (route: Route) => {
    if (route.request().method() !== "PATCH" || record.saveHeld) {
      return route.fallback();
    }
    record.saveHeld = true;
    record.saveBodyLocked = route.request().postDataJSON()?.locked;
    const response = await route.fetch();
    record.saveCommittedLocked = (await response.json())?.locked;
    releaseUpdates();
    const deadline = Date.now() + 10000;
    while (record.deliveredUpdates < record.heldUpdates && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Give the editor time to apply the delivered updates (each swaps the
    // store's nodes array) before the Save's own answer arrives.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ response });
  };

  await page.route(isUpdateUrl, holdUpdate);
  await page.route(isFlowUrl, holdSave);
  return {
    record,
    release: async () => {
      await page.unroute(isUpdateUrl, holdUpdate);
      await page.unroute(isFlowUrl, holdSave);
    },
  };
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("/");
  const auth = await getAuthToken(page.request);
  const opts = auth ? { headers: { Authorization: auth } } : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

test.describe("Flow Lock Feature", () => {
  test(
    "should lock and unlock a flow and verify UI changes",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const flowId = await createIsolatedBasicPrompting(page);
      const readLocked = await lockedReader(page, flowId);
      const updates = trackComponentUpdates(page);

      await test.step("open the flow and let its load-time node updates land", async () => {
        await openFlowById(page, flowId);
        // #2075: a node update (`custom_component/update`) that lands while the
        // settings Save is in flight makes the editor drop the committed lock
        // (langflow#14765 — the defect Test 3 pins). The starter fires its
        // updates on load; a user is slower than those round trips, automation
        // has to wait them out (the #1855 barrier convention).
        await expect
          .poll(() => updates.inFlight(), {
            timeout: 30000,
            message: "load-time custom_component/update round trips never finished",
          })
          .toBe(0);
        expect(
          await waitForComponentUpdateSettled(page),
          "node updates were still being issued 15 s after the flow opened",
        ).toBe(true);
      });

      // Verify initially the flow is not locked. dev49 note: `icon-lock` is no
      // longer a reliable lock indicator — the testid is now also used by
      // unrelated input-placeholder icons (present, count ≥ 2, on an UNLOCKED
      // flow), so a canvas-badge check is not deterministic. The authoritative
      // unlocked signal is the persisted flow's `locked` flag and the settings
      // switch state, both asserted below.
      await expect(async () => {
        expect(await readLocked()).toBe(false);
      }).toPass({ timeout: 15000, intervals: [500, 1000] });

      const lockSwitch = page.getByTestId("lock-flow-switch");
      const nameInput = page.getByTestId("input-flow-name");
      const descriptionInput = page.getByTestId("input-flow-description");
      const saveButton = page.getByTestId("save-flow-settings");

      await test.step("lock the flow from Flow Settings and save", async () => {
        await openFlowSettings(page);
        await expect(lockSwitch).toBeVisible({ timeout: 30000 });
        await expect(lockSwitch).toHaveAttribute("data-state", "unchecked");
        await expect(nameInput).toBeEnabled();
        await expect(descriptionInput).toBeEnabled();

        // ONE toggle must stick (#2075). No re-click loop: a switch the form
        // resets after the click is a finding, and a retry would hide it.
        await lockSwitch.click();
        await expect(lockSwitch).toHaveAttribute("data-state", "checked");
        await expect(nameInput).toBeDisabled();
        await expect(descriptionInput).toBeDisabled();

        await expect(saveButton).toBeEnabled({ timeout: 10000 });
        await saveButton.click();
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 15000 });
      });

      // Confirm the lock PERSISTED to the backend before trusting any reopened
      // UI — the save can lag under parallel load, and the reopened modal reads
      // its switch state from the editor's copy of the flow (#684, #2075).
      await expect(async () => {
        expect(await readLocked()).toBe(true);
      }).toPass({ timeout: 15000, intervals: [500, 1000] });

      await test.step("reopen: the lock is still on and the metadata is read-only", async () => {
        await openFlowSettings(page);
        // Generous timeout: the reopened modal can lag under parallel load
        // before reflecting the persisted state.
        await expect(lockSwitch).toHaveAttribute("data-state", "checked", {
          timeout: 15000,
        });
        await expect(nameInput).toBeDisabled();
        await expect(descriptionInput).toBeDisabled();
      });

      await test.step("unlock and save", async () => {
        await lockSwitch.click();
        await expect(lockSwitch).toHaveAttribute("data-state", "unchecked");
        await expect(nameInput).toBeEnabled();
        await expect(descriptionInput).toBeEnabled();

        await expect(saveButton).toBeEnabled({ timeout: 10000 });
        await saveButton.click();
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 10000 });
      });

      // Assert unlock PERSISTED via the authoritative backend state, not the
      // canvas badge: on 1.11 the per-node `icon-lock` badge does NOT clear on
      // unlock without a reload (the frontend re-renders it away only on
      // reload; the backend is already unlocked). The persisted flow's
      // `locked` flag is the true, deterministic unlock signal (#684).
      await expect(async () => {
        expect(await readLocked()).toBe(false);
      }).toPass({ timeout: 15000, intervals: [500, 1000] });
    },
  );

  test(
    "should show correct lock/unlock icon in settings based on state",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await openIsolatedBasicPrompting(page);

      // Open flow settings
      await openFlowSettings(page);
      await page.waitForSelector('[data-testid="lock-flow-switch"]', {
        timeout: 30000,
      });

      // Initially should show unlock icon (flow is unlocked)
      const dialog = page.locator('[role="dialog"]');
      const unlockIcon = dialog.locator('[data-testid="icon-Unlock"]');
      await expect(unlockIcon).toBeVisible();

      // Lock the flow — ONE toggle must stick (#2075).
      const lockSwitch = dialog.getByTestId("lock-flow-switch");
      await lockSwitch.click();
      await expect(lockSwitch).toHaveAttribute("data-state", "checked");

      // Should now show lock icon
      const lockIcon = dialog.locator('[data-testid="icon-Lock"]');
      await expect(lockIcon).toBeVisible({ timeout: 5000 });
      await expect(unlockIcon).toBeHidden({ timeout: 5000 });
    },
  );

  // #2075 / LE-2785 — langflow#14765 made `use-save-flow.ts` adopt a save's PATCH response
  // into the editor only when no node changed while it was in flight. The
  // settings Save's `locked: true` is committed but never adopted when a node
  // update lands mid-save: the reopened modal shows the flow unlocked, and the
  // next canvas edit sends `PATCH {locked: false}`, which the backend accepts.
  // Measured on 1.13.0.dev26: 3/3 with the overlap forced, 0/3 without it; the
  // same forced race on 1.11.4 (before langflow#14765) keeps the lock. Fixed by
  // langflow#15439 (first in 1.13.0.dev28), which adopts the saved settings while
  // keeping the live graph; this test now guards that fix.
  test(
    "should keep a lock saved while a node update lands mid-save",
    { tag: ["@stable", "@regression", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const flowId = await createIsolatedBasicPrompting(page);
      const readLocked = await lockedReader(page, flowId);
      const flowPath = `/api/v1/flows/${flowId}`;

      // Force the ordering the VM daily hit by chance (see the helper above).
      const race = await forceNodeUpdateDuringSave(page, flowPath);

      const lockSwitch = page.getByTestId("lock-flow-switch");
      const saveButton = page.getByTestId("save-flow-settings");

      await test.step("lock the flow and save while a node update is held", async () => {
        await openFlowById(page, flowId);
        await openFlowSettings(page);
        await expect(lockSwitch).toBeVisible({ timeout: 30000 });
        await lockSwitch.click();
        await expect(lockSwitch).toHaveAttribute("data-state", "checked");
        // Anchor: the overlap can only be forced if the load issued a node update.
        expect(
          race.record.heldUpdates,
          "the Basic Prompting load issued no custom_component/update — the harness can no longer force #2075's overlap",
        ).toBeGreaterThan(0);
        await expect(saveButton).toBeEnabled({ timeout: 10000 });
        await saveButton.click();
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 30000 });
      });

      // Anchors: the race really was forced and the backend really holds the lock.
      // Asserted BEFORE the contract, so a red here names a harness that could
      // not force the overlap — not a return of LE-2785.
      expect(race.record.saveBodyLocked, "the settings Save did not send locked: true").toBe(true);
      expect(race.record.saveCommittedLocked, "the backend did not commit locked: true").toBe(true);
      expect(
        race.record.deliveredMidSave,
        "no node update was delivered while the Save was in flight",
      ).toBeGreaterThan(0);
      await expect.poll(readLocked, { timeout: 15000 }).toBe(true);
      await race.release();
      const node = await page.locator(".react-flow__node").first().boundingBox();
      expect(node, "no canvas node to drag").not.toBeNull();

      // The contract LE-2785 broke (langflow#14765) and langflow#15439 restored.
      await test.step("reopen: the editor shows the lock it just saved", async () => {
        await openFlowSettings(page);
        await expect.soft(lockSwitch).toHaveAttribute("data-state", "checked", {
          timeout: 5000,
        });
        await page.keyboard.press("Escape");
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("a canvas edit does not unlock the flow", async () => {
        // An absence is asserted on the REQUEST, not on a state read: the defect
        // is a PATCH carrying locked: false, issued one autosave debounce after
        // the edit.
        const unlockWrite = page
          .waitForRequest(
            (request) =>
              request.method() === "PATCH" &&
              new URL(request.url()).pathname === flowPath &&
              request.postDataJSON()?.locked === false,
            { timeout: saveScheduledDeadlineMs() },
          )
          .then(
            (request) => request.url(),
            () => null,
          );
        const x = node!.x + node!.width / 2;
        await page.mouse.move(x, node!.y + 12);
        await page.mouse.down();
        await page.mouse.move(x + 60, node!.y + 72, { steps: 8 });
        await page.mouse.up();
        expect(await unlockWrite, "a canvas edit sent PATCH {locked: false}").toBeNull();
        expect(await readLocked()).toBe(true);
      });
    },
  );
});
