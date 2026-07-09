import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

// Run tests serially to avoid 400 "flow must be unique" errors from parallel
// autosaves of blank flows created within this file.
test.describe.configure({ mode: "serial" });

// Id of the flow the running test created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively building mid-run (#515).
let createdFlowId: string | undefined;

test.afterEach(async ({ page }) => {
  const flowId = createdFlowId;
  createdFlowId = undefined;
  if (!flowId) return;
  // Delete ONLY the flow this test created (scoped teardown, #515). Navigate off
  // the editor first so the unmounted flow page stops polling the flow we are
  // about to delete, then pass an explicit auth header — page.request is
  // unauthenticated under AUTO_LOGIN and would 401 otherwise. Not swallowed: a
  // failed cleanup surfaces instead of silently leaking the flow (#547).
  await page.goto("/");
  const authHeader = await getAuthToken(page.request);
  await deleteFlow(
    page.request,
    flowId,
    authHeader ? { headers: { Authorization: authHeader } } : undefined,
  );
});

// Reusable helper: create blank flow and add the Webhook component.
// After this call the component is visible on the canvas and the inspector is open.
async function addWebhookComponent(page: any) {
  await awaitBootstrapTest(page);
  // Let the home page's own transient-flow sweep (batch DELETE /api/v1/flows/)
  // finish before creating a flow — a create POST landing mid-sweep makes the
  // sweep 500 with SQLite "database is locked" (upstream delete_multiple_flows
  // weakness; log-only, no flow leak, but noisy). Waiting for network idle
  // serializes the sweep before our creation POST, removing the contention
  // window (#464).
  await page.waitForLoadState("networkidle").catch(() => {});
  // Capture the teardown id from the flow-creation POST, NOT from the canvas URL:
  // the URL id is a transient client-side handle on this Langflow version and
  // does not match the persisted flow (deleting it 404s and silently leaks the
  // real one). Tests still read the URL id for their own webhook-endpoint
  // assertions — that id resolves fine for the webhook route, just not for DELETE.
  const flowCreation = page.waitForResponse(
    (resp: any) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByTestId("blank-flow").click();
  const created = (await (await flowCreation).json()) as { id?: string };
  if (!created.id) {
    throw new Error("blank-flow creation returned no flow id");
  }
  createdFlowId = created.id;
  await page.waitForURL(/\/flow\//, { timeout: 30000 });
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("webhook");
  await page.waitForSelector('[data-testid="input_outputWebhook"]', {
    timeout: 10000,
  });
  await page.getByTestId("input_outputWebhook").hover();
  await page.getByTestId("add-component-button-webhook").click();
  await adjustScreenView(page);
  // Wait for the Webhook node to appear on the canvas
  await page.waitForSelector('[data-testid="input_output_webhook_draggable"]', {
    timeout: 15000,
  });
}

test(
  "Webhook component — HTTP POST accepts JSON and plain-text bodies returning 202",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page, request }) => {
    let flowId!: string;
    let apiKey!: string;
    let apiKeyId!: string;
    const bearerToken = await getAuthToken(request);

    await test.step("Add Webhook component to a blank flow", async () => {
      await addWebhookComponent(page);
      flowId = page.url().split("/").slice(-1)[0];
      expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("Wait for autosave to persist the flow", async () => {
      // The flow is created via UI; autosave debounce flushes it to the
      // database before any webhook POST can resolve flowId.
      await page.waitForTimeout(4000);
    });

    await test.step("Create temporary x-api-key for webhook auth", async () => {
      // The webhook endpoint requires `x-api-key` whenever Langflow's
      // WEBHOOK_AUTH_ENABLE setting is true (secure-by-default since 1.9.2+
      // via PR langflow-ai/langflow#12845). Create a temporary key, use it
      // for the POSTs, and delete it in the `finally` block.
      const keyRes = await request.post("/api/v1/api_key/", {
        headers: { Authorization: bearerToken },
        data: { name: `webhook-regression-${Date.now()}` },
      });
      expect(keyRes.status()).toBe(200);
      const keyBody = await keyRes.json();
      apiKey = keyBody.api_key;
      apiKeyId = keyBody.id;
    });

    try {
      await test.step("POST JSON body returns 202 with status 'in progress'", async () => {
        const jsonRes = await request.post(`/api/v1/webhook/${flowId}`, {
          headers: { "x-api-key": apiKey },
          data: { event: "regression-test", value: 42 },
        });
        expect(jsonRes.status()).toBe(202);
        const jsonBody = await jsonRes.json();
        expect(jsonBody.status).toBe("in progress");
        expect(jsonBody.message).toBe("Task started in the background");
      });

      await test.step("POST plain-text body returns 202 with status 'in progress'", async () => {
        // The endpoint must accept any Content-Type, not only application/json.
        const textRes = await request.post(`/api/v1/webhook/${flowId}`, {
          headers: { "x-api-key": apiKey, "Content-Type": "text/plain" },
          data: "regression-plain-text",
        });
        expect(textRes.status()).toBe(202);
        const textBody = await textRes.json();
        expect(textBody.status).toBe("in progress");
      });
    } finally {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  },
);

// Marked fixme until the Langflow frontend bundle stops mutating an undefined
// `Accept-Language` header inside the request wrapper (see #165 item 2 — surfaced
// by weekly run 25441253323 as `TypeError: Cannot set properties of undefined`).
// When the upstream bug is fixed, remove `.fixme` and re-validate.
test.fixme(
  "Webhook component — flow is saved to database and contains the Webhook node",
  // @stable removed: upstream Langflow regression breaks page.evaluate(fetch)
  // with "Cannot set properties of undefined (setting 'Accept-Language')".
  // Tracked in #180; restore @stable once upstream is fixed.
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").slice(-1)[0];
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for the auto-save debounce to flush the flow to the database.
    // This is required before making any API calls that depend on the flow existing.
    await page.waitForTimeout(4000);

    // Verify the flow is persisted and contains the Webhook component.
    // Use page.evaluate(fetch) so the request runs in the browser context and
    // carries the session cookies. The request fixture is unauthenticated and
    // would get a 403 from the flows endpoint even in auto-login mode.
    const flowData = await page.evaluate(async (fId) => {
      const res = await fetch(`/api/v1/flows/${fId}`, {
        credentials: "include",
      });
      if (!res.ok) return null;
      return res.json();
    }, flowId);

    expect(flowData).not.toBeNull();
    const nodes: any[] = flowData?.data?.nodes ?? [];

    // The flow must contain a Webhook node
    const webhookNode = nodes.find((n: any) => n.data?.type === "Webhook");
    expect(webhookNode).toBeDefined();

    // The endpoint field must store the BACKEND_URL placeholder (substituted by the frontend).
    // If this placeholder changes, the endpoint URL will stop working for all users.
    const endpointValue =
      webhookNode?.data?.node?.template?.endpoint?.value ?? "";
    expect(endpointValue).toBe("BACKEND_URL");
  },
);

test(
  "Webhook component — cURL command in inspector shows valid POST URL with flow ID",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // The inspector renders the cURL field (via WebhookFieldComponent → TextAreaComponent)
    // as a textbox containing the actual curl command with the real backend URL and flow ID.
    // This verifies that the CURL_WEBHOOK placeholder is correctly substituted.
    const flowId = page.url().split("/").slice(-1)[0];
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Read the cURL textbox value directly from the inspector (no modal needed).
    // The textbox is rendered inline in the inspector panel with placeholder "Type something..."
    await page.waitForSelector('[placeholder="Type something..."]', {
      timeout: 10000,
    });
    const curlValue = await page
      .locator('[placeholder="Type something..."]')
      .first()
      .inputValue();

    // Verify the cURL command structure — these are the key regression points:
    // 1. Uses POST method (not GET)
    expect(curlValue).toContain("-X POST");
    // 2. URL contains the real backend host and the correct flow ID
    expect(curlValue).toContain(`/api/v1/webhook/${flowId}`);
    // 3. Content-Type header is set to application/json
    expect(curlValue).toContain("Content-Type: application/json");
    // 4. Includes a placeholder JSON body
    expect(curlValue).toContain("-d");
  },
);

test(
  "Webhook component — empty data field returns empty Data object",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // The data field is empty by default — run without filling it.
    // build_data() checks `if not self.data` and returns Data(data={}).
    await page.waitForSelector('[data-testid="button_run_webhook"]', {
      timeout: 10000,
    });
    await page.getByTestId("button_run_webhook").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output and verify the result is an empty object
    await page.getByTestId("output-inspection-json-webhook").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    const editorContent = await dialog
      .locator("[role='textbox']")
      .evaluate((el) => el.textContent ?? "");

    // The output Data object must be {} — no keys present
    const parsed = JSON.parse(editorContent.trim() || "null");
    expect(parsed).toEqual({});

    await page.keyboard.press("Escape");
  },
);

