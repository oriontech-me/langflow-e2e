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
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "trace-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    // Langflow returns 200 (with error payload) or 500 for component-level failures.
    // Anything outside that range (401, 422, etc.) means the run never reached the
    // graph executor and no trace will be emitted — fail fast instead of timing out.
    expect([200, 500]).toContain(runRes.status());

    // Trace writes are asynchronous: poll until at least one trace exists for this
    // flow before downstream tests query /monitor/traces.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return 0;
          const body = await res.json();
          return body.traces?.length ?? 0;
        },
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(0);
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
        "@stable",
        "@release",
        "@api",
        "@regression",
        "@observability",
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
      tag: [
        "@stable",
        "@release",
        "@workspace",
        "@regression",
        "@observability",
      ],
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
      // Cell renders before metrics populate; use an explicit timeout instead of the
      // default 5s expect timeout, which is shorter than the visibility wait above.
      await expect(latencyCell).toHaveText(/^\d+\s*ms$/, { timeout: 15000 });

      const tokensCell = page
        .locator('.ag-cell[col-id="totalTokens"]')
        .first();
      await expect(tokensCell).toBeVisible();
      await expect(tokensCell).toHaveText(/^\d+$/, { timeout: 15000 });
    },
  );

  test(
    "Trace Details modal shows span tree and per-span latency",
    {
      tag: [
        "@stable",
        "@release",
        "@workspace",
        "@regression",
        "@observability",
      ],
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

