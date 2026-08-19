import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Every flow this file creates comes from `setupBlankFlow` inside
// `addApiRequestComponent`, which pushes the id here; afterEach deletes them
// id-scoped (repo convention, #490/#681). This replaced a `page.on("response")`
// interception of POST /api/v1/flows → 201: the flow is now created through
// `page.request`, which does not emit page-level response events, so the
// interception would have collected nothing and leaked every flow (#1147).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  // Explicit bearer: under AUTO_LOGIN a bare request context is
  // unauthenticated, so an unheadered DELETE 401s and silently leaks the flow.
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

// Echo endpoint base for the HTTP-execution tests. Defaults to postman-echo.com.
//
// History: the suite originally targeted httpbin.org, which proved chronically
// unreliable — it returned HTTP 503 (AWS ELB) during the weekly runs of
// 2026-06-08, 2026-06-15 (#383) and 2026-06-22 (#407). The retry-on-5xx in
// `runAndOpenOutput` (added in #383) only survives a transient blip within a
// single test window; a sustained outage exhausts all attempts and fails the
// run. After the third recurrence the default was moved to postman-echo.com,
// a more reliable public echo service that is a near drop-in for the paths this
// suite uses: `/get`, `/post`, `/put`, `/patch`, `/delete` (each 200 only for
// its matching verb), `/status/{code}` (deliberate status endpoint), query-param
// echo, and Host/url echo in the response body.
//
// One behavioral difference from httpbin: postman-echo returns **404** for a
// wrong verb where httpbin returned **405**. The per-verb guarantee is
// unaffected — the verb tests assert the output contains `200`, and 404 is just
// as much "not 200" as 405, so sending the wrong verb still fails the test.
//
// The override knob is what the daily workflow uses: it self-hosts a go-httpbin
// service and sets ECHO_BASE_URL to that container's IP (#462), so CI runs
// against a reliable in-network endpoint instead of the public default. The
// value must be reachable BY LANGFLOW — the component's backend makes the
// request, not the Playwright runner — and a self-hosted host on a private IP
// must be added to LANGFLOW_SSRF_ALLOWED_HOSTS (the daily allows the RFC-1918
// CIDRs). Note the component's URL validator rejects single-label hostnames, so
// a CI service-container reachable only by its bare service label will NOT work
// — which is why ECHO_BASE_URL is built from the raw IP, not the service name.
// ECHO_HOST is derived from the same base URL so the echoed-host assertions
// match whatever endpoint is configured.
const ECHO_BASE = (
  process.env.ECHO_BASE_URL ??
  process.env.HTTPBIN_BASE_URL ??
  "https://postman-echo.com"
).replace(/\/$/, "");
const ECHO_HOST = new URL(ECHO_BASE).host;

// dev46: headers / body are advanced fields, so their table widget
// (`div-table_<field>`) is not on the node body by default. Select the node,
// open the inspector (parameters-button), toggle `inspector-add-<field>` to add
// the field to the node body, then close the inspector — the table then renders
// on the node body. `body` only appears in the inspector once the method is a
// verb that carries a payload (e.g. POST), so switch the method first for it.
async function addTableFieldToBody(page: Page, field: "headers" | "body") {
  await page.getByTestId("title-API Request").click();
  await openAdvancedOptions(page);
  await page.getByTestId(`inspector-add-${field}`).click();
  await closeAdvancedOptions(page);
}

// Helper: create a blank flow and add the API Request component to the canvas.
// After this call the component node is visible on the canvas. Returns the
// created flow's id (the caller needs it in the persistence test).
//
// The flow is created over the REST API and opened from the dashboard
// (`setupBlankFlow`) instead of through home page → "New Flow" → templates modal
// → `blank-flow`. That UI path leaves the welcome overlay OPEN behind the modal
// ("Browse more templates" only sets `isTemplatesOpen`, it never calls
// `close()`), and while it is open FlowPage mounts the whole
// FlowSidebarComponent inside a `display: none` wrapper — so the
// `sidebar-search-input` fill below raced an element that was in the DOM with an
// empty bounding box, which Playwright reports as `hidden` (#1147, root-caused
// on #1063). Creating over the API never opens the overlay.
async function addApiRequestComponent(page: Page): Promise<string> {
  const flowId = await setupBlankFlow(page);
  createdFlowIds.push(flowId);
  // Gate on write permission having RESOLVED before adding: useAddComponent
  // bails out SILENTLY while `useIsFlowReadOnly` is true, which it is for the
  // whole time the effective-permissions query is in flight. The header's
  // flow-name button is disabled by the same expression, so its enabled state is
  // an exact observable for "the add will register". Without this the add is
  // dropped with no error and the node-count assertions fail without naming the
  // cause.
  await expect(page.getByTestId("menu_bar_display")).toBeEnabled({
    timeout: 30000,
  });
  await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
    timeout: 30000,
  });
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
  return flowId;
}

