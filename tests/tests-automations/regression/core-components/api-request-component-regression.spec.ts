import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Helper: create a blank flow and add the API Request component to the canvas.
// After this call the component node is visible and its inspector is open.
async function addApiRequestComponent(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.getByTestId("sidebar-search-input").fill("API Request");
  // Wait for the sidebar item to appear in the search results
  await page.waitForSelector('[data-testid="add-component-button-api-request"]', {
    timeout: 10000,
    state: "attached",
  });
  // The add button reveals on hover — use data-testid suffix match to find
  // the sidebar item without needing to know its category prefix
  // (e.g. "utilitiesAPI Request", "helpersAPI Request", etc.)
  await page
    .locator('[data-testid$="API Request"]:not([data-testid*="add-component"])')
    .first()
    .hover();
  await page.getByTestId("add-component-button-api-request").click();
  await adjustScreenView(page);
  // Wait for the API Request node to appear on the canvas
  await page.waitForSelector('[data-testid="title-API Request"]', {
    timeout: 15000,
  });
}

// Helper: run the component and return the raw text content from the output inspection dialog.
// The output Data object is displayed in a Monaco editor — textContent gives the JSON string.
async function runAndOpenOutput(page: any): Promise<string> {
  await page.getByTestId("button_run_api request").click();
  await page.waitForSelector("text=built successfully", { timeout: 45000 });
  await expect(page.getByText("built successfully").last()).toBeVisible();

  await page.getByTestId("output-inspection-api response-apirequest").click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  return await dialog
    .locator("[role='textbox']")
    .first()
    .evaluate((el: HTMLElement) => el.textContent ?? "");
}

// =============================================================================
// UI / Canvas tests — verify component rendering and inspector fields
// =============================================================================

test(
  "API Request component — renders on canvas with correct output and URL handles",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The node must be visible on the canvas
    await expect(page.getByTestId("title-API Request")).toBeVisible();

    // Output handle: "API Response" port on the right side
    await expect(
      page.getByTestId("handle-apirequest-shownode-api response-right"),
    ).toBeVisible();

    // URL input handle: left side (for connecting a Text Input or similar)
    await expect(
      page.getByTestId("handle-apirequest-shownode-url-left"),
    ).toBeVisible();

    // Exactly one node on the canvas — no spurious duplicates
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "API Request component — inspector fields accept configured values",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // URL field — testid: popover-anchor-input-url_input
    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    await urlInput.fill("https://httpbin.org/get");
    await expect(urlInput).toHaveValue("https://httpbin.org/get");

    // Method dropdown — default is GET; confirm it can be changed to POST
    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("POST", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("POST");
  },
);

test(
  "API Request component — invalid URL is accepted by field and run shows error notification",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    // Invalid URLs are accepted by the input field but rejected by the Pydantic HttpUrl
    // validator on run — the component must not crash on either action.
    (page as any).allowFlowErrors();

    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    await urlInput.fill("not-a-url");
    await expect(urlInput).toHaveValue("not-a-url");

    // Canvas and inspector must remain intact after filling an invalid URL
    await expect(page.getByTestId("title-API Request")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);

    // Running with an invalid URL must show the build error notification.
    // waitForSelector detects the moment the toast appears in the DOM —
    // more reliable than toBeVisible() alone for short-lived notifications.
    await page.getByTestId("button_run_api request").click();
    await page.waitForSelector(
      "text=Error building Component API Request:",
      { timeout: 30000 },
    );
    await expect(
      page.getByText("Error building Component API Request:"),
    ).toBeVisible();

    // The detail message must confirm it is specifically a URL validation error
    await expect(page.getByText("Invalid URL provided:")).toBeVisible();

    // Run button must still be visible after the error
    await expect(page.getByTestId("button_run_api request")).toBeVisible();
  },
);

// =============================================================================
// Execution / Output tests — verify HTTP behavior and output Data structure
// =============================================================================

test(
  "API Request component — GET request returns 200 and output Data contains all required fields",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    await urlInput.fill("https://httpbin.org/get");

    const output = await runAndOpenOutput(page);

    // HTTP response fields
    expect(output).toContain("200");
    expect(output).toContain("httpbin.org");

    // Structural fields always present in Data output regardless of response content —
    // verifying all at once protects against regressions in make_request() output structure
    expect(output).toContain("source");
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    // httpbin.org/get echoes the request URL inside `result`
    expect(output).toContain('"url"');

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — POST method executes POST verb and returns 200",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/post only accepts POST — returns 405 for any other method
    await urlInput.fill("https://httpbin.org/post");

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("POST", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("POST");

    const output = await runAndOpenOutput(page);

    // A successful POST to httpbin.org/post returns 200 and echoes the request URL
    expect(output).toContain("200");
    expect(output).toContain("httpbin.org/post");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — non-2xx HTTP response propagates status_code without crashing",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/status/404 responds with HTTP 404.
    // The component must NOT raise an exception — it returns Data(data={"status_code": 404, ...}).
    await urlInput.fill("https://httpbin.org/status/404");

    const output = await runAndOpenOutput(page);

    // status_code must be 404, not 200 and not 500 (the error fallback)
    expect(output).toContain("404");
    expect(output).toContain("source");
    // Must NOT contain the error field (which only appears on httpx transport exceptions)
    expect(output).not.toContain('"error"');

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — query parameters embedded in URL are sent and echoed",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/get echoes all query parameters in the `args` key of the response body
    await urlInput.fill(
      "https://httpbin.org/get?e2e_param=functional_test_value",
    );

    const output = await runAndOpenOutput(page);

    // The query parameter key and value must appear in the parsed response body (inside `result`)
    expect(output).toContain("e2e_param");
    expect(output).toContain("functional_test_value");
    expect(output).toContain("200");

    await page.keyboard.press("Escape");
  },
);
