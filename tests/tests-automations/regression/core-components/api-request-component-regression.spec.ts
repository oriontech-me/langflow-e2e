import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { enableInspectPanel } from "../../../helpers/ui/open-advanced-options";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Helper: create a blank flow and add the API Request component to the canvas.
// After this call the component node is visible and its inspector is open.
async function addApiRequestComponent(page: Page) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.getByTestId("sidebar-search-input").fill("API Request");
  await expect(
    page.getByTestId("add-component-button-api-request"),
  ).toBeAttached({ timeout: 10000 });
  // The add button reveals on hover — use data-testid suffix match to find
  // the sidebar item without needing to know its category prefix
  // (e.g. "utilitiesAPI Request", "helpersAPI Request", etc.)
  await page
    .locator('[data-testid$="API Request"]:not([data-testid*="add-component"])')
    .first()
    .hover();
  await page.getByTestId("add-component-button-api-request").click();
  await adjustScreenView(page);
  await expect(page.getByTestId("title-API Request")).toBeVisible({
    timeout: 15000,
  });
}

// Helper: run the component and return the raw text content from the output inspection dialog.
// The output Data object is displayed in a Monaco editor — textContent gives the JSON string.
//
// Anchors the build-finished signal on the inspect-output button becoming enabled —
// this is the actual precondition for the next click. The previous version waited on
// a "built successfully" toast, which matched any visible toast with that text and
// could resolve against a stale node from a prior step before fading.
async function runAndOpenOutput(page: Page): Promise<string> {
  const inspectButton = page.getByTestId(
    "output-inspection-api response-apirequest",
  );
  await page.getByTestId("button_run_api request").click();
  await expect(inspectButton).toBeEnabled({ timeout: 45000 });

  await inspectButton.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10000 });

  return await dialog
    .locator("[role='textbox']")
    .first()
    .evaluate((el: HTMLElement) => el.textContent ?? "");
}

// Helper: click an AG Grid cell, fill the resulting textarea editor, and save.
// Uses toPass() for full retry on AG Grid re-render instability.
// After save, verifies the value appears as a button INSIDE the same cell
// (scoped to `cellLocator`, not the whole dialog) to guard against:
//   - false-positive saves where the editor closed for another reason
//   - the value landing in a different row/column but matching the dialog-wide
//     button-by-name lookup
async function fillViewTextCell(
  page: Page,
  cellLocator: Locator,
  value: string,
): Promise<void> {
  await expect(async () => {
    if (!(await page.getByTestId("textarea").isVisible())) {
      let coords: { x: number; y: number } | null = null;
      try {
        coords = await cellLocator.evaluate(
          (el: Element) => {
            const rect = el.getBoundingClientRect();
            return rect.width
              ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
              : null;
          },
          null,
          { timeout: 500 },
        );
      } catch {
        coords = null;
      }
      if (!coords) throw new Error("Cell not found or not rendered");
      await page.mouse.click(coords.x, coords.y);
      await expect(page.getByTestId("textarea")).toBeAttached({ timeout: 2000 });
    }
    await page.getByTestId("textarea").fill(value, { timeout: 2000 });
    const saveCoords = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const vt = dialogs.find((d) =>
        d.querySelector('[data-testid="textarea"]'),
      );
      if (!vt) return null;
      const btn = Array.from(vt.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save"),
      );
      if (!btn) return null;
      const rect = (btn as HTMLElement).getBoundingClientRect();
      return rect.width
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        : null;
    });
    if (!saveCoords) throw new Error("Save button not found in View Text dialog");
    await page.mouse.click(saveCoords.x, saveCoords.y);
    await expect(page.getByTestId("textarea")).toHaveCount(0, { timeout: 3000 });
    // Cell-scoped — the rendered button must live inside this specific cell,
    // not somewhere else in the dialog.
    await expect(
      cellLocator.getByRole("button", { name: value, exact: true }),
    ).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 40000 });
}