// The output Data object the component returns is JSON. A transient upstream
// failure surfaces as the component's OWN top-level `status_code` being 5xx
// (a degraded echo service can return 502/503/504; an httpx transport blip
// surfaces as status_code 500 with an `error` field).
// The component faithfully propagates the upstream status — this is not a
// Langflow bug — so `runAndOpenOutput` re-runs rather than failing the
// assertion (issue #383). Parse and check the TOP-LEVEL status_code only: a
// 5xx echoed inside the response body (`result`) or a `redirection_history`
// entry must NOT trigger a retry. No test under this spec expects a 5xx, so
// retrying on the component's own 5xx is always safe.
function isTransientOutput(output: string): boolean {
  try {
    const code = Number(
      (JSON.parse(output) as { status_code?: unknown }).status_code,
    );
    return Number.isInteger(code) && code >= 500 && code <= 599;
  } catch {
    // Output was not parseable JSON (the component always emits a JSON Data
    // object here, so this is not expected). We cannot confirm a TOP-LEVEL 5xx
    // without parsing, and a regex would also match a 5xx nested in the body —
    // violating the top-level-only contract — so do not retry.
    return false;
  }
}

// The output dialog and a Radix popover both render `role="dialog"` into
// body-level portals (see tableDialog), so scope to the dialog that actually
// holds the output copy button — an unscoped locator is non-deterministic.
function outputDialog(page: Page): Locator {
  return page
    .locator('[role="dialog"]')
    .filter({ has: page.getByTestId("copy-output-button") });
}

// Close the output dialog between runs and assert it actually closed, so a
// stuck-open dialog surfaces here instead of as an obscured-click timeout on
// the next run.
async function closeOutputDialog(page: Page): Promise<void> {
  const dialog = outputDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 5000 });
}

async function runOnce(page: Page): Promise<string> {
  const inspectButton = page.getByTestId(
    "output-inspection-api response-apirequest",
  );
  const durationBadge = page.getByTestId("node_duration_api request");

  await page.getByTestId("button_run_api request").click();
  await expect(durationBadge).toBeHidden();
  await expect(durationBadge).toBeVisible({ timeout: 45000 });
  await expect(inspectButton).toBeEnabled({ timeout: 45000 });

  await inspectButton.click();
  const dialog = outputDialog(page);
  await expect(dialog).toBeVisible({ timeout: 10000 });

  const copyButton = dialog.getByTestId("copy-output-button");
  await expect(copyButton).toBeVisible({ timeout: 10000 });

  // Clear the clipboard first: it persists across the serial tests, so without
  // this the poll below could return a previous test's output immediately
  // (length > 0) before the fresh copy lands. Then click copy and poll rather
  // than waiting on the transient "Copied to clipboard" toast, which can fade
  // before the assertion runs — re-click and re-read until the output lands.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  let clipboard = "";
  await expect(async () => {
    await copyButton.click();
    clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.length).toBeGreaterThan(0);
  }).toPass({ timeout: 15000 });
  return clipboard;
}

// Helper: run the component and return its output, retrying past transient
// upstream 5xx outages and runs that produce no readable output (build error /
// timeout). This decouples the suite from the echo service's intermittent
// availability without masking a real Langflow regression — a persistent
// failure exhausts the retries and the caller's assertion reports the actual
// content (issue #383).
async function runAndOpenOutput(page: Page): Promise<string> {
  const maxAttempts = 3;
  let output = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      output = await runOnce(page);
    } catch (error) {
      // No readable output (build error / timeout). Re-run unless this was the
      // last attempt, in which case surface the original failure. Best-effort
      // close here — we are already in a degraded state.
      if (attempt === maxAttempts) throw error;
      await closeOutputDialog(page).catch(() => {});
      continue;
    }
    if (!isTransientOutput(output)) {
      return output;
    }
    // Still a transient upstream 5xx. Fail LOUDLY once retries are exhausted
    // rather than returning the 5xx body: the caller's substring assertions
    // (e.g. toContain("200")) are too weak to reliably distinguish a 5xx Data
    // blob from a 200 one, so returning it could let a sustained outage — or a
    // real regression that surfaces as a 5xx — pass silently (issue #383).
    if (attempt === maxAttempts) {
      throw new Error(
        `API Request returned a transient upstream 5xx on all ${maxAttempts} ` +
          `attempts (sustained outage or a regression surfacing as 5xx). ` +
          `Last output: ${output.slice(0, 500)}`,
      );
    }
    // Close the dialog and re-run the component.
    await closeOutputDialog(page);
  }
  // Unreachable: the final attempt always returns or throws above.
  return output;
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

