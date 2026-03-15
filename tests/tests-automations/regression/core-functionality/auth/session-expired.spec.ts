import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "API request with invalid token returns 401 or 403",
  { tag: ["@release", "@api", "@regression"] },
  async ({ request }) => {
    const response = await request.get("/api/v1/flows/", {
      headers: { Authorization: "Bearer invalid.expired.token" },
    });

    expect([401, 403]).toContain(response.status());
  },
);

test(
  "API request with no token returns 401 or 403",
  { tag: ["@release", "@api", "@regression"] },
  async ({ request }) => {
    const response = await request.get("/api/v1/flows/");

    // Without any auth header, should be rejected
    expect([401, 403]).toContain(response.status());
  },
);

test(
  "UI shows login page when auto_login is unavailable (session cannot be established)",
  { tag: ["@release", "@api", "@regression"] },
  async ({ page }) => {
    // Simulate a scenario where the session cannot be established
    // (auto_login returns 500 = auth server down or session expired)
    await page.route("**/api/v1/auto_login", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: { auto_login: false } }),
      });
    });

    await page.addInitScript(() => {
      sessionStorage.setItem("testMockAutoLogin", "true");
    });

    await page.goto("/");

    // App must show the login form when session cannot be established
    await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });
    await expect(page.getByText(/sign in to langflow/i)).toBeVisible();

    // Login fields must be available for re-authentication
    await expect(page.getByPlaceholder("Username")).toBeVisible();
    await expect(page.getByPlaceholder("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  },
);

test(
  "valid token grants access to protected resources",
  { tag: ["@release", "@api", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Skip if no auth (environment without auth)
    if (!authToken) {
      return;
    }

    const response = await request.get("/api/v1/flows/", {
      headers: { Authorization: authToken },
    });

    expect(response.status()).toBe(200);
  },
);
