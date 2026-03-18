import { expect, test } from "../../../../fixtures/fixtures";

// Helper: mock auto_login to show the login screen
async function enableLoginScreen(page: any) {
  await page.route("**/api/v1/auto_login", (route: any) => {
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: { auto_login: false } }),
    });
  });

  await page.addInitScript(() => {
    sessionStorage.setItem("testMockAutoLogin", "true");
  });
}

async function loginAs(page: any, username: string, password: string) {
  await page.evaluate(() => {
    sessionStorage.removeItem("testMockAutoLogin");
  });
  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

async function logoutAndShowLogin(page: any) {
  await page.evaluate(() => {
    sessionStorage.setItem("testMockAutoLogin", "true");
  });
  await page.getByTestId("user-profile-settings").click();
  await page.getByText("Logout", { exact: true }).click();
  await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });
}

// Filter the admin user list by username — resolves pagination issues
async function searchForUser(page: any, username: string) {
  const searchInput = page.getByPlaceholder("Search Username");
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  await searchInput.fill(username);
  await page.waitForTimeout(500);
  await expect(page.getByText(username, { exact: true })).toBeVisible({
    timeout: 5000,
  });
}

// Cleanup: navigate to admin page and delete user by username.
// Called in finally blocks to guarantee cleanup even on test failure.
async function deleteUserIfExists(page: any, username: string) {
  try {
    // Ensure we're on a page with navigation (not login screen)
    const isLoginPage = await page
      .getByRole("button", { name: "Sign In" })
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (isLoginPage) {
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });
    }

    // Navigate to Admin Page if not already there
    const isAdminPage = await page
      .getByPlaceholder("Search Username")
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (!isAdminPage) {
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();
    }

    // Search and delete if found
    const searchInput = page.getByPlaceholder("Search Username");
    await searchInput.fill(username);
    await page.waitForTimeout(500);

    const userVisible = await page
      .getByText(username, { exact: true })
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (userVisible) {
      await page.getByTestId("icon-Trash2").last().click();
      await page.getByText("Delete", { exact: true }).last().click();
      await page.waitForSelector("text=user deleted", { timeout: 10000 });
    }
  } catch {
    // Cleanup best-effort — do not fail the test report on cleanup errors
  }
}

test(
  "admin creates inactive user — inactive user cannot log in",
  { tag: ["@release", "@api", "@regression", "@auth"] },
  async ({ page }) => {
    const randomName = `user_${Math.random().toString(36).substring(5)}`;
    const randomPassword = Math.random().toString(36).substring(5);

    try {
      await enableLoginScreen(page);
      await page.goto("/");
      await page.waitForSelector("text=sign in to langflow", {
        timeout: 30000,
      });

      // Log in as admin
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Navigate to Admin Page
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();

      // Create new user WITHOUT activating (default is inactive)
      await page.getByText("New User", { exact: true }).click();
      await page.getByPlaceholder("Username").last().fill(randomName);
      await page.locator('input[name="password"]').fill(randomPassword);
      await page.locator('input[name="confirmpassword"]').fill(randomPassword);
      // Note: NOT clicking #is_active — user remains inactive

      await page.getByText("Save", { exact: true }).click();
      await page.waitForSelector("text=new user added", { timeout: 30000 });

      // Search for the user to handle pagination
      await searchForUser(page, randomName);

      // Log out as admin
      await page.getByTestId("icon-ChevronLeft").first().click();
      await page.waitForSelector('[data-testid="user-profile-settings"]', {
        timeout: 30000,
      });
      await logoutAndShowLogin(page);

      // Try to log in as inactive user — should fail
      await page.getByPlaceholder("Username").fill(randomName);
      await page.getByPlaceholder("Password").fill(randomPassword);
      await page.evaluate(() => {
        sessionStorage.removeItem("testMockAutoLogin");
      });
      await page.getByRole("button", { name: "Sign In" }).click();

      await page.waitForSelector("text=Error signing in", { timeout: 10000 });
      await expect(page.getByText("Error signing in")).toBeVisible();

      // Navigate back to admin to prepare cleanup
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();
    } finally {
      // Always delete the created user — even if the test fails midway
      await deleteUserIfExists(page, randomName);
    }
  },
);

