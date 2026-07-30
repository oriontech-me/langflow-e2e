import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

// Target of the cURL-mode test. Named because it is asserted three times — in
// the parse waiter's response body, in the mounted URL field, and in the echoed
// output — and all three must agree for the assertion chain to mean anything.
//
// Still httpbin.org, like the rest of this file: the migration to the
// `ECHO_BASE_URL` knob the rest of the suite uses (#383/#407) is pre-existing
// debt tracked separately, not part of this change.
const CURL_TARGET_URL = "https://httpbin.org/post";

// Capture every flow each test's page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach (repo convention, #490/#681).
// Both flow-creating steps here — `awaitBootstrapTest` and the `blank-flow`
// click — POST their own flow, so neither `page.url()` nor a single
// `waitForResponse` identifies the right one; the accumulator captures both.
// Never a name-scoped or delete-all cleanup: that wipes flows other parallel
// workers are actively driving (#553).
const createdFlowIds: string[] = [];
// Each capture reads a response body asynchronously, so the id lands in the
// array a tick later. Hold those reads and settle them before cleaning up —
// otherwise a body that resolves after `afterEach` starts is dropped and its
// flow leaks for good (the last test in a worker has no later hook to sweep it).
const pendingCaptures: Promise<void>[] = [];

test.beforeEach(({ page }) => {
  page.on("response", (resp) => {
    if (resp.request().method() !== "POST" || resp.status() !== 201) return;
    // The creation endpoint itself only — `/flows/batch/` and `/flows/upload/`
    // also answer 201, but with a list body that carries no top-level `id`.
    if (!/^\/api\/v1\/flows\/?$/.test(new URL(resp.url()).pathname)) return;
    pendingCaptures.push(
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}),
    );
  });
});

test.afterEach(async ({ page, request }, testInfo) => {
  await Promise.allSettled(pendingCaptures.splice(0));
  if (createdFlowIds.length === 0) return;

  // Record the failing state before the navigation below.
  //
  // This is NOT rescuing Playwright's own screenshot from the navigation —
  // measured on 1.58.2, `screenshot: only-on-failure` is captured before this
  // hook runs, and `test-failed-1.png` still shows the canvas with `about:blank`
  // navigated unconditionally. It is worth capturing anyway: the config sets
  // `screenshot` to `off` outside CI (playwright.config.ts), so locally this
  // attachment is the ONLY failure artifact, and the annotation puts the flow id
  // in the report where a reader does not have to dig for it.
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      testInfo.annotations.push({
        type: "url-at-teardown",
        description: page.url(),
      });
      await testInfo.attach("page-at-teardown", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } catch {
      // The page may already be gone — the cleanup below is what matters.
    }
  }

  // Take the page off the flow canvas BEFORE deleting anything, unconditionally
  // — same shape as the folder specs (#1023/#1103), which is where the rationale
  // is documented in full: an editor left mounted over a flow that is being
  // deleted keeps asking for it and 404s, the fixture logs each one as
  // `🚨 Backend Error`, and the deterministic pipeline's VALIDATE gate hard-stops
  // on those.
  //
  // Honest scope for THIS file: that 404 does not currently reproduce here. A
  // probe forcing a failure after the component run — editor mounted, flow
  // deleted underneath it — logged zero backend errors either way, because the
  // build's event stream is already closed by then. So this is defensive and
  // consistent with the rest of the suite, not a fix for observed noise.
  // `about:blank` rather than `/` so the teardown adds no backend traffic of its
  // own.
  await page.goto("about:blank").catch(() => {});

  // `page.request` carries only browser cookies, so the flows API answers 401 —
  // pass the bearer token explicitly.
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // `deleteFlow` throws on purpose so a failed cleanup is visible (it already
    // absorbs 404-as-done and one transient 5xx). Don't let that failure fail an
    // otherwise-green test, but never silently swallow it either: a 401/403/422
    // here means the leak this cleanup exists to prevent is back.
    await deleteFlow(
      request,
      id,
      bearer ? { headers: { Authorization: bearer } } : undefined,
    ).catch((error: unknown) => {
      console.warn(
        `⚠️  cleanup: flow ${id} was NOT deleted — ${
          (error as Error)?.message?.split("\n")[0] ?? error
        }`,
      );
    });
  }
});

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