test("API Request component — renders on canvas with correct output and URL handles",
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

test("API Request component — inspector fields accept configured values",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // URL field — testid: popover-anchor-input-url_input
    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    await urlInput.fill(`${ECHO_BASE}/get`);
    await expect(urlInput).toHaveValue(`${ECHO_BASE}/get`);

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

test("API Request component — invalid URL is accepted by field and run shows error notification",
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

    // An error notification must surface on run. The header wording is volatile
    // across Langflow versions — "Error building Component API Request:" (≤1.10)
    // became "Flow build failed" (1.11+) — so match either rather than a single
    // literal. The URL-specific detail below is the meaningful assertion.
    await expect(
      page.getByText(/error building component|flow build failed/i).first(),
    ).toBeVisible({ timeout: 30000 });

    // Must be specifically a URL validation error — this proves the invalid URL
    // was rejected on run rather than silently accepted (the actual regression
    // this test guards). Regex tolerates surrounding header/format changes.
    await expect(page.getByText(/invalid url/i).first()).toBeVisible();

    // Run button must still be visible after the error
    await expect(page.getByTestId("button_run_api request")).toBeVisible();
  },
);

// =============================================================================
// Execution / Output tests — verify HTTP behavior and output Data structure
// =============================================================================

// @stable restored (#462): the daily workflow now self-hosts a go-httpbin
// service and points ECHO_BASE_URL at its container IP, so this no longer
// depends on the public postman-echo endpoint that hard-failed the suite on
// external outages (daily 2026-07-01, weekly 2026-06-22).
test("API Request component — GET request returns 200 and output Data contains all required fields",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    await urlInput.fill(`${ECHO_BASE}/get`);

    const output = await runAndOpenOutput(page);

    // HTTP response fields
    expect(output).toContain("200");
    expect(output).toContain(ECHO_HOST);

    // Structural fields always present in Data output regardless of response content —
    // verifying all at once protects against regressions in make_request() output structure
    expect(output).toContain("source");
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    // /get echoes the request URL inside `result`
    expect(output).toContain('"url"');

    await page.keyboard.press("Escape");
  },
);

test("API Request component — POST method executes POST verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /post only accepts POST — returns 405 for any other method
    await urlInput.fill(`${ECHO_BASE}/post`);

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("POST", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("POST");

    const output = await runAndOpenOutput(page);

    // A successful POST to /post returns 200 and echoes the request URL
    expect(output).toContain("200");
    expect(output).toContain(`${ECHO_HOST}/post`);

    await page.keyboard.press("Escape");
  },
);

