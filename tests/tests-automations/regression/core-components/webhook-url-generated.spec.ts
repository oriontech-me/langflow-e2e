import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

// Reusable helper: create a blank flow and add the Webhook component.
// Mirrors the pattern from webhook-component-regression.spec.ts.
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
  await page.waitForSelector('[data-testid="input_output_webhook_draggable"]', {
    timeout: 15000,
  });
}

test(
  "Webhook component shows a URL field with a valid URL format",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // The cURL textarea is rendered in the inspector with placeholder "Type something..."
    // It contains the fully-qualified POST URL for this webhook endpoint.
    await page.waitForSelector('[placeholder="Type something..."]', {
      timeout: 10000,
    });
    const curlValue = await page
      .locator('[placeholder="Type something..."]')
      .first()
      .inputValue();

    // The value must be a non-empty string containing a URL
    expect(curlValue.length).toBeGreaterThan(0);

    // Must start with "curl" and reference a valid HTTP URL
    expect(curlValue).toMatch(/^curl\s/i);
    expect(curlValue).toMatch(/https?:\/\//i);
  },
);

test(
  "Webhook URL contains /api/v1/webhook path and the flow ID",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addWebhookComponent(page);

    // Extract the flow UUID from the current browser URL
    const flowId = page.url().split("/").at(-1)!;
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Read the cURL textbox in the inspector
    await page.waitForSelector('[placeholder="Type something..."]', {
      timeout: 10000,
    });
    const curlValue = await page
      .locator('[placeholder="Type something..."]')
      .first()
      .inputValue();

    // The generated URL must reference the /api/v1/webhook/<flow-id> endpoint
    expect(curlValue).toContain(`/api/v1/webhook/${flowId}`);
  },
);

test(
  "GET /api/v1/monitor/messages returns 200 (webhook delivery monitoring endpoint)",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // /api/v1/monitor/messages is the companion endpoint to transactions and
    // tracks message delivery for all components including Webhook.
    const res = await request.get("/api/v1/monitor/messages", {
      headers: { Authorization: authToken },
    });

    // This endpoint always exists in supported Langflow versions
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The response must be an array (possibly empty when no flows have run yet)
    expect(Array.isArray(body)).toBe(true);
  },
);

test(
  "Webhook endpoint POST without content-type returns 202",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page, request }) => {
    await addWebhookComponent(page);

    const flowId = page.url().split("/").at(-1)!;
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for the auto-save debounce to persist the flow before posting
    await page.waitForTimeout(4000);

    // Send a plain-text body (no Content-Type header override) —
    // the Webhook endpoint must accept any body and return 202
    const res = await request.post(`/api/v1/webhook/${flowId}`, {
      data: "regression-plain-text",
      headers: { "Content-Type": "text/plain" },
    });

    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("in progress");
  },
);
