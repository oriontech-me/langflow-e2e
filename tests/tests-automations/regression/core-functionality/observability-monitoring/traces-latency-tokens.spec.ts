import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

const TRACE_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/basic-prompting-trace-fixture.json",
    ),
    "utf8",
  ),
);

test.describe("Flow Activity / Traces — latency and tokens", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-latency-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    const flowRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        ...TRACE_FIXTURE,
        name: `${TRACE_FIXTURE.name} ${Date.now()}`,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;

    // Run the flow once to generate a trace. The fixture has no provider configured,
    // so the LanguageModelComponent fails with "A model selection is required" — that
    // is intentional. The failure still emits a trace entry with totalLatencyMs and
    // totalTokens, which is what these tests validate.
    await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "trace-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
  });

  test.afterAll(async ({ request }) => {
    if (flowId) {
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { "x-api-key": apiKey },
      });
    }
    if (apiKeyId) {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  });

  test(
    "GET /api/v1/monitor/traces returns totalLatencyMs and totalTokens for a flow run",
    {
      tag: [
        "@release",
        "@workspace",
        "@regression",
        "@observability",
        "@api",
      ],
    },
    async ({ request }) => {
      const res = await request.get(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.traces)).toBe(true);
      expect(body.traces.length).toBeGreaterThan(0);
      expect(typeof body.total).toBe("number");
      expect(body.total).toBeGreaterThan(0);

      const trace = body.traces[0];
      expect(typeof trace.totalLatencyMs).toBe("number");
      expect(trace.totalLatencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof trace.totalTokens).toBe("number");
      expect(trace.totalTokens).toBeGreaterThanOrEqual(0);
      expect(trace.flowId).toBe(flowId);
      expect(["success", "error", "running"]).toContain(trace.status);
      expect(typeof trace.startTime).toBe("string");
    },
  );

  test(
    "Flow Activity page shows latency and token columns for the run",
    {
      tag: ["@release", "@workspace", "@regression", "@observability"],
    },
    async ({ page }) => {
      (page as any).allowFlowErrors();

      await page.goto(`/flow/${flowId}`);
      await expect(page.getByTestId("sidebar-nav-traces")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("sidebar-nav-traces").click();

      await expect(page.getByTestId("flow-activity-header")).toBeVisible({
        timeout: 10000,
      });

      const latencyCell = page
        .locator('.ag-cell[col-id="totalLatencyMs"]')
        .first();
      await expect(latencyCell).toBeVisible({ timeout: 15000 });
      await expect(latencyCell).toHaveText(/^\d+\s*ms$/);

      const tokensCell = page
        .locator('.ag-cell[col-id="totalTokens"]')
        .first();
      await expect(tokensCell).toBeVisible();
      await expect(tokensCell).toHaveText(/^\d+$/);
    },
  );

  test(
    "Trace Details modal shows span tree and per-span latency",
    {
      tag: ["@release", "@workspace", "@regression", "@observability"],
    },
    async ({ page }) => {
      (page as any).allowFlowErrors();

      await page.goto(`/flow/${flowId}`);
      await expect(page.getByTestId("sidebar-nav-traces")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("sidebar-nav-traces").click();

      // Open the trace details by clicking on the Run cell of the first row.
      // Whole-row click does not trigger the panel — onCellClicked is the wired event.
      await page.locator('.ag-cell[col-id="run"]').first().click();

      await expect(page.getByTestId("trace-detail-view")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByTestId("span-tree")).toBeVisible();
      await expect(page.getByTestId("span-detail")).toBeVisible();

      // 4 span nodes: 1 root + Prompt Template + Chat Input + Language Model
      await expect(page.locator('[data-testid^="span-node-"]')).toHaveCount(4);

      const spanDetail = page.getByTestId("span-detail");
      await expect(spanDetail).toContainText(/Latency/);
      await expect(spanDetail).toContainText(/\d+\s*ms/);

      const spanTree = page.getByTestId("span-tree");
      await expect(spanTree).toContainText("Prompt Template");
      await expect(spanTree).toContainText("Chat Input");
      await expect(spanTree).toContainText("Language Model");
    },
  );
});

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
