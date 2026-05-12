import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

const FLOW_BASE = {
  description: "Flow duplicate test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test(
  "user can duplicate a flow from the home page dropdown menu",
  { tag: ["@release", "@workspace", "@stable"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("icon-ChevronLeft").first().click();

    await expect(page.getByTestId("home-dropdown-menu").first()).toBeVisible({
      timeout: 30000,
    });

    // Snapshot the flow count from the API so we can assert exactly +1 after duplicate
    const authToken = await getAuthToken(request);
    const listBefore = await request.get("/api/v1/flows/", {
      headers: { Authorization: authToken },
    });
    const countBefore = ((await listBefore.json()) as unknown[]).length;

    await page.getByTestId("home-dropdown-menu").first().click();
    // Use the testid (not localized text) so the test does not break under i18n
    await expect(page.getByTestId("btn-duplicate-flow")).toBeVisible({
      timeout: 5000,
    });
    await page.getByTestId("btn-duplicate-flow").click();

    // Toast appears as soon as the duplicate POST resolves — confirms the action committed
    await expect(page.getByText(/duplicated successfully/i).last()).toBeVisible(
      { timeout: 10000 },
    );

    // Confirm exactly one new flow exists in the database (not a no-op or a double-create)
    await expect
      .poll(
        async () => {
          const res = await request.get("/api/v1/flows/", {
            headers: { Authorization: authToken },
          });
          return ((await res.json()) as unknown[]).length;
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toBe(countBefore + 1);
  },
);

test(
  "duplicate flow via API auto-suffixes the name on collision",
  { tag: ["@release", "@workspace", "@api", "@stable"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);
    const originalName = `Flow to Duplicate - ${Date.now()}`;

    const createRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: { ...FLOW_BASE, name: originalName },
    });
    expect(createRes.status()).toBe(201);
    const original = await createRes.json();
    expect(original.name).toBe(originalName);

    let duplicateId: string | undefined;
    try {
      // POST again with the SAME name — backend must auto-suffix " (1)" to keep names unique.
      // This mirrors what the UI duplicate button triggers via use-handle-duplicate.ts.
      const duplicateRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: originalName },
      });
      expect(duplicateRes.status()).toBe(201);
      const duplicate = await duplicateRes.json();
      duplicateId = duplicate.id;

      expect(duplicate.id).not.toBe(original.id);
      expect(duplicate.name).toMatch(
        new RegExp(
          `^${originalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`,
        ),
      );

      const listRes = await request.get("/api/v1/flows/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);
      const flowList = (await listRes.json()) as Array<{ id: string }>;
      expect(flowList.some((f) => f.id === original.id)).toBe(true);
      expect(flowList.some((f) => f.id === duplicate.id)).toBe(true);
    } finally {
      await request.delete(`/api/v1/flows/${original.id}`, {
        headers: { Authorization: authToken },
      });
      if (duplicateId) {
        await request.delete(`/api/v1/flows/${duplicateId}`, {
          headers: { Authorization: authToken },
        });
      }
    }
  },
);
