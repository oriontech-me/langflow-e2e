import { expect, type Page } from "@playwright/test";

// Open Flow Settings, toggle the lock switch to the target state, and save.
// The switch can take well over a second to settle into its new `data-state`
// on a loaded canvas — the prior fixed `waitForSelector(..., { timeout: 1000 })`
// flaked (~1/3 runs, #684). `expect(...).toHaveAttribute` auto-retries up to the
// timeout, removing the race without a magic sleep.
async function setLockState(
  page: Page,
  state: "checked" | "unchecked",
): Promise<void> {
  await page.getByTestId("flow_name").click();
  const lockSwitch = page.getByTestId("lock-flow-switch");
  await expect(lockSwitch).toBeVisible({ timeout: 30000 });
  await lockSwitch.click();
  await expect(lockSwitch).toHaveAttribute("data-state", state, {
    timeout: 10000,
  });

  const save = page.getByTestId("save-flow-settings");
  await expect(save).toBeEnabled({ timeout: 5000 });
  await save.click();
  await expect(save).toBeHidden({ timeout: 10000 });
}

export async function lockFlow(page: Page): Promise<void> {
  await setLockState(page, "checked");
}

export async function unlockFlow(page: Page): Promise<void> {
  await setLockState(page, "unchecked");
}
