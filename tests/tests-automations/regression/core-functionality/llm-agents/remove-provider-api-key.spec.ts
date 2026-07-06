import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Removing a provider credential (QA-CHECKLIST §7.5 "Remove API key from
// existing provider"). Provider credentials are stored as global variables;
// the configured-provider detail exposes only Replace, so removal happens
// through the Global Variables surface — UI (test 1) and API (test 2).
//
// Hardened for @stable (issue #505): the previous UI test was a chain of six
// silent early-returns (observed "passing" while logging `skipping`), and the
// API test "passed" on a 422 — POST /api/v1/variables/ now REQUIRES
// `default_fields`, which the old payload lacked. Every step is a hard
// assertion now.

test(
  "a provider credential variable can be removed through the Global Variables UI",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);
    const uniqueName = `provider-key-${Date.now()}`;
    let varId: string | undefined;

    await test.step("seed a credential variable via API", async () => {
      const createRes = await request.post("/api/v1/variables/", {
        headers: { Authorization: bearer },
        data: {
          name: uniqueName,
          value: "test-provider-key-value",
          type: "Credential",
          default_fields: [],
        },
      });
      expect([200, 201]).toContain(createRes.status());
      varId = (await createRes.json()).id;
      expect(varId).toBeTruthy();
    });

    try {
      await test.step("delete it through Settings > Global Variables", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
        await navigateSettingsPages(page, "Settings", "Global Variables");
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Global Variables",
          { timeout: 10000 },
        );

        const row = page.getByText(uniqueName, { exact: true }).first();
        await expect(row).toBeVisible({ timeout: 10000 });

        // Select the row's checkbox, then use the header trash action.
        const rowContainer = page
          .locator('[role="row"]', { hasText: uniqueName })
          .first();
        await rowContainer.locator('input[type="checkbox"], [role="checkbox"]').first().click();
        await page.getByTestId("icon-Trash2").first().click();

        const confirmButton = page
          .getByRole("button", { name: /delete|confirm|yes/i })
          .last();
        if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await confirmButton.click();
        }

        await expect(page.getByText(uniqueName, { exact: true })).toBeHidden({
          timeout: 10000,
        });
      });

      await test.step("the variable is gone from the API too", async () => {
        const getRes = await request.get(`/api/v1/variables/${varId}`, {
          headers: { Authorization: bearer },
        });
        expect([404, 422]).toContain(getRes.status());
      });
    } finally {
      // Belt-and-braces: if the UI deletion failed mid-way, drop the seed so
      // it does not leak into other runs.
      if (varId) {
        await request
          .delete(`/api/v1/variables/${varId}`, { headers: { Authorization: bearer } })
          .catch(() => {});
      }
    }
  },
);

test(
  "DELETE /api/v1/variables/{id} removes a provider API key variable",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider", "@api"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);
    const uniqueName = `provider-api-key-${Date.now()}`;
    let varId: string | undefined;

    await test.step("create test variable via API", async () => {
      const createRes = await request.post("/api/v1/variables/", {
        headers: { Authorization: authToken },
        data: {
          name: uniqueName,
          value: "test-provider-key-value",
          type: "Credential",
          default_fields: [],
        },
      });
      // Hard-fail on a non-2xx create — the previous version early-returned
      // here and reported a pass on a 422.
      expect([200, 201]).toContain(createRes.status());
      varId = (await createRes.json()).id;
      expect(varId).toBeTruthy();
    });

    await test.step("DELETE returns 200/204 and GET-by-id returns 404/422", async () => {
      const deleteRes = await request.delete(`/api/v1/variables/${varId}`, {
        headers: { Authorization: authToken },
      });
      expect([200, 204]).toContain(deleteRes.status());

      const getRes = await request.get(`/api/v1/variables/${varId}`, {
        headers: { Authorization: authToken },
      });
      expect([404, 422]).toContain(getRes.status());
    });

    await test.step("variables list no longer contains the deleted variable", async () => {
      const listRes = await request.get("/api/v1/variables/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);

      const listBody = await listRes.json();
      const variables = Array.isArray(listBody) ? listBody : (listBody.items ?? []);
      const found = variables.some(
        (v: { id?: string; name?: string }) => v.id === varId || v.name === uniqueName,
      );
      expect(found, "deleted variable must not appear in the variables list").toBe(false);
    });
  },
);
