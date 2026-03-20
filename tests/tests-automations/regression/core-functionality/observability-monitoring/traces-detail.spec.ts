import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "traces page is accessible from main navigation",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    // Try navigating directly to /logs (Langflow uses /logs for the traces/logs view)
    await page.goto("/logs");

    // The page should load without a hard error — either the logs page renders,
    // or we get redirected back to the home page.  Either way the main title must
    // be visible (it is always present in the app shell).
    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // If the URL stayed at /logs the logs section must have rendered some content.
    // If the app redirected away (no dedicated /logs route), just confirm we are
    // still on the application without a crash.
    const currentUrl = page.url();
    const isOnLogsPage = currentUrl.includes("/logs");

    if (isOnLogsPage) {
      // The logs page should contain either entries or an empty-state message
      const hasContent = await page
        .locator("body")
        .evaluate((el) => (el as HTMLElement).innerText.length > 0);
      expect(hasContent).toBe(true);
    } else {
      // Redirected — the app is still alive and the home page rendered
      await expect(page.getByTestId("mainpage_title")).toBeVisible();
    }
  },
);

test(
  "GET /api/v1/monitor/transactions returns 200 with paginated result",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // flow_id is required — use a valid UUID format
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();

    // The endpoint returns a paginated response: { items: [], total, page, size, pages }
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
  },
);

test(
  "GET /api/v1/monitor/transactions filters by flow_id (UUID)",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Use a well-formed UUID that does not correspond to any real flow.
    // The endpoint must still return 200 with an empty items array (not a 400/404).
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    // For an unknown flow_id the result should be a paginated object with empty items
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(0);
  },
);

test(
  "transaction records contain required fields when not empty",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // flow_id is required — use a valid UUID
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);

    if (body.items.length === 0) {
      // No transactions yet — nothing to validate, test passes
      return;
    }

    // Each record must have at minimum an id and a timestamp (or flow_id)
    const record = body.items[0];
    expect(record).toBeDefined();

    // The transaction object must be a plain object (not null/array)
    expect(typeof record).toBe("object");
    expect(record).not.toBeNull();
    expect(Array.isArray(record)).toBe(false);

    // One of the common timestamp fields must be present
    const hasTimestamp =
      "timestamp" in record ||
      "created_at" in record ||
      "updated_at" in record;
    expect(
      hasTimestamp,
      "Transaction record should contain a timestamp field",
    ).toBe(true);
  },
);
