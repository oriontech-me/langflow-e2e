import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

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

    const authToken = await getAuthToken(request);

    await page.getByTestId("home-dropdown-menu").first().click();
    // Use the testid (not localized text) so the test does not break under i18n
    await expect(page.getByTestId("btn-duplicate-flow")).toBeVisible({
      timeout: 5000,
    });

    // Intercept the duplicate POST so we know the new flow's id directly.
    // Asserting by id (instead of a count delta on GET /flows) makes the
    // test resilient to parallel workers creating unrelated flows.
    const duplicateResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/v1/flows") &&
        resp.request().method() === "POST" &&
        resp.status() === 201,
      { timeout: 10000 },
    );
    await page.getByTestId("btn-duplicate-flow").click();
    const duplicateResponse = await duplicateResponsePromise;
    const duplicateId = ((await duplicateResponse.json()) as { id: string })
      .id;
    expect(duplicateId).toBeTruthy();

    // Toast appears as soon as the duplicate POST resolves — confirms the action committed
    await expect(page.getByText(/duplicated successfully/i).last()).toBeVisible(
      { timeout: 10000 },
    );

    // Confirm the duplicated flow exists in the database
    await expect
      .poll(
        async () => {
          const res = await request.get("/api/v1/flows/", {
            headers: { Authorization: authToken },
          });
          const flows = (await res.json()) as Array<{ id: string }>;
          return flows.some((f) => f.id === duplicateId);
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
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
      // Multi-step teardown: swallow so a failed first delete still lets the
      // second run (a throw here would leak the sibling flow).
      await deleteFlow(request, original.id, {
        headers: { Authorization: authToken },
      }).catch(() => {});
      if (duplicateId) {
        await deleteFlow(request, duplicateId, {
          headers: { Authorization: authToken },
        }).catch(() => {});
      }
    }
  },
);
