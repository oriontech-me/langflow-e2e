import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { postLogin } from "../../../../helpers/auth/login-request";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

// Auth — admin user management (QA-CHECKLIST §4.2).
// Spec doc: docs/core-functionality/auth/admin-user-management.md
//
// API-driven on purpose. Upstream removed the OSS Admin Page in
// langflow-ai/langflow#14276 (2026-08-05, "SSO foundations, login seams, and
// remove OSS Admin Page"): on 1.12.0.dev33 the user menu renders no Admin Page
// item (the slot between Settings and Docs compiles to a null stub) and the SPA
// router registers no admin path. User management in OSS is /api/v1/users/ —
// the same surface the previous UI drove, asserted at the same observable that
// matters: whether the managed user can log in. The last test pins the removal
// itself, so an admin UI leaking back into OSS is caught here and not by a
// human diffing menus.
//
// This rewrite also buries a second, older defect the removal was masking: the
// old spec logged in with the hardcoded legacy password "langflow", refused
// since nightly 1.11.0.dev29 (#510) — helpers/auth/credentials.ts existed for
// exactly that and was never imported here.
//
// Every login verdict goes through postLogin, which absorbs the endpoint's
// per-IP rate-limit window (5/min, fixed, every attempt counts) — see
// helpers/auth/login-request.ts. A 401 is always a credential verdict, never
// budget.

/** Creates a user via the admin API and registers its cleanup. */
async function createUser(
  request: APIRequestContext,
  token: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await request.post("/api/v1/users/", {
    headers: { Authorization: token },
    data: { username, password },
  });
  expect(res.status(), "user creation should answer 201").toBe(201);
  const user = await res.json();
  // POST /api/v1/users/ creates users INACTIVE by default — asserted here so
  // the "inactive cannot log in" test below cannot pass by accident on an API
  // that started activating on create.
  expect(user.is_active, "a freshly created user ships inactive").toBe(false);
  return user.id as string;
}

async function patchUser(
  request: APIRequestContext,
  token: string,
  userId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`/api/v1/users/${userId}`, {
    headers: { Authorization: token },
    data,
  });
  expect(res.status(), `PATCH ${JSON.stringify(data)} should answer 200`).toBe(
    200,
  );
}

async function deleteUser(
  request: APIRequestContext,
  token: string,
  userId: string | null,
): Promise<void> {
  if (!userId) return;
  await request
    .delete(`/api/v1/users/${userId}`, { headers: { Authorization: token } })
    .catch(() => {});
}

test.describe("Auth — admin user management over /api/v1/users/", () => {
  let token: string;
  let userId: string | null = null;

  test.beforeEach(async ({ request }) => {
    token = await getAuthToken(request);
    userId = null;
  });

  test.afterEach(async ({ request }) => {
    await deleteUser(request, token, userId);
  });

  test(
    "admin creates a user inactive by default — the inactive user cannot log in",
    { tag: ["@stable", "@release", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const username = `user_${Math.random().toString(36).substring(5)}`;
      const password = `pw_${Math.random().toString(36).substring(5)}`;

      await test.step("create the user, without activating", async () => {
        userId = await createUser(request, token, username, password);
      });

      await test.step("the inactive user's correct credentials are refused as pending approval", async () => {
        // The login endpoint is the observable, not the user record: is_active
        // false is what the admin WROTE, the refused login is what it MEANS.
        // A never-logged-in inactive user is its own branch in the product
        // (authenticate_user: last_login_at unset -> 400 "Waiting for
        // approval"); the deactivated-after-use branch (401 "Inactive user")
        // is the sibling test's subject.
        const res = await postLogin(request, username, password);
        expect(res.status(), "a pending user must not authenticate").toBe(400);
        expect((await res.json()).detail).toBe("Waiting for approval");
      });
    },
  );

  test(
    "activation and deactivation flip the same credentials between refused and accepted",
    { tag: ["@stable", "@release", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const username = `user_${Math.random().toString(36).substring(5)}`;
      const password = `pw_${Math.random().toString(36).substring(5)}`;
      userId = await createUser(request, token, username, password);

      await test.step("activating the user makes the identical login succeed", async () => {
        await patchUser(request, token, userId as string, { is_active: true });
        const res = await postLogin(request, username, password);
        expect(res.status(), "an activated user must authenticate").toBe(200);
        expect(await res.json()).toHaveProperty("access_token");
      });

      await test.step("deactivating the user refuses the identical login again", async () => {
        // The pair is the assertion: without this half, a login endpoint that
        // ignores is_active entirely would pass the activation step (#1010's
        // "a lone success is equivocal" reasoning, applied to auth).
        await patchUser(request, token, userId as string, { is_active: false });
        const res = await postLogin(request, username, password);
        // 401 "Inactive user", not 400: this user HAS logged in, so it takes
        // the deactivated branch rather than the pending-approval one.
        expect(res.status(), "a deactivated user must be refused").toBe(401);
        expect((await res.json()).detail).toBe("Inactive user");
      });
    },
  );

  test(
    "renaming a user moves the login to the new username",
    { tag: ["@stable", "@release", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const username = `user_${Math.random().toString(36).substring(5)}`;
      const renamed = `renamed_${Math.random().toString(36).substring(5)}`;
      const password = `pw_${Math.random().toString(36).substring(5)}`;
      userId = await createUser(request, token, username, password);
      await patchUser(request, token, userId, { is_active: true });

      await test.step("rename via PATCH", async () => {
        await patchUser(request, token, userId as string, {
          username: renamed,
        });
      });

      await test.step("the new username logs in with the unchanged password", async () => {
        const res = await postLogin(request, renamed, password);
        expect(res.status(), "the renamed user must authenticate").toBe(200);
      });

      await test.step("the old username no longer authenticates", async () => {
        const res = await postLogin(request, username, password);
        expect(
          res.status(),
          "the pre-rename username must be gone, not aliased",
        ).toBe(401);
      });
    },
  );

  test(
    "the OSS build offers no Admin Page — menu and route both",
    { tag: ["@stable", "@regression", "@auth", "@ui-ux"] },
    async ({ page }) => {
      // Pins langflow-ai/langflow#14276. If an admin UI ever ships back into
      // the OSS bundle — an EE surface leaking across the build split — this is
      // the test that names it, instead of a human noticing a new menu item.
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("the user menu renders, without an Admin Page item", async () => {
        await page.getByTestId("user-profile-settings").click();
        // The menu itself must be open before the absence means anything — an
        // unopened menu also contains no Admin Page.
        await expect(page.getByTestId("menu_settings_button")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByText("Admin Page", { exact: true })).toHaveCount(
          0,
        );
        await page.keyboard.press("Escape");
      });

      await test.step("/admin does not land on an admin UI", async () => {
        await page.goto("/admin");
        // The router registers no admin path, so the SPA falls through to the
        // workspace. The old page's own marker (the user-search field) is the
        // absence asserted — a redirect target rename would not fake a pass.
        await page.waitForSelector('[data-testid="mainpage_title"]', {
          timeout: 30000,
        });
        await expect(page.getByPlaceholder("Search Username")).toHaveCount(0);
      });
    },
  );
});
