import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";

// `skipModal: true` on every bootstrap here is load-bearing, not a tidy-up. The
// default branch opens the templates modal by clicking "New Flow", which on this
// build NAVIGATES INTO a freshly created flow instead of returning home — so the
// page ends up in the editor, `mainpage_title` can never appear, and both tests
// died on a 30 s timeout naming a home-page testid (#1791, measured 2/2 locally;
// the captured snapshot reads `Starter Project / New Flow (1)` over a
// `Flow canvas`). Its retry loop also creates one flow per attempt, which is the
// other half of the same defect — see the tracker below. The sibling
// `flow-navigation-between-folders.spec.ts` already bootstraps this way.
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(async ({ page }) => {
  flows = trackCreatedFlows(page);
});

// The API setup issues its creates through `request.post`, a separate
// APIRequestContext, so this page-side capture cannot double-count them — the two
// sets are disjoint by construction. Never a global sweep: the suite runs
// `fullyParallel` and deleting a flow this run did not create would wipe a
// concurrent worker's.
test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
  flows.dispose();
});

test(
  "flows created via API appear on the home listing",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page, { skipModal: true });

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
      await deleteFlow(request, flowId, { headers: { Authorization: authToken } });
    }
  },
);

test(
  "searching flows by name filters results correctly",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page, { skipModal: true });

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
      // Multi-step teardown: swallow so a failed first delete still lets the
      // second run (a throw here would leak the sibling flow).
      await deleteFlow(request, flow1Id, {
        headers: { Authorization: authToken },
      }).catch(() => {});
      await deleteFlow(request, flow2Id, {
        headers: { Authorization: authToken },
      }).catch(() => {});
    }
  },
);