test("API Request component — PUT method executes PUT verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /put only accepts PUT — returns 405 for any other method
    await urlInput.fill(`${ECHO_BASE}/put`);

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("PUT", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("PUT");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain(`${ECHO_HOST}/put`);
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — PATCH method executes PATCH verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /patch only accepts PATCH — returns 405 for any other method
    await urlInput.fill(`${ECHO_BASE}/patch`);

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("PATCH", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("PATCH");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain(`${ECHO_HOST}/patch`);
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — DELETE method executes DELETE verb and returns 200",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /delete only accepts DELETE — returns 405 for any other method
    await urlInput.fill(`${ECHO_BASE}/delete`);

    const methodDropdown = page.getByTestId("dropdown_str_method");
    await expect(methodDropdown).toBeVisible({ timeout: 10000 });
    await methodDropdown.click();
    await page.getByText("DELETE", { exact: true }).click();
    await expect(
      page.getByTestId("value-dropdown-dropdown_str_method"),
    ).toHaveText("DELETE");

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain(`${ECHO_HOST}/delete`);
    expect(output).toContain("status_code");
    expect(output).toContain("response_headers");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — non-2xx HTTP response propagates status_code without crashing",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /status/404 responds with HTTP 404.
    // The component must NOT raise an exception — it returns Data(data={"status_code": 404, ...}).
    await urlInput.fill(`${ECHO_BASE}/status/404`);

    const output = await runAndOpenOutput(page);

    // status_code must be 404, not 200 and not 500 (the error fallback)
    expect(output).toContain("404");
    expect(output).toContain("source");
    // Must NOT contain the error field (which only appears on httpx transport exceptions)
    expect(output).not.toContain('"error"');

    await page.keyboard.press("Escape");
  },
);

test("API Request component — query parameters embedded in URL are sent and echoed",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    const urlInput = page.getByTestId("popover-anchor-input-url_input");
    await expect(urlInput).toBeVisible({ timeout: 10000 });
    // /get echoes all query parameters in the `args` key of the response body
    await urlInput.fill(`${ECHO_BASE}/get?e2e_param=functional_test_value`);

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

// Quarantined for #1488 — same `Open table` trigger as
// parameters-panel-field-types.spec.ts:415.
test.fixme("API Request component — inspector headers table accepts key + value cell entries",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    await addTableFieldToBody(page, "headers");

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

test("API Request component — cURL tab switches mode and field accepts a cURL command",
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
    const curlCommand = `curl -X GET ${ECHO_BASE}/get -H 'Accept: application/json'`;
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

test("API Request component — cURL mode parses command, auto-fills URL, executes GET and returns 200",
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

    // Filling the cURL command triggers the parser, which re-renders the
    // component template via `POST /api/v1/custom_component/update`. Wait for that
    // round-trip so the parsed URL has been written into the field state before we
    // read it — otherwise switching tabs races the parse and the URL input mounts
    // empty.
    const curlRefresh = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/custom_component/update") &&
        r.request().method() === "POST",
      { timeout: 15000 },
    );
    await curlTextarea.fill(
      `curl -X GET ${ECHO_BASE}/get -H 'Accept: application/json'`,
    );
    await curlRefresh;

    // The cURL parser must auto-populate url_input with the URL extracted from the
    // command. dev46 unmounts the URL-tab input while the cURL tab is active, so
    // switch to the URL tab to observe the parsed value — this still proves the
    // parser ran (the cURL fill above is what populated it). Asserting it directly
    // is the precondition the run relies on (an empty URL would fail validation).
    await page.getByTestId("tab_0_url").click();
    // Selected by `data-testid`, never by DOM `id`: LE-2037 (langflow#14312)
    // scopes node-parameter DOM ids by nodeId (`<id>-<nodeId>`) while leaving
    // `data-testid` unscoped, so a DOM-`id` lookup here would silently resolve
    // to nothing on any build carrying that fix. `toHaveValue` also reports the
    // value it actually saw, where the `waitForFunction` this replaces could only
    // report a bare timeout.
    await expect(page.getByTestId("popover-anchor-input-url_input")).toHaveValue(
      `${ECHO_BASE}/get`,
      { timeout: 10000 },
    );

    // Switch back to the cURL tab so the run exercises the cURL-mode path.
    await page.getByTestId("tab_1_curl").click();

    const output = await runAndOpenOutput(page);

    expect(output).toContain("200");
    expect(output).toContain(ECHO_HOST);
    expect(output).toContain("status_code");
    expect(output).toContain("result");

    await page.keyboard.press("Escape");
  },
);

// Quarantined for #1488 — the same `Open table` trigger, on the sibling
// `body` field. It never ran on daily 2026-08-19 (the serial cascade behind
// the failure above skipped it); quarantining that test let it execute on
// PR #1491's impacted-specs lane, where it failed 3/3 on a healthy backend.
test.fixme("API Request component — body table accepts key + value cell entries when method is POST",
  { tag: ["@regression", "@components"] },
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

    // Body only appears in the inspector once the method is POST — add it to the
    // node body now so its table widget renders.
    await addTableFieldToBody(page, "body");

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

// Quarantined for #1488 — the same `Open table` trigger again, reached from
// the autosave-persistence path. Failed 3/3 on PR #1491's lane once :750 was
// quarantined and the serial cascade cleared.
test.fixme("API Request component — flow state persists in database after autosave (URL, method, headers)",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    const expectedUrl = `${ECHO_BASE}/get?persist=true`;
    const headerKey = "X-Persist-Header";
    const headerValue = "persisted-value";
    let flowId = "";

    await test.step("Configure URL, method and a header on a new flow", async () => {
      // `setupBlankFlow` created the flow, so its id is known up front — no need
      // to parse it back out of the route (which is what this step used to do
      // when the flow came from the `blank-flow` UI path, #1147). Assert the
      // editor really is on that flow: everything below is configured through
      // this page and then polled by id, so a mismatch would silently poll a
      // flow nobody edited.
      flowId = await addApiRequestComponent(page);
      expect(flowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(new URL(page.url()).pathname).toContain(`/flow/${flowId}`);

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

      // dev46: headers is an advanced field — add it to the node body so its
      // table widget renders (it also persists across the reload in step 3).
      await addTableFieldToBody(page, "headers");

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

        // After reload the headers field stays on the node body (it was added
        // there in step 1 and the add persisted), so `div-table_headers` renders
        // directly — no inspector action needed. Select the node first so the
        // canvas is focused on it.
        await page.locator(".react-flow__node").first().click();

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