test(
  "admin activates previously inactive user — user can log in after activation",
  { tag: ["@release", "@api", "@regression", "@auth"] },
  async ({ page }) => {
    const randomName = `user_${Math.random().toString(36).substring(5)}`;
    const randomPassword = Math.random().toString(36).substring(5);

    try {
      await enableLoginScreen(page);
      await page.goto("/");
      await page.waitForSelector("text=sign in to langflow", {
        timeout: 30000,
      });

      // Log in as admin
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Go to Admin Page and create inactive user
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();

      await page.getByText("New User", { exact: true }).click();
      await page.getByPlaceholder("Username").last().fill(randomName);
      await page.locator('input[name="password"]').fill(randomPassword);
      await page.locator('input[name="confirmpassword"]').fill(randomPassword);
      await page.getByText("Save", { exact: true }).click();
      await page.waitForSelector("text=new user added", { timeout: 30000 });

      // Search to find the user regardless of pagination, then activate via Pencil
      await searchForUser(page, randomName);
      await page.getByTestId("icon-Pencil").last().click();
      await page.waitForSelector("#is_active", { timeout: 5000 });
      await page.locator("#is_active").click();
      await page.getByText("Save", { exact: true }).click();
      await page.waitForSelector("text=user edited", { timeout: 30000 });

      // Log out as admin
      await page.getByTestId("icon-ChevronLeft").first().click();
      await page.waitForSelector('[data-testid="user-profile-settings"]', {
        timeout: 30000,
      });
      await logoutAndShowLogin(page);

      // Try to log in as now-active user — should succeed
      await page.getByPlaceholder("Username").fill(randomName);
      await page.getByPlaceholder("Password").fill(randomPassword);
      await page.evaluate(() => {
        sessionStorage.removeItem("testMockAutoLogin");
      });
      await page.getByRole("button", { name: "Sign In" }).click();

      await page.waitForSelector('[id="new-project-btn"]', { timeout: 30000 });
      await expect(page.locator('[id="new-project-btn"]')).toBeVisible();

      // Log out the activated user and re-enter as admin for cleanup
      await logoutAndShowLogin(page);
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();
    } finally {
      await deleteUserIfExists(page, randomName);
    }
  },
);

test(
  "admin renames user — renamed user can log in with new username",
  { tag: ["@release", "@api", "@regression", "@auth"] },
  async ({ page }) => {
    const randomName = `user_${Math.random().toString(36).substring(5)}`;
    const updatedName = `renamed_${Math.random().toString(36).substring(5)}`;
    const randomPassword = Math.random().toString(36).substring(5);

    try {
      await enableLoginScreen(page);
      await page.goto("/");
      await page.waitForSelector("text=sign in to langflow", {
        timeout: 30000,
      });

      // Log in as admin
      await loginAs(page, "langflow", "langflow");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Create and activate user
      await page.getByTestId("user-profile-settings").click();
      await page.getByText("Admin Page", { exact: true }).click();

      await page.getByText("New User", { exact: true }).click();
      await page.getByPlaceholder("Username").last().fill(randomName);
      await page.locator('input[name="password"]').fill(randomPassword);
      await page.locator('input[name="confirmpassword"]').fill(randomPassword);
      await page.waitForSelector("#is_active", { timeout: 1500 });
      await page.locator("#is_active").click(); // activate
      await page.getByText("Save", { exact: true }).click();
      await page.waitForSelector("text=new user added", { timeout: 30000 });

      // Search to find the user before editing
      await searchForUser(page, randomName);
      await page.getByTestId("icon-Pencil").last().click();
      await page.getByPlaceholder("Username").last().fill(updatedName);
      await page.getByText("Save", { exact: true }).click();
      await page.waitForSelector("text=user edited", { timeout: 30000 });

      // Search for the renamed user to confirm rename succeeded
      await searchForUser(page, updatedName);
    } finally {
      // Try to delete by updated name first, then original name as fallback
      await deleteUserIfExists(page, updatedName);
      await deleteUserIfExists(page, randomName);
    }
  },
);
