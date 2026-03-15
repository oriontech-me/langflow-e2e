import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

// Reusable helper: create blank flow and add the API Request component.
// After this call the inspector panel is open with all component fields visible.
async function addApiRequestComponent(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.waitForSelector('[data-testid="sidebar-search-input"]', { timeout: 10000 });
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("API Request");
  await page.waitForSelector('[data-testid="add-component-button-api-request"]', { timeout: 10000 });
  await page.getByTestId("add-component-button-api-request").click();
  // Inspector opens automatically; wait for the URL field as signal
  await page.waitForSelector('[data-testid="popover-anchor-input-url_input"]', { timeout: 15000 });
}

test(
  "API Request component performs GET to httpbin and returns built successfully",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Configure the URL field (in the inspector panel on the right)
    await page.getByTestId("popover-anchor-input-url_input").fill("https://httpbin.org/get");

    // Run the component
    await page.getByTestId("button_run_api request").click();

    // Wait for execution to complete successfully
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output and verify status 200
    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await expect(page.locator('[role="dialog"]').getByText('"status_code": 200')).toBeVisible();
    await expect(page.locator('[role="dialog"]').getByText('"source": "https://httpbin.org/get"')).toBeVisible();
    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — cURL mode POST with JSON body",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Switch to cURL mode
    await page.waitForSelector('[data-testid="tab_1_curl"]', { timeout: 15000 });
    await page.getByTestId("tab_1_curl").click();

    // Wait for cURL tab to be fully selected before interacting
    await page.waitForSelector('[data-testid="tab_1_curl"][aria-selected="true"]', {
      timeout: 10000,
    });

    // Wait for the cURL textarea to be visible and ready
    await page.waitForSelector('[data-testid="textarea_str_curl_input"]', {
      timeout: 10000,
      state: "visible",
    });

    // Fill cURL command with POST + JSON body
    await page.getByTestId("textarea_str_curl_input").click();
    await page.getByTestId("textarea_str_curl_input").fill(
      `curl -X POST https://httpbin.org/post -H "Content-Type: application/json" -d '{"langflow": "regression-test", "status": "ok"}'`,
    );

    // Wait for the cURL to be parsed: URL field must be auto-populated.
    // The parsing is async (debounced), so we must wait before running,
    // otherwise the backend receives an empty URL and fails validation.
    await page.waitForFunction(
      () => {
        const urlInput = document.getElementById(
          "popover-anchor-input-url_input",
        ) as HTMLInputElement | null;
        return urlInput !== null && urlInput.value === "https://httpbin.org/post";
      },
      { timeout: 10000 },
    );
    // Brief pause to let React flush all derived state (method, body) after the URL update.
    await page.waitForTimeout(300);

    // Run the component
    await page.getByTestId("button_run_api request").click();

    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output and validate the JSON body was sent and echoed back
    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('"status_code": 200')).toBeVisible();
    await expect(dialog.getByText('"source": "https://httpbin.org/post"')).toBeVisible();

    // The output is rendered in a virtualized code editor — only visible lines appear in the DOM,
    // and JSON string values display with escaped quotes (e.g. \"langflow\").
    // Use evaluate() to get the full textContent and search for the payload tokens unquoted.
    const editorContent = await dialog.locator("[role='textbox']").evaluate((el) => el.textContent ?? "");
    expect(editorContent).toContain("langflow");
    expect(editorContent).toContain("regression-test");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — include_httpx_metadata=true adds request headers to output",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    await page.getByTestId("popover-anchor-input-url_input").fill("https://httpbin.org/get");

    // Enable include_httpx_metadata toggle — adds outgoing request headers to output
    await page.waitForSelector('[data-testid="toggle_bool_include_httpx_metadata"]', { timeout: 10000 });
    await page.getByTestId("toggle_bool_include_httpx_metadata").click();

    await page.getByTestId("button_run_api request").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('"status_code": 200')).toBeVisible();

    // With include_httpx_metadata=True, the output includes a "headers" key with outgoing request headers.
    // The virtualized editor may not render all lines; use textContent to check the full output.
    const editorContent = await dialog.locator("[role='textbox']").evaluate((el) => el.textContent ?? "");
    expect(editorContent).toContain('"headers"');
    // Langflow sets a User-Agent header identifying itself
    expect(editorContent).toContain("Langflow");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — timeout error returns status_code 500 with error field",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Set a very short timeout (3s) and point at an endpoint that delays 10s —
    // the component should catch the exception and return status_code 500.
    await page.getByTestId("int_int_timeout").fill("3");
    await page.keyboard.press("Tab");
    await page.getByTestId("popover-anchor-input-url_input").fill("https://httpbin.org/delay/10");

    await page.getByTestId("button_run_api request").click();

    // The component handles the timeout internally and still reports "built successfully"
    // (it returns an error Data object rather than raising an exception).
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('"status_code": 500')).toBeVisible();

    const editorContent = await dialog.locator("[role='textbox']").evaluate((el) => el.textContent ?? "");
    expect(editorContent).toContain('"error"');

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — URL mode POST via method dropdown returns 200",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    await page.getByTestId("popover-anchor-input-url_input").fill("https://httpbin.org/post");

    // Change HTTP method from GET to POST using the method dropdown
    await page.getByTestId("dropdown_str_method").click();
    await page.waitForSelector('[data-testid="POST-1-option"]', { timeout: 5000 });
    await page.getByTestId("POST-1-option").click();
    await page.waitForSelector(
      '[data-testid="value-dropdown-dropdown_str_method"]:has-text("POST")',
      { timeout: 5000 },
    );

    await page.getByTestId("button_run_api request").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('"status_code": 200')).toBeVisible();
    await expect(dialog.getByText('"source": "https://httpbin.org/post"')).toBeVisible();

    await page.keyboard.press("Escape");
  },
);
