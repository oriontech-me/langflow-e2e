import { expect, test } from "../../fixtures";

test(
  "user must not be able to login after logout and refresh the page when auto_login is false",
  { tag: ["@release", "@api"] },
  async ({ page }) => {
    await test.step("Mock auto_login route to force login screen", async () => {
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
    });

    await test.step("Navigate to app and confirm login screen is shown", async () => {
      await page.goto("/");
      await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });
    });

    await test.step("Log in with valid credentials and confirm main page loads", async () => {
      await page.getByPlaceholder("Username").fill("langflow");
      await page.getByPlaceholder("Password").fill("langflow");
      await page.evaluate(() => {
        sessionStorage.removeItem("testMockAutoLogin");
      });
      await page.getByRole("button", { name: "Sign In" }).click();
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });
    });

    await test.step("Log out via user profile menu", async () => {
      await page.getByTestId("user-profile-settings").click();
      await page.evaluate(() => {
        sessionStorage.setItem("testMockAutoLogin", "true");
      });
      await page.getByText("Logout", { exact: true }).click();
      await page.waitForTimeout(1000);
    });

    await test.step("Reload page and confirm session was cleared — login screen must appear", async () => {
      await page.reload();
      await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });

      const isLoggedIn = await page
        .getByTestId("mainpage_title")
        .isVisible()
        .catch(() => false);

      expect(isLoggedIn).toBeFalsy();
    });
  },
);
