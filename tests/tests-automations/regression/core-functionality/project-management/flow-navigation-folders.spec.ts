import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "flows created via API appear on the home listing",
  { tag: ["@release", "@workspace", "@regression", "@project-management"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page);

    const authToken = await getAuthToken(request);
    const flowName = `nav-test-flow-${Date.now()}`;

    const flowRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: flowName,
        description: "Navigation test flow",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flowRes.status()).toBe(201);
    const { id: flowId } = await flowRes.json();

    try {
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Reload so the new flow appears in the listing
      await page.reload();
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      await expect(page.getByText(flowName)).toBeVisible({ timeout: 10000 });
    } finally {
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
      });
    }
  },
);

test(
  "searching flows by name filters results correctly",
  { tag: ["@release", "@workspace", "@regression", "@project-management"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page);

    const authToken = await getAuthToken(request);

    const uniqueName = `unique-search-test-${Date.now()}`;
    const otherName = `other-flow-${Date.now()}`;

    const flow1Res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: uniqueName,
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flow1Res.status()).toBe(201);
    const { id: flow1Id } = await flow1Res.json();

    const flow2Res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: otherName,
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flow2Res.status()).toBe(201);
    const { id: flow2Id } = await flow2Res.json();

    try {
      await page.reload();
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      const searchInput = page
        .locator('input[placeholder*="search" i]')
        .first();
      await expect(searchInput).toBeVisible({ timeout: 5000 });

      await searchInput.fill(uniqueName);

      // Wait for filter to apply: uniqueName must be visible
      await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10000 });

      // otherName must not appear — wait for it to disappear (handles debounce)
      await expect(page.getByText(otherName)).toHaveCount(0, {
        timeout: 10000,
      });
    } finally {
      await request.delete(`/api/v1/flows/${flow1Id}`, {
        headers: { Authorization: authToken },
      });
      await request.delete(`/api/v1/flows/${flow2Id}`, {
        headers: { Authorization: authToken },
      });
    }
  },
);
