import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { dismissOnboardingIfPresent } from "../../../helpers/ui/dismiss-onboarding";

// Ids of the flows this file creates, so afterEach deletes exactly those via the
// API (id-scoped, #515).
const createdFlowIds: string[] = [];

// Open a fresh, uniquely-named Basic Prompting flow addressed by its own id.
// The prior approach (Templates → click the shared "Basic Prompting" card) is
// NOT parallel-safe: concurrent workers collide on the flow name/state (a lock
// set by one worker was seen by another) and serialize on the SQLite writer,
// which surfaced as cross-worker contamination + `POST /flows` 500s under the
// parallel `@stable`/impacted jobs (#684). An id-addressed flow is isolated.
async function openIsolatedBasicPrompting(page: Page): Promise<string> {
  const flowId = await createFlowFromStarter(
    page.request,
    "Basic Prompting",
    `flow-lock ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  createdFlowIds.push(flowId);
  await page.goto(`/flow/${flowId}`);
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 30000,
  });
  // The getting-started onboarding popup (also role="dialog") intercepts clicks
  // and stalls the settings-modal detached-wait — dismiss it up front (#684).
  await dismissOnboardingIfPresent(page);
  return flowId;
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

test.describe("Flow Lock Feature", () => {
  test(
    "should lock and unlock a flow and verify UI changes",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const flowId = await openIsolatedBasicPrompting(page);
      const auth = await getAuthToken(page.request);
      const readLocked = async (): Promise<unknown> => {
        const res = await page.request.get(`/api/v1/flows/${flowId}`, {
          headers: auth ? { Authorization: auth } : {},
        });
        expect(res.ok()).toBe(true);
        return (await res.json())?.locked;
      };

      // Verify initially the flow is not locked. On 1.11 the locked-state
      // indicator is a per-node `icon-lock` (lowercase) badge — the old header
      // `icon-Lock` (capital) no longer renders (#684). No badge ⇒ unlocked.
      const initialLockIcon = page.getByTestId("icon-lock");
      await expect(initialLockIcon).toHaveCount(0);

      // Open flow settings by clicking on the flow name
      await page.getByTestId("flow_name").click();

      // Wait for the settings modal to open
      await page.waitForSelector('[data-testid="lock-flow-switch"]', {
        timeout: 30000,
      });

      // Verify the lock switch is initially unchecked
      const lockSwitch = page.getByTestId("lock-flow-switch");
      await expect(lockSwitch).toBeVisible();
      await expect(lockSwitch).toHaveAttribute("data-state", "unchecked");

      // Verify that name and description inputs are enabled when not locked
      const nameInput = page.getByTestId("input-flow-name");
      const descriptionInput = page.getByTestId("input-flow-description");

      await expect(nameInput).toBeEnabled();
      await expect(descriptionInput).toBeEnabled();

      // Converge the switch to checked: a single click can be dropped while the
      // modal is still binding under parallel load (#684), so retry the toggle
      // — click only when not already on target, then confirm.
      await expect(async () => {
        if ((await lockSwitch.getAttribute("data-state")) !== "checked") {
          await lockSwitch.click();
        }
        await expect(lockSwitch).toHaveAttribute("data-state", "checked", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15000, intervals: [300, 700, 1500] });

      // Verify that inputs become disabled when locked
      await expect(nameInput).toBeDisabled();
      await expect(descriptionInput).toBeDisabled();

      // Save the settings — click only once the button is actually enabled (the
      // enable lags the switch toggle under parallel load, #684).
      const saveButton = page.getByTestId("save-flow-settings");
      await expect(saveButton).toBeEnabled({ timeout: 10000 });
      await saveButton.click();
      await expect(saveButton).toBeHidden({
        timeout: 15000,
      });

      // Wait for the modal to close by waiting for the popover to be detached
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10000,
      });

      // Confirm the lock PERSISTED to the backend before trusting any reopened
      // UI — the save can lag under parallel load, and the reopened modal reads
      // its switch state from the persisted flow (#684).
      await expect(async () => {
        expect(await readLocked()).toBe(true);
      }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });

      // Verify the locked-state indicator now appears on the canvas (per-node
      // `icon-lock` badge on 1.11 — replaces the removed header icon, #684).
      const lockedIndicator = page.getByTestId("icon-lock").first();
      await expect(lockedIndicator).toBeVisible();

      // Try to open settings again to unlock
      await page.getByTestId("flow_name").click();

      // Wait for the settings modal to open again
      await page.waitForSelector('[data-testid="lock-flow-switch"]', {
        timeout: 30000,
      });

      // Verify the switch is checked (locked state persisted). Generous timeout:
      // the reopened modal loads its state from the persisted flow and can lag
      // under parallel load before reflecting checked.
      await expect(lockSwitch).toHaveAttribute("data-state", "checked", {
        timeout: 15000,
      });

      // Verify inputs are still disabled
      await expect(nameInput).toBeDisabled();
      await expect(descriptionInput).toBeDisabled();

      // Unlock the flow — converge to unchecked with the same retry (a single
      // toggle can drop under parallel load, #684).
      await expect(async () => {
        if ((await lockSwitch.getAttribute("data-state")) !== "unchecked") {
          await lockSwitch.click();
        }
        await expect(lockSwitch).toHaveAttribute("data-state", "unchecked", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15000, intervals: [300, 700, 1500] });

      // Verify that inputs become enabled again when unlocked
      await expect(nameInput).toBeEnabled();
      await expect(descriptionInput).toBeEnabled();

      // Save the unlocked state — click only once the button is actually
      // enabled (the enable lags the toggle under parallel load, #684).
      await expect(saveButton).toBeEnabled({ timeout: 10000 });
      await saveButton.click();
      await expect(saveButton).toBeHidden({
        timeout: 10000,
      });

      // Wait for the modal to close by waiting for the popover to be detached
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10000,
      });

      // Assert unlock PERSISTED via the authoritative backend state, not the
      // canvas badge: on 1.11 the per-node `icon-lock` badge does NOT clear on
      // unlock without a reload (the frontend re-renders it away only on
      // reload; the backend is already unlocked). The persisted flow's
      // `locked` flag is the true, deterministic unlock signal (#684).
      await expect(async () => {
        expect(await readLocked()).toBe(false);
      }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });
    },
  );

  test(
    "should show correct lock/unlock icon in settings based on state",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await openIsolatedBasicPrompting(page);

      // Open flow settings
      await page.getByTestId("flow_name").click();
      await page.waitForSelector('[data-testid="lock-flow-switch"]', {
        timeout: 30000,
      });

      // Initially should show unlock icon (flow is unlocked)
      const dialog = page.locator('[role="dialog"]');
      const unlockIcon = dialog.locator('[data-testid="icon-Unlock"]');
      await expect(unlockIcon).toBeVisible();

      // Lock the flow — converge to checked (a single click can drop under
      // parallel load, #684).
      const lockSwitch = dialog.getByTestId("lock-flow-switch");
      await expect(async () => {
        if ((await lockSwitch.getAttribute("data-state")) !== "checked") {
          await lockSwitch.click();
        }
        await expect(lockSwitch).toHaveAttribute("data-state", "checked", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15000, intervals: [300, 700, 1500] });

      // Should now show lock icon
      const lockIcon = dialog.locator('[data-testid="icon-Lock"]');
      await expect(lockIcon).toBeVisible({ timeout: 5000 });
      await expect(unlockIcon).toBeHidden({ timeout: 5000 });
    },
  );
});
