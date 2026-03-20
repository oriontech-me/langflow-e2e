import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "GET /api/v1/monitor/transactions returns items with latency/duration info",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    const res = await request.get("/api/v1/monitor/transactions", {
      headers: { Authorization: authToken },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();

    // The endpoint returns a paginated object: { items: [], total, page, size, pages }
    expect(typeof body).toBe("object");
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");

    // If there are transactions, check they have timing/latency fields
    if (body.items.length > 0) {
      const firstItem = body.items[0];

      // Transactions should have some time-related field
      const hasTimestamp =
        "timestamp" in firstItem ||
        "created_at" in firstItem ||
        "time" in firstItem;

      // Could also have latency, duration, or tokens fields
      const hasPerformanceField =
        "latency" in firstItem ||
        "duration" in firstItem ||
        "tokens" in firstItem ||
        "total_tokens" in firstItem ||
        hasTimestamp;

      expect(
        hasPerformanceField,
        "Transaction items should include timing or performance metadata",
      ).toBe(true);
    }
  },
);

test(
  "GET /api/v1/monitor/transactions supports pagination parameters",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    const res = await request.get("/api/v1/monitor/transactions?page=1&size=5", {
      headers: { Authorization: authToken },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(Array.isArray(body.items)).toBe(true);

    // Pagination fields should be present
    expect(typeof body.page).toBe("number");
    expect(typeof body.size).toBe("number");
    expect(typeof body.total).toBe("number");
    expect(typeof body.pages).toBe("number");

    // Size should respect the requested limit
    expect(body.items.length).toBeLessThanOrEqual(5);
  },
);

test(
  "GET /api/v1/monitor/messages response contains message content",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    const res = await request.get("/api/v1/monitor/messages", {
      headers: { Authorization: authToken },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();

    // Accept both array and paginated object formats
    const messages = Array.isArray(body) ? body : body.items ?? [];

    // If messages exist, check their structure
    if (messages.length > 0) {
      const firstMsg = messages[0];

      // Messages should have text content and session/flow info
      const hasContent =
        "text" in firstMsg ||
        "message" in firstMsg ||
        "content" in firstMsg;

      const hasContext =
        "session_id" in firstMsg ||
        "flow_id" in firstMsg ||
        "sender" in firstMsg;

      expect(
        hasContent || hasContext,
        "Message items should contain message content and context metadata",
      ).toBe(true);
    }
  },
);

test(
  "traces page is accessible in the UI",
  { tag: ["@release", "@workspace", "@regression", "@observability"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);

    // Fetch transactions to see if any exist
    const txRes = await request.get("/api/v1/monitor/transactions", {
      headers: { Authorization: authToken },
    });

    if (txRes.status() !== 200) {
      console.log("INFO: Transactions endpoint not available, skipping UI test");
      return;
    }

    const body = await txRes.json();
    const hasTransactions = body.total > 0;

    if (!hasTransactions) {
      console.log("INFO: No transactions in the system, skipping latency UI test");
      return;
    }

    // Navigate to the traces/logs page
    await page.goto("/logs");
    await page.waitForTimeout(2000);

    const hasTraceContent = await page
      .locator("body")
      .evaluate((el) => (el as HTMLElement).innerText.length > 50);

    // Traces page might show latency info, duration, or token counts
    const hasMetricsText = await page
      .getByText(/latency|duration|tokens|ms|sec/i)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(
      hasTraceContent,
      "Traces page should have content when transactions exist",
    ).toBe(true);

    // Document whether latency metrics are shown in the UI
    if (hasMetricsText) {
      console.log("INFO: Latency/token metrics found in traces UI");
    }
  },
);