// Helper: locate a TableModal by its DialogTitle heading.
//
// Both Radix Dialog and Radix Popover render `role="dialog"` into portals at
// the end of <body>, so any `.last()` selector resolves to whichever happens
// to mount latest in DOM order — a coincidence, not a guarantee. Scoping by
// the DialogTitle (which Radix renders as <h2>, fed from the field's
// `display_name` upstream) ties the locator to a stable identity.
function tableDialog(page: Page, title: "Headers" | "Body"): Locator {
  return page
    .locator('[role="dialog"]')
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

// =============================================================================
// UI / Canvas tests — verify component rendering and inspector fields
// =============================================================================

test(
  "API Request component — renders on canvas with correct output and URL handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
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
  { tag: ["@stable", "@release", "@regression", "@components"] },
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
  { tag: ["@stable", "@regression", "@components"] },
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

    await page.getByTestId("button_run_api request").click();
    await expect(
      page.getByText("Error building Component API Request:"),
    ).toBeVisible({ timeout: 30000 });

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
  { tag: ["@stable", "@release", "@regression", "@components"] },
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
  { tag: ["@stable", "@release", "@regression", "@components"] },
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
  "API Request component — PUT method executes PUT verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/put only accepts PUT — returns 405 for any other method
    await urlInput.fill("https://httpbin.org/put");

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("PUT", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("PUT");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain("httpbin.org/put");
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — PATCH method executes PATCH verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/patch only accepts PATCH — returns 405 for any other method
    await urlInput.fill("https://httpbin.org/patch");

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("PATCH", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("PATCH");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain("httpbin.org/patch");
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — DELETE method executes DELETE verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // httpbin.org/delete only accepts DELETE — returns 405 for any other method
    await urlInput.fill("https://httpbin.org/delete");

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("DELETE", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("DELETE");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain("httpbin.org/delete");
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — non-2xx HTTP response propagates status_code without crashing",
  { tag: ["@stable", "@regression", "@components"] },
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
  { tag: ["@stable", "@regression", "@components"] },
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

// =============================================================================
// Headers / Body / cURL tests
// =============================================================================

test(
  "API Request component — inspector headers table accepts key + value cell entries",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const headersDiv = page.getByTestId("div-table_headers");
    await expect(headersDiv).toBeVisible({ timeout: 10000 });
    await headersDiv.getByRole("button", { name: "Open table" }).click();

    const headersDialog = tableDialog(page, "Headers");
    await expect(headersDialog).toBeVisible({ timeout: 10000 });

    await headersDialog.getByTestId("add-row-button").click();

    const lastRow = headersDialog
      .locator('[role="treegrid"] [role="row"]')
      .last();

    // fillViewTextCell asserts the cell value renders as a button inside the table dialog after Save —
    // verifying both key AND value cells closes the gap where only the key was previously asserted.
    await fillViewTextCell(
      page,
      lastRow.locator('[col-id="key"]'),
      "X-E2E-Header",
    );
    await fillViewTextCell(
      page,
      lastRow.locator('[col-id="value"]'),
      "test-header-value",
    );

    await headersDialog.getByTestId("btn-cancel-modal").click();
    await expect(headersDialog).not.toBeVisible({ timeout: 5000 });

    // Canvas integrity after the table interaction
    await expect(page.getByTestId("title-API Request")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "API Request component — cURL tab switches mode and field accepts a cURL command",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The inspector has two tabs: URL (tab_0) and cURL (tab_1)
    await expect(page.getByTestId("tab_0_url")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("tab_1_curl")).toBeVisible({
      timeout: 10000,
    });

    // Switch to cURL tab
    await page.getByTestId("tab_1_curl").click();

    // The cURL textarea must become visible
    const curlTextarea = page.getByTestId("textarea_str_curl_input");
    await expect(curlTextarea).toBeVisible({ timeout: 10000 });

    // Fill with a valid cURL command
    const curlCommand =
      "curl -X GET https://httpbin.org/get -H 'Accept: application/json'";
    await curlTextarea.fill(curlCommand);
    await expect(curlTextarea).toHaveValue(curlCommand);

    // The cURL input handle must be present on the left side of the node
    await expect(
      page.getByTestId("handle-apirequest-shownode-curl-left"),
    ).toBeVisible();

    // Canvas must still show exactly one node
    await expect(page.getByTestId("title-API Request")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "API Request component — cURL mode parses command, auto-fills URL, executes GET and returns 200",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Switch to the cURL tab BEFORE touching the URL field. Pre-filling url_input
    // would let the test pass even if cURL parsing was broken — the test would
    // unintentionally fall back to the URL-tab path. The whole point of this test
    // is to exercise the cURL parser end-to-end.
    await page.getByTestId("tab_1_curl").click();
    const curlTextarea = page.getByTestId("textarea_str_curl_input");
    await expect(curlTextarea).toBeVisible({ timeout: 10000 });

    await curlTextarea.fill(
      "curl -X GET https://httpbin.org/get -H 'Accept: application/json'",
    );

    // The cURL parser must auto-populate url_input with the URL extracted from the command.
    // Asserting this directly proves the parser ran and is the precondition the run relies on
    // (without it the backend would receive an empty URL and validation would fail).
    await page.waitForFunction(
      () => {
        const el = document.getElementById(
          "popover-anchor-input-url_input",
        ) as HTMLInputElement | null;
        return el !== null && el.value === "https://httpbin.org/get";
      },
      { timeout: 10000 },
    );

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain("httpbin.org");
    expect(output).toContain("status_code");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test(
  "API Request component — body table accepts key + value cell entries when method is POST",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // The body field is declared `advanced=True` AND the InspectionPanel has a
    // hardcoded filter that hides `body` when `method === "GET"` (see
    // InspectionPanelFields.tsx: it returns false for type === "APIRequest" +
    // field === "body" + method.value === "GET"). Switch to POST so the body
    // table is rendered in the inspector. Wait for the `real_time_refresh`
    // response so the `[value]` useEffect in TableNodeComponent settles before
    // the next interaction (see persistence test for full context).
    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    const refreshResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/custom_component/update") &&
        r.request().method() === "POST",
      { timeout: 15000 },
    );
    await page.getByText("POST", { exact: true }).click();
    await refreshResponse;
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("POST");

    const bodyDiv = page.getByTestId("div-table_body");
    await expect(bodyDiv).toBeVisible({ timeout: 10000 });
    await bodyDiv.getByRole("button", { name: "Open table" }).click();

    const bodyDialog = tableDialog(page, "Body");
    await expect(bodyDialog).toBeVisible({ timeout: 10000 });

    const addRowButton = bodyDialog.getByTestId("add-row-button");
    await expect(addRowButton).toBeVisible({ timeout: 5000 });

    // The refresh has already completed in the step above (we waited for the
    // response), so the `[value]` useEffect in TableNodeComponent has settled.
    // A plain click adds the row reliably; no force or retry needed.
    const dataRows = bodyDialog.locator(
      '[role="treegrid"] [role="row"][row-id]',
    );
    await addRowButton.click();
    await expect(dataRows).toHaveCount(1, { timeout: 5000 });
    const lastRow = dataRows.last();

    // Same `fillViewTextCell` pattern as the headers test — each cell is asserted
    // to render as a button inside the table dialog after Save, guaranteeing both
    // key and value were persisted (not just one).
    await fillViewTextCell(
      page,
      lastRow.locator('[col-id="key"]'),
      "payload",
    );
    await fillViewTextCell(
      page,
      lastRow.locator('[col-id="value"]'),
      "e2e-body-value",
    );

    await bodyDialog.getByTestId("btn-cancel-modal").click();
    await expect(bodyDialog).not.toBeVisible({ timeout: 5000 });

    // Canvas integrity after the table interaction
    await expect(page.getByTestId("title-API Request")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "API Request component — flow state persists in database after autosave (URL, method, headers)",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const expectedUrl = "https://httpbin.org/get?persist=true";
    const headerKey = "X-Persist-Header";
    const headerValue = "persisted-value";
    let flowId = "";

    await test.step("Configure URL, method and a header on a new flow", async () => {
      await addApiRequestComponent(page);
      // Match against the pathname rather than `split("/").slice(-1)` so a
      // trailing slash / query string / hash on the route doesn't silently
      // turn `flowId` into a non-UUID and make the persistence test fail for
      // a routing change unrelated to the behavior under test.
      const flowIdMatch = new URL(page.url()).pathname.match(
        /\/flow\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      );
      expect(flowIdMatch).not.toBeNull();
      flowId = flowIdMatch![1];

      const urlInput = page.getByTestId("popover-anchor-input-url_input");
      await expect(urlInput).toBeVisible({ timeout: 10000 });
      await urlInput.fill(expectedUrl);

      // Switching the method dropdown triggers a `real_time_refresh` →
      // POST /api/v1/custom_component/update — the backend re-renders the
      // template and the new response resets the `[value]` useEffect in
      // TableNodeComponent. Wait for that response BEFORE opening the headers
      // table; otherwise the row-add can race against the reset.
      const methodDropdown = page.getByTestId("dropdown_str_method");
      await methodDropdown.click();
      const refreshResponse = page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/custom_component/update") &&
          r.request().method() === "POST",
        { timeout: 15000 },
      );
      await page.getByText("POST", { exact: true }).click();
      await refreshResponse;
      await expect(
        page.getByTestId("value-dropdown-dropdown_str_method"),
      ).toHaveText("POST");

      const headersDiv = page.getByTestId("div-table_headers");
      await expect(headersDiv).toBeVisible({ timeout: 10000 });
      await headersDiv.getByRole("button", { name: "Open table" }).click();

      const headersDialog = tableDialog(page, "Headers");
      await expect(headersDialog).toBeVisible({ timeout: 10000 });

      // The refresh has already completed in the step above (we waited for the
      // response), so the `[value]` useEffect in TableNodeComponent has settled
      // for `headers.value` too. A plain click reliably adds a second data row.
      const headersAddBtn = headersDialog.getByTestId("add-row-button");
      await expect(headersAddBtn).toBeVisible({ timeout: 5000 });
      const headersDataRows = headersDialog.locator(
        '[role="treegrid"] [role="row"][row-id]',
      );
      await expect(headersDataRows).toHaveCount(1, { timeout: 5000 });
      await headersAddBtn.click();
      await expect(headersDataRows).toHaveCount(2, { timeout: 5000 });

      const lastRow = headersDataRows.last();
      await fillViewTextCell(
        page,
        lastRow.locator('[col-id="key"]'),
        headerKey,
      );
      await fillViewTextCell(
        page,
        lastRow.locator('[col-id="value"]'),
        headerValue,
      );
      // Click the dialog-level Save button — Cancel discards `tempValue`
      // (see `handleCancel` in TableNodeComponent). The persistence test must
      // commit the row so autosave can write it to the database.
      await headersDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(headersDialog).not.toBeVisible({ timeout: 5000 });
    });

    await test.step(
      "Backend persistence — poll GET /api/v1/flows/{id} until autosave wrote URL/method/header",
      async () => {
        // `page.request` inherits session cookies — `GET /api/v1/flows/{id}` requires
        // session auth in Langflow's auto-login mode. Polling the API directly (rather
        // than reloading the page first) confirms the autosave reached the database,
        // not just the in-memory React state.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`/api/v1/flows/${flowId}`);
              if (!res.ok()) return null;
              const flow = await res.json();
              // `node.data.type` is written as the component's Python class
              // name (`APIRequest`) here — NOT the display name. This differs
              // from `prompt-template-component-regression.spec.ts` which
              // matches by the display name `"Prompt Template"`; that test is
              // also correct because PromptComponent has `name = "Prompt
              // Template"` (a space-separated identifier) so its class-name
              // and display-name happen to coincide. For API Request, the
              // class is `APIRequestComponent` registered as `APIRequest` in
              // the type registry, while `display_name = "API Request"`. Use
              // class name here.
              const apiNode = (flow?.data?.nodes ?? []).find(
                (n: { data?: { type?: string } }) =>
                  n?.data?.type === "APIRequest",
              );
              const template = apiNode?.data?.node?.template;
              if (!template) return null;
              const urlValue = template.url_input?.value ?? "";
              const methodValue = template.method?.value ?? "";
              const headersValue = Array.isArray(template.headers?.value)
                ? template.headers.value
                : [];
              const matchedHeader = headersValue.find(
                (h: { key?: string; value?: string }) =>
                  h.key === headerKey && h.value === headerValue,
              );
              if (
                urlValue === expectedUrl &&
                methodValue === "POST" &&
                matchedHeader
              ) {
                return "persisted";
              }
              return null;
            },
            { timeout: 20000, intervals: [500, 1000, 2000] },
          )
          .toBe("persisted");
      },
    );

    await test.step(
      "Reload page — UI rehydrates URL, method, and the saved header row",
      async () => {
        // The API poll above already proves the autosave reached the database.
        // This step is the UI counterpart: a full reload must rehydrate the
        // node's compact view (URL, method) AND reopening the headers table
        // must show the saved key/value buttons.
        await page.reload();
        await expect(
          page.getByTestId("canvas_controls_dropdown"),
        ).toBeVisible({ timeout: 60000 });
        await expect(page.getByTestId("title-API Request")).toBeVisible({
          timeout: 30000,
        });

        const urlInput = page.getByTestId("popover-anchor-input-url_input");
        await expect(urlInput).toHaveValue(expectedUrl, { timeout: 10000 });
        await expect(
          page.getByTestId("value-dropdown-dropdown_str_method"),
        ).toHaveText("POST");

        // After reload, the InspectionPanel may not be auto-open and the node
        // is not selected. Select the node, then use the existing helper to
        // open the panel idempotently (the helper no-ops if already open),
        // so `div-table_headers` renders.
        await page.locator(".react-flow__node").first().click();
        await enableInspectPanel(page);

        // Reopen the headers table — same locator pattern as test 11. Asserting
        // the saved key + value render as buttons inside the dialog confirms
        // the row survived the reload via the UI, not just the API.
        const headersDiv = page.getByTestId("div-table_headers");
        await expect(headersDiv).toBeVisible({ timeout: 10000 });
        await headersDiv.getByRole("button", { name: "Open table" }).click();
        const headersDialog = tableDialog(page, "Headers");
        await expect(headersDialog).toBeVisible({ timeout: 10000 });
        await expect(
          headersDialog.getByRole("button", { name: headerKey, exact: true }),
        ).toBeVisible({ timeout: 5000 });
        await expect(
          headersDialog.getByRole("button", { name: headerValue, exact: true }),
        ).toBeVisible({ timeout: 5000 });
        await headersDialog.getByTestId("btn-cancel-modal").click();
      },
    );
  },
);