test(
  "Webhook component — endpoint field renders the actual webhook URL",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").slice(-1)[0];
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // The endpoint field has advanced=False and copy_field=True.
    // The frontend replaces the "BACKEND_URL" placeholder with the real
    // webhook URL: {protocol}//{host}/api/v1/webhook/{flowId or endpoint_name}.
    await page.waitForSelector('[data-testid="str_endpoint"]', {
      timeout: 10000,
    });
    const endpointValue = await page
      .locator('[data-testid="str_endpoint"]')
      .inputValue();

    expect(endpointValue).toMatch(/^https?:\/\//);
    expect(endpointValue).toContain("/api/v1/webhook/");
    expect(endpointValue.length).toBeGreaterThan(0);
  },
);

test(
  "Webhook component — copy button copies the endpoint URL to clipboard",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // The CopyFieldAreaComponent renders a copy icon button with testid
    // btn_copy_{id} where id="str_endpoint" (type_fieldname convention).
    // Clicking it copies the endpoint URL and shows a success toast.
    await page.waitForSelector('[data-testid="btn_copy_str_endpoint"]', {
      timeout: 10000,
    });

    // Read what the endpoint field is showing before clicking copy
    const expectedUrl = await page
      .locator('[data-testid="str_endpoint"]')
      .inputValue();
    expect(expectedUrl).toContain("/api/v1/webhook/");

    await page.getByTestId("btn_copy_str_endpoint").click();

    // Verify the success toast appears
    await expect(page.getByText("Endpoint URL copied")).toBeVisible({
      timeout: 5000,
    });

    // Verify the clipboard actually contains the correct URL
    // playwright.config.ts grants clipboard permissions to Chromium
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toBe(expectedUrl);
  },
);

