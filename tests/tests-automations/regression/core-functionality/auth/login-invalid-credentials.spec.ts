import { expect, test } from "../../../../fixtures/fixtures";

test(
  "login with invalid credentials must show error and stay on login page",
  { tag: ["@release", "@api", "@regression"] },
  async ({ page }) => {
    // Mock auto_login to force login screen
    await page.route("**/api/v1/auto_login", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { auto_login: false },
        }),
      });
    });

    await page.addInitScript(() => {
      window.process = window.process || {};
      const newEnv = { ...window.process.env, LANGFLOW_AUTO_LOGIN: "false" };
      Object.defineProperty(window.process, "env", {
        value: newEnv,
        writable: true,
        configurable: true,
      });
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.goto("/");

    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // Fill with invalid credentials
    await page.getByPlaceholder("Username").fill("wronguser");
    await page.getByPlaceholder("Password").fill("wrongpassword");

    await page.evaluate(() => {
      sessionStorage.removeItem("testMockAutoLogin");
    });

    await page.getByRole("button", { name: "Sign In" }).click();

    // Error alert must appear — title is "Error signing in"
    await page.waitForSelector("text=Error signing in", { timeout: 10000 });
    await expect(page.getByText("Error signing in")).toBeVisible({
      timeout: 5000,
    });

    // Must remain on login page (no redirect to main)
    const isOnMainPage = await page
      .getByTestId("mainpage_title")
      .isVisible()
      .catch(() => false);
    expect(isOnMainPage).toBeFalsy();

    // Login form must still be visible for retry
    await expect(page.getByPlaceholder("Username")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByPlaceholder("Password")).toBeVisible({
      timeout: 5000,
    });
  },
);

test(
  "login with empty credentials must not redirect to main page",
  { tag: ["@release", "@api", "@regression"] },
  async ({ page }) => {
    await page.route("**/api/v1/auto_login", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { auto_login: false },
        }),
      });
    });

    await page.addInitScript(() => {
      window.process = window.process || {};
      const newEnv = { ...window.process.env, LANGFLOW_AUTO_LOGIN: "false" };
      Object.defineProperty(window.process, "env", {
        value: newEnv,
        writable: true,
        configurable: true,
      });
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.goto("/");
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // Try to submit with empty fields
    await page.getByPlaceholder("Username").fill("");
    await page.getByPlaceholder("Password").fill("");

    await page.evaluate(() => {
      sessionStorage.removeItem("testMockAutoLogin");
    });

    await page.getByRole("button", { name: "Sign In" }).click();

    // Must remain on login page
    await page.waitForTimeout(2000);
    const isOnMainPage = await page
      .getByTestId("mainpage_title")
      .isVisible()
      .catch(() => false);
    expect(isOnMainPage).toBeFalsy();

    await expect(page.getByPlaceholder("Username")).toBeVisible({
      timeout: 5000,
    });
  },
);
