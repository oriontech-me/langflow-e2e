import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { postLogin } from "../../../../helpers/auth/login-request";
import { signInThroughForm } from "../../../../helpers/auth/sign-in-through-form";

// NOTE: When login fails with 401 (wrong credentials), the Langflow frontend re-calls
// /api/v1/auto_login. With the auto_login mock returning 500, the page resets before
// "Error signing in" can be captured. For successful login, the mock does not interfere.
//
// Strategy: verify old-password failure via request API assertion (reliable),
// and verify new-password success via both API and UI login flow.

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

test(
  "admin changes user password — user can log in with new password",
  { tag: ["@stable", "@release", "@api", "@regression", "@auth"] },
  async ({ page, request }) => {
    const username = `pwdtest_${Math.random().toString(36).substring(5)}`;
    const originalPassword = `pass_${Math.random().toString(36).substring(5)}`;
    const newPassword = `newpass_${Math.random().toString(36).substring(5)}`;

    const authToken = await getAuthToken(request);
    let userId: string | null = null;

    try {
      // Create user via API (avoids admin UI pagination issue — known Langflow bug:
      // admin search only filters the current page, not all pages)
      const createRes = await request.post("/api/v1/users/", {
        headers: { Authorization: authToken },
        data: { username, password: originalPassword },
      });
      expect(createRes.status()).toBe(201);
      const user = await createRes.json();
      userId = user.id;

      // Activate user (POST /api/v1/users/ creates users inactive by default)
      const activateRes = await request.patch(`/api/v1/users/${userId}`, {
        headers: { Authorization: authToken },
        data: { is_active: true },
      });
      expect(activateRes.status()).toBe(200);
      expect((await activateRes.json()).is_active).toBe(true);

      // Change password via API (superuser can set any user's password via PATCH)
      const patchRes = await request.patch(`/api/v1/users/${userId}`, {
        headers: { Authorization: authToken },
        data: { password: newPassword },
      });
      expect(patchRes.status()).toBe(200);

      // Assert: old password must be rejected by the login endpoint
      const oldLoginRes = await postLogin(request, username, originalPassword);
      expect(oldLoginRes.status()).toBe(401);

      // Assert: new password must be accepted by the login endpoint
      const newLoginRes = await postLogin(request, username, newPassword);
      expect(newLoginRes.status()).toBe(200);
      const loginBody = await newLoginRes.json();
      expect(loginBody).toHaveProperty("access_token");

      // UI verification: new password shows the main page in the browser
      // (Successful logins are not disrupted by the auto_login mock)
      await enableLoginScreen(page);
      await page.goto("/");
      await page.waitForSelector("text=sign in to langflow", {
        timeout: 30000,
      });

      // 429-absorbing: by this point the test has already spent four login
      // calls, so the UI attempt is the one most likely to meet a hot window.
      const uiStatus = await signInThroughForm(page, username, newPassword);
      expect(uiStatus, "the new password should sign in through the form").toBe(
        200,
      );

      await page.waitForSelector('[id="new-project-btn"]', { timeout: 30000 });
      await expect(page.locator('[id="new-project-btn"]')).toBeVisible();
    } finally {
      // Cleanup via API
      if (userId) {
        await request
          .delete(`/api/v1/users/${userId}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    }
  },
);

test(
  "admin changes user password — old password no longer works after change",
  { tag: ["@stable", "@release", "@api", "@regression", "@auth"] },
  async ({ page, request }) => {
    const username = `pwdold_${Math.random().toString(36).substring(5)}`;
    const originalPassword = `orig_${Math.random().toString(36).substring(5)}`;
    const newPassword = `new_${Math.random().toString(36).substring(5)}`;

    const authToken = await getAuthToken(request);
    let userId: string | null = null;

    try {
      // Create and activate user via API
      const createRes = await request.post("/api/v1/users/", {
        headers: { Authorization: authToken },
        data: { username, password: originalPassword },
      });
      expect(createRes.status()).toBe(201);
      userId = (await createRes.json()).id;

      const activateRes = await request.patch(`/api/v1/users/${userId}`, {
        headers: { Authorization: authToken },
        data: { is_active: true },
      });
      expect(activateRes.status()).toBe(200);

      // Verify old password works BEFORE the change (control assertion)
      const beforeChangeRes = await postLogin(request, username, originalPassword);
      expect(beforeChangeRes.status()).toBe(200);

      // Change password via API
      const patchRes = await request.patch(`/api/v1/users/${userId}`, {
        headers: { Authorization: authToken },
        data: { password: newPassword },
      });
      expect(patchRes.status()).toBe(200);

      // Assert: old password must NOW be rejected
      const afterChangeRes = await postLogin(request, username, originalPassword);
      expect(afterChangeRes.status()).toBe(401);
    } finally {
      // Cleanup via API
      if (userId) {
        await request
          .delete(`/api/v1/users/${userId}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    }
  },
);