test(
  "Webhook component — POST to non-existent flow name returns 404",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ request }) => {
    // The webhook endpoint returns 404 when the flow_id_or_name cannot be resolved.
    // Since Langflow 1.9.2 (PR langflow-ai/langflow#12845) WEBHOOK_AUTH_ENABLE defaults
    // to True, so the auth dependency runs before the flow lookup — without an x-api-key
    // the endpoint short-circuits to 403 and we never reach the 404. We create a temporary
    // API key, send the POST with it, and assert the resolver-driven 404 fires.
    const bearerToken = await getAuthToken(request);
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `webhook-404-regression-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    const apiKey: string = keyBody.api_key;
    const apiKeyId: string = keyBody.id;

    try {
      const response = await request.post(
        "/api/v1/webhook/non-existent-flow-e2e-regression-test",
        {
          headers: { "x-api-key": apiKey },
          data: { test: "not-found" },
        },
      );

      expect(response.status()).toBe(404);
    } finally {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  },
);

// Helper: inject a value into the Webhook's "data" field by intercepting the
// GET /api/v1/flows/{id} response so the canvas receives the patched template.
// The "data" field (Payload, advanced=True) has no editable UI — it is populated
// only via the webhook POST endpoint in production. We simulate that by
// intercepting the API response, which is equivalent for testing build_data() logic.
async function loadFlowWithDataField(
  page: any,
  flowId: string,
  dataValue: string,
) {
  // Intercept the GET flow response and inject the data field value
  await page.route(`**/api/v1/flows/${flowId}`, async (route: any) => {
    const response = await route.fetch();
    const json = await response.json();

    const webhookNode = (json?.data?.nodes ?? []).find(
      (n: any) => n?.data?.type === "Webhook",
    );
    if (webhookNode) {
      webhookNode.data.node.template.data.value = dataValue;
    }

    await route.fulfill({ json });
  });

  // Navigate to the flow — the interceptor will inject the data field value
  await page.goto(`/flow/${flowId}`);
  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="button_run_webhook"]', {
    timeout: 60000,
  });
  await adjustScreenView(page);

  // Remove the intercept after use so it doesn't affect subsequent requests
  await page.unroute(`**/api/v1/flows/${flowId}`);
}

test(
  "Webhook component — valid JSON payload is propagated as structured Data output",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);
    const flowId = page.url().split("/").slice(-1)[0];
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for autosave before reloading
    await page.waitForTimeout(4000);

    // The "data" field has no editable UI — inject the value via API response
    // intercept so the canvas receives the patched template on navigation.
    // build_data() will parse the JSON string and return it as a Data object.
    await loadFlowWithDataField(
      page,
      flowId,
      '{"event": "regression-test", "value": 42}',
    );

    await page.getByTestId("button_run_webhook").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output inspection and verify the parsed object
    await page.getByTestId("output-inspection-json-webhook").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    const editorContent = await dialog
      .locator("[role='textbox']")
      .evaluate((el) => el.textContent ?? "");

    const parsed = JSON.parse(editorContent.trim() || "null");
    expect(parsed).toEqual({ event: "regression-test", value: 42 });

    await page.keyboard.press("Escape");
  },
);

test(
  "Webhook component — invalid JSON payload is encapsulated in {payload: ...}",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);
    const flowId = page.url().split("/").slice(-1)[0];
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for autosave before reloading
    await page.waitForTimeout(4000);

    // build_data() catches json.JSONDecodeError and wraps the raw string in
    // {"payload": "<raw string>"} — this tests that fallback path.
    const invalidPayload = "not valid json {{broken";

    await loadFlowWithDataField(page, flowId, invalidPayload);

    await page.getByTestId("button_run_webhook").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output inspection and verify the fallback wrapping
    await page.getByTestId("output-inspection-json-webhook").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    const editorContent = await dialog
      .locator("[role='textbox']")
      .evaluate((el) => el.textContent ?? "");

    const parsed = JSON.parse(editorContent.trim() || "null");
    expect(parsed).toEqual({ payload: invalidPayload });

    await page.keyboard.press("Escape");
  },
);

test(
  "GET /api/v1/monitor/messages returns 200 with array response",
  { tag: ["@stable", "@release", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // /api/v1/monitor/messages tracks message delivery for all components including Webhook.
    const res = await request.get("/api/v1/monitor/messages", {
      headers: { Authorization: authToken },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    // The response must be an array (possibly empty when no flows have run yet)
    expect(Array.isArray(body)).toBe(true);
  },
);
