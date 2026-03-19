import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

// Reusable helper: create blank flow and add the Webhook component.
// After this call the component is visible on the canvas and the inspector is open.
async function addWebhookComponent(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
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
  { tag: ["@release", "@regression"] },
  async ({ page, request }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").at(-1)!;
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for autosave to persist the flow before posting
    await page.waitForTimeout(4000);

    // JSON body — the primary use case
    const jsonRes = await request.post(`/api/v1/webhook/${flowId}`, {
      data: { event: "regression-test", value: 42 },
    });
    expect(jsonRes.status()).toBe(202);
    const jsonBody = await jsonRes.json();
    expect(jsonBody.status).toBe("in progress");
    expect(jsonBody.message).toBe("Task started in the background");

    // Plain-text body — the endpoint must accept any Content-Type
    const textRes = await request.post(`/api/v1/webhook/${flowId}`, {
      data: "regression-plain-text",
      headers: { "Content-Type": "text/plain" },
    });
    expect(textRes.status()).toBe(202);
    const textBody = await textRes.json();
    expect(textBody.status).toBe("in progress");
  },
);

test(
  "Webhook component — flow is saved to database and contains the Webhook node",
  { tag: ["@release", "@regression"] },
  async ({ page, request }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").at(-1)!;
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
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // The inspector renders the cURL field (via WebhookFieldComponent → TextAreaComponent)
    // as a textbox containing the actual curl command with the real backend URL and flow ID.
    // This verifies that the CURL_WEBHOOK placeholder is correctly substituted.
    const flowId = page.url().split("/").at(-1)!;
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
  { tag: ["@release", "@regression"] },
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
    await page.getByTestId("output-inspection-data-webhook").click();
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
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").at(-1)!;
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
  { tag: ["@release", "@regression"] },
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
  { tag: ["@release", "@regression"] },
  async ({ request }) => {
    // The webhook endpoint returns 404 when the flow_id_or_name cannot be resolved.
    // This is confirmed by the backend unit test: test_webhook_not_found_invalid_endpoint.
    // Using a string name (not UUID) as the backend resolves by endpoint_name first.
    const response = await request.post(
      "/api/v1/webhook/non-existent-flow-e2e-regression-test",
      {
        data: { test: "not-found" },
      },
    );

    expect(response.status()).toBe(404);
  },
);

test(
  "GET /api/v1/monitor/messages returns 200 with array response",
  { tag: ["@release", "@regression"] },
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