test("API Request component performs GET to httpbin and returns built successfully",
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

test("API Request component — cURL mode POST with JSON body",
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

    // Fill cURL command with POST + JSON body.
    //
    // Filling the cURL command triggers the parser, which re-renders the
    // component template via `POST /api/v1/custom_component/update`. Gate on
    // that response actually carrying the PARSED url_input, not merely on "an
    // update happened": the `tab_1_curl` click above fires its own update for
    // the `mode` field (declared `real_time_refresh`), and that one answers with
    // url_input still empty. A waiter matching any update can resolve on the
    // mode response instead, and the `tab_0_url` click below — which shares the
    // same per-node debounce key — would then cancel the still-pending parse,
    // leaving the field permanently empty. Measured on 1.11.1: update #1 (mode)
    // returns `url_input: ""`, update #2 (parse) returns the URL.
    const curlParsed = page.waitForResponse(
      async (r) => {
        if (
          !r.url().includes("/api/v1/custom_component/update") ||
          r.request().method() !== "POST"
        ) {
          return false;
        }
        try {
          const body = (await r.json()) as {
            template?: { url_input?: { value?: string } };
          };
          return body?.template?.url_input?.value === CURL_TARGET_URL;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    );
    await page.getByTestId("textarea_str_curl_input").click();
    await page.getByTestId("textarea_str_curl_input").fill(
      `curl -X POST ${CURL_TARGET_URL} -H "Content-Type: application/json" -d '{"langflow": "regression-test", "status": "ok"}'`,
    );
    await curlParsed;

    // The parser must have auto-populated url_input from the command — an empty
    // URL would fail backend validation on the run below.
    //
    // The URL input is only mounted while the URL tab is active (the cURL tab
    // unmounts it), so switch tabs to observe the parsed value. This still
    // proves the parser ran: the cURL fill above is what populated the field.
    await page.getByTestId("tab_0_url").click();
    // Selected by `data-testid`, never by DOM `id` — see LE-2037 /
    // langflow#14312: node-parameter DOM ids are scoped by nodeId
    // (`<id>-<nodeId>`), `data-testid` is not, so a DOM-`id` lookup here would
    // silently resolve to nothing on any build carrying that fix.
    await expect(page.getByTestId("popover-anchor-input-url_input")).toHaveValue(
      CURL_TARGET_URL,
      { timeout: 10000 },
    );

    // Deliberately NOT switching back to the cURL tab before running. The
    // backend's `make_api_request` reads url_input / method / headers / body;
    // `mode` and `curl_input` are consumed only by `update_build_config` at
    // design time, so the run is identical in either tab and the switch would
    // add no coverage. It would add a `real_time_refresh` round-trip for `mode`,
    // debounced ~300 ms per node — i.e. one landing around the moment the run
    // starts, re-parsing the template mid-build for nothing. What proves cURL
    // mode here is that the parse populated these fields, which the assertion
    // above and the echoed output below both confirm.

    // Run the component
    await page.getByTestId("button_run_api request").click();

    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output and validate the JSON body was sent and echoed back
    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('"status_code": 200')).toBeVisible();
    await expect(
      dialog.getByText(`"source": "${CURL_TARGET_URL}"`),
    ).toBeVisible();

    // The output is rendered in a virtualized code editor — only visible lines appear in the DOM,
    // and JSON string values display with escaped quotes (e.g. \"langflow\").
    // Use evaluate() to get the full textContent and search for the payload tokens unquoted.
    const editorContent = await dialog.locator("[role='textbox']").evaluate((el) => el.textContent ?? "");
    expect(editorContent).toContain("langflow");
    expect(editorContent).toContain("regression-test");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — include_httpx_metadata=true adds request headers to output",
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

test("API Request component — timeout error returns status_code 500 with error field",
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

test("API Request component — URL mode POST via method dropdown returns 200",
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
