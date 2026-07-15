import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { dismissOnboardingIfPresent } from "../../../helpers/ui/dismiss-onboarding";

// Ids of the flows created by loading the "Basic Prompting" template, captured
// from the POST /api/v1/flows 201 so afterEach deletes exactly those via the API
// (id-scoped, #515). Without this the suite leaked one Basic Prompting flow per
// run — the template load creates a real server-side flow with no teardown.
const createdFlowIds: string[] = [];

test.beforeEach(async ({ page }) => {
  page.on("response", (resp) => {
    if (
      resp.request().method() === "POST" &&
      /\/api\/v1\/flows\/?$/.test(resp.url()) &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
});

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
      await awaitBootstrapTest(page);

      // Navigate to templates and select a flow to work with
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 5000,
      });

      // Dismiss the getting-started onboarding popup — its overlay (also
      // role="dialog") intercepts clicks and blocks the settings-modal
      // detached-wait below (#684).
      await dismissOnboardingIfPresent(page);

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

      await lockSwitch.click();
      await page.waitForTimeout(1000);

      const stateAfterClick = await lockSwitch.getAttribute("data-state");
      if (stateAfterClick !== "checked") {
        await lockSwitch.click();
        await page.waitForTimeout(500);
      }
      await expect(lockSwitch).toHaveAttribute("data-state", "checked");

      // Verify that inputs become disabled when locked
      await expect(nameInput).toBeDisabled();
      await expect(descriptionInput).toBeDisabled();

      // Save the settings by clicking the save button
      const saveButton = page.getByTestId("save-flow-settings");

      if (await saveButton.isEnabled({ timeout: 3000 })) {
        await saveButton.click();
      }
      await expect(saveButton).toBeHidden({
        timeout: 5000 * 3,
      });

      // Wait for the modal to close by waiting for the popover to be detached
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10000,
      });

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

      // Verify the switch is checked (locked state persisted)
      await expect(lockSwitch).toHaveAttribute("data-state", "checked");

      // Verify inputs are still disabled
      await expect(nameInput).toBeDisabled();
      await expect(descriptionInput).toBeDisabled();

      // Unlock the flow
      await lockSwitch.focus();
      await lockSwitch.press("Space");

      // Verify the switch is now unchecked
      await expect(lockSwitch).toHaveAttribute("data-state", "unchecked");

      // Verify that inputs become enabled again when unlocked
      await expect(nameInput).toBeEnabled();
      await expect(descriptionInput).toBeEnabled();

      // Save the unlocked state by clicking the save button
      await page.getByTestId("save-flow-settings").isEnabled({ timeout: 3000 });
      await page.getByTestId("save-flow-settings").click();

      await expect(saveButton).toBeHidden({
        timeout: 5000,
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
      const flowId = page.url().split("/flow/")[1]?.split(/[/?#]/)[0];
      const auth = await getAuthToken(page.request);
      await expect(async () => {
        const res = await page.request.get(`/api/v1/flows/${flowId}`, {
          headers: auth ? { Authorization: auth } : {},
        });
        expect(res.ok()).toBe(true);
        expect((await res.json())?.locked).toBe(false);
      }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });
    },
  );

  test(
    "should show correct lock/unlock icon in settings based on state",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      // Navigate to templates and select a flow
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 5000,
      });

      // Dismiss the onboarding popup so the settings dialog is the only
      // role="dialog" the scoped locators below resolve to (#684).
      await dismissOnboardingIfPresent(page);

      // Open flow settings
      await page.getByTestId("flow_name").click();
      await page.waitForSelector('[data-testid="lock-flow-switch"]', {
        timeout: 30000,
      });

      // Initially should show unlock icon (flow is unlocked)
      const dialog = page.locator('[role="dialog"]');
      const unlockIcon = dialog.locator('[data-testid="icon-Unlock"]');
      await expect(unlockIcon).toBeVisible();

      // Lock the flow
      const lockSwitch = dialog.getByTestId("lock-flow-switch");
      await lockSwitch.click();

      // Should now show lock icon
      const lockIcon = dialog.locator('[data-testid="icon-Lock"]');
      await expect(lockIcon).toBeVisible({ timeout: 5000 });
      await expect(unlockIcon).toBeHidden({ timeout: 5000 });
    },
  );
});
