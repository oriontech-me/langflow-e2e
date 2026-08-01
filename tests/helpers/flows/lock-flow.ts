import { expect, type Page } from "@playwright/test";
import { openFlowSettings } from "./open-flow-settings";

// Open Flow Settings, toggle the lock switch to the target state, and save.
// The switch can take well over a second to settle into its new `data-state`
// on a loaded canvas — the prior fixed `waitForSelector(..., { timeout: 1000 })`
// flaked (~1/3 runs, #684). `expect(...).toHaveAttribute` auto-retries up to the
// timeout, removing the race without a magic sleep.
async function setLockState(
  page: Page,
  state: "checked" | "unchecked",
): Promise<void> {
  await openFlowSettings(page);
  const lockSwitch = page.getByTestId("lock-flow-switch");
  await expect(lockSwitch).toBeVisible({ timeout: 30000 });

  // Converge to the target state. A single click can be dropped when the modal
  // is still binding under parallel load (the switch stayed on its old state,
  // #684), so retry the whole toggle: click only when not already on target,
  // then confirm. The `if` guard prevents a late-registering click from flipping
  // an already-correct switch back.
  await expect(async () => {
    if ((await lockSwitch.getAttribute("data-state")) !== state) {
      await lockSwitch.click();
    }
    await expect(lockSwitch).toHaveAttribute("data-state", state, {
      timeout: 2000,
    });
  }).toPass({ timeout: 15000, intervals: [300, 700, 1500] });

  // Save only when there is a pending change. If the switch already matched the
  // persisted state (e.g. the reopened flow loaded already in the target state),
  // the Save button stays disabled — there is nothing to persist, so just close
  // the modal instead of waiting on a button that will never enable (#684).
  const save = page.getByTestId("save-flow-settings");
  if (await save.isEnabled({ timeout: 5000 }).catch(() => false)) {
    await save.click();
    await expect(save).toBeHidden({ timeout: 10000 });
  } else {
    await page.keyboard.press("Escape");
    await expect(save).toBeHidden({ timeout: 10000 });
  }
}

export async function lockFlow(page: Page): Promise<void> {
  await setLockState(page, "checked");
}

export async function unlockFlow(page: Page): Promise<void> {
  await setLockState(page, "unchecked");
}

// Assert the flow's persisted lock state by reading the Flow Settings lock
// switch — the authoritative, has-teeth indicator. The per-node `icon-lock`
// affordance is rendered regardless of lock state, so it cannot prove that a
// lock persisted across a reopen (#909). Opens the settings modal, asserts the
// switch `data-state`, then closes without saving (read-only check).
export async function expectLockState(
  page: Page,
  state: "checked" | "unchecked",
): Promise<void> {
  await openFlowSettings(page);
  const lockSwitch = page.getByTestId("lock-flow-switch");
  await expect(lockSwitch).toBeVisible({ timeout: 30000 });
  await expect(lockSwitch).toHaveAttribute("data-state", state, {
    timeout: 15000,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("save-flow-settings")).toBeHidden({
    timeout: 10000,
  });
}
