import { expect, test } from "../../../../fixtures/fixtures";
import {
  SUPERUSER_PASSWORD,
  SUPERUSER_USERNAME,
} from "../../../../helpers/auth/credentials";
import { signInThroughForm } from "../../../../helpers/auth/sign-in-through-form";

function setupAutoLoginMock(page: any) {
  return Promise.all([
    page.route("**/api/v1/auto_login", (route: any) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { auto_login: false },
        }),
      });
    }),
    page.addInitScript(() => {
      window.process = window.process || {};
      const newEnv = { ...window.process.env, LANGFLOW_AUTO_LOGIN: "false" };
      Object.defineProperty(window.process, "env", {
        value: newEnv,
        writable: true,
        configurable: true,
      });
      sessionStorage.setItem("testMockAutoLogin", "true");
    }),
  ]);
}

test(
  "logout must redirect user to login page",
  { tag: ["@release", "@api", "@regression", "@auth", "@stable"] },
  async ({ page }) => {
    await setupAutoLoginMock(page);

    await page.goto("/");
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // Login with valid credentials (429-absorbing — the endpoint budget is
    // shared with every other auth spec in the run)
    await signInThroughForm(page, SUPERUSER_USERNAME, SUPERUSER_PASSWORD);

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Verify authenticated — main page is visible
    await expect(page.getByTestId("mainpage_title")).toBeVisible({
      timeout: 5000,
    });

    // Open user menu and logout
    await page.getByTestId("user-profile-settings").click();

    await page.evaluate(() => {
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.getByText("Logout", { exact: true }).click();

    // Must redirect to login page
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    await expect(page.getByPlaceholder("Username")).toBeVisible({
      timeout: 5000,
    });

    // Main page must not be accessible
    await expect(page.getByTestId("mainpage_title")).toBeHidden({
      timeout: 5000,
    });
  },
);

test(
  "after logout, navigating to root must redirect to login",
  { tag: ["@release", "@api", "@regression", "@auth", "@stable"] },
  async ({ page }) => {
    await setupAutoLoginMock(page);

    await page.goto("/");
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // 429-absorbing — the login budget is shared with every auth spec
    await signInThroughForm(page, SUPERUSER_USERNAME, SUPERUSER_PASSWORD);

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Logout
    await page.getByTestId("user-profile-settings").click();

    await page.evaluate(() => {
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.getByText("Logout", { exact: true }).click();
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // Try to navigate directly to "/"
    await page.goto("/");

    // Should still show login — not bypass authentication
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    await expect(page.getByTestId("mainpage_title")).toBeHidden({
      timeout: 5000,
    });
  },
);

test(
  "after logout, reload must stay on login page",
  { tag: ["@release", "@api", "@regression", "@auth", "@stable"] },
  async ({ page }) => {
    await setupAutoLoginMock(page);

    await page.goto("/");
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    // 429-absorbing — the login budget is shared with every auth spec
    await signInThroughForm(page, SUPERUSER_USERNAME, SUPERUSER_PASSWORD);

    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    await page.getByTestId("user-profile-settings").click();

    await page.evaluate(() => {
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.getByText("Logout", { exact: true }).click();
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    await page.reload();

    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

    await expect(page.getByTestId("mainpage_title")).toBeHidden({
      timeout: 5000,
    });
  },
);
