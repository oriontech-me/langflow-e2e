import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  SUPERUSER_PASSWORD,
  SUPERUSER_USERNAME,
} from "../../../../helpers/auth/credentials";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { signInThroughForm } from "../../../../helpers/auth/sign-in-through-form";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openNewFlowTemplatesModal } from "../../../../helpers/flows/open-new-flow-templates-modal";
import { renameFlow } from "../../../../helpers/flows/rename-flow";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

// Auth — login screen and per-user flow isolation (QA-CHECKLIST §4.1 + the
// §4.2 isolation bullet). Spec doc: docs/core-functionality/auth/auto-login-off.md
//
// The auto_login mock is CLIENT-side (page.route): the server keeps
// LANGFLOW_AUTO_LOGIN=true, so the standalone `request` fixture still
// authenticates normally — which is what lets the second user be provisioned
// through /api/v1/users/ while the BROWSER sees a password-first instance.
//
// History: this test used to drive the OSS Admin Page for its user CRUD.
// Upstream removed that page in langflow-ai/langflow#14276 (2026-08-05), which
// is where the old version died. The CRUD coverage lives in
// admin-user-management.spec.ts (API-driven); what THIS test owns is the
// login screen appearing when auto-login is off, and that two users see only
// their own flows.

/** Client-side auto-login kill switch — the server itself is untouched. */
async function enableLoginScreen(page: Page): Promise<void> {
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
}

/** Signs in through the form (429-absorbing) and waits for the workspace. */
async function signIn(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const status = await signInThroughForm(page, username, password);
  expect(status, "the form login should authenticate").toBe(200);
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });
}

/** Logs out through the user menu and lands back on the login screen. */
async function signOut(page: Page): Promise<void> {
  await page.getByTestId("user-profile-settings").click();
  await page.evaluate(() => {
    sessionStorage.setItem("testMockAutoLogin", "true");
  });
  await page.getByText("Logout", { exact: true }).click();
  await page.waitForSelector("text=sign in to langflow", { timeout: 30000 });
}

/**
 * Creates a flow from the Basic Prompting template and renames it, returning
 * the flow id read from the editor URL — the id the cleanup deletes.
 */
async function createNamedFlow(page: Page, flowName: string): Promise<string> {
  await openNewFlowTemplatesModal(page);
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();
  await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
  await adjustScreenView(page, { numberOfZoomOut: 1 });
  await renameFlow(page, { flowName });
  const id = page.url().match(/\/flow\/([^/?#]+)/)?.[1];
  expect(id, "the editor URL should carry the created flow's id").toBeTruthy();

  await page.getByTestId("icon-ChevronLeft").first().click();
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });
  await expect(page.getByText(flowName, { exact: true })).toBeVisible({
    timeout: 15000,
  });
  return id as string;
}

async function deleteUserIfCreated(
  request: APIRequestContext,
  token: string,
  userId: string | null,
): Promise<void> {
  if (!userId) return;
  await request
    .delete(`/api/v1/users/${userId}`, { headers: { Authorization: token } })
    .catch(() => {});
}

test(
  "when auto_login is off, users sign in through the form and see only their own flows",
  { tag: ["@stable", "@release", "@api", "@database", "@mainpage", "@auth"] },
  async ({ page, request }) => {
    const secondUsername = `user_${Math.random().toString(36).substring(5)}`;
    const secondPassword = `pw_${Math.random().toString(36).substring(5)}`;
    const superuserFlow = `flow_a_${Math.random().toString(36).substring(5)}`;
    const secondUserFlow = `flow_b_${Math.random().toString(36).substring(5)}`;

    const token = await getAuthToken(request);
    let secondUserId: string | null = null;
    const createdFlowIds: string[] = [];

    try {
      await test.step("the login screen appears when auto-login cannot log in", async () => {
        await enableLoginScreen(page);
        await page.goto("/");
        await page.waitForSelector("text=sign in to langflow", {
          timeout: 30000,
        });
      });

      await test.step("provision the second user via the admin API", async () => {
        // The OSS Admin Page is gone (langflow-ai/langflow#14276) — user
        // provisioning is API-only, and the API path also spends no login-form
        // attempts against the endpoint's per-IP budget.
        const createRes = await request.post("/api/v1/users/", {
          headers: { Authorization: token },
          data: { username: secondUsername, password: secondPassword },
        });
        expect(createRes.status()).toBe(201);
        secondUserId = (await createRes.json()).id;
        const activateRes = await request.patch(
          `/api/v1/users/${secondUserId}`,
          {
            headers: { Authorization: token },
            data: { is_active: true },
          },
        );
        expect(activateRes.status()).toBe(200);
      });

      await test.step("the superuser signs in through the form and creates a flow", async () => {
        await signIn(page, SUPERUSER_USERNAME, SUPERUSER_PASSWORD);
        createdFlowIds.push(await createNamedFlow(page, superuserFlow));
      });

      await test.step("the second user signs in and does not see the superuser's flow", async () => {
        await signOut(page);
        await signIn(page, secondUsername, secondPassword);
        // The isolation assertion proper: the OTHER user's flow, by its exact
        // name, absent from this workspace.
        await expect(
          page.getByText(superuserFlow, { exact: true }),
        ).toHaveCount(0);
      });

      await test.step("the second user creates their own flow and sees only it", async () => {
        createdFlowIds.push(await createNamedFlow(page, secondUserFlow));
        await expect(
          page.getByText(secondUserFlow, { exact: true }),
        ).toBeVisible({ timeout: 15000 });
        await expect(
          page.getByText(superuserFlow, { exact: true }),
        ).toHaveCount(0);
      });

      await test.step("back as the superuser, the second user's flow is invisible", async () => {
        await signOut(page);
        await signIn(page, SUPERUSER_USERNAME, SUPERUSER_PASSWORD);
        await expect(page.getByText(superuserFlow, { exact: true })).toBeVisible(
          { timeout: 15000 },
        );
        await expect(
          page.getByText(secondUserFlow, { exact: true }),
        ).toHaveCount(0);
      });
    } finally {
      // Id-scoped cleanup, superuser token — the old version leaked its user
      // and both flows on every run. The second user's flow is deletable by
      // the superuser; the user record goes last.
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, {
          headers: { Authorization: token },
        }).catch(() => {});
      }
      await deleteUserIfCreated(request, token, secondUserId);
    }
  },
);
