import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";

// Echo endpoint for every test in this file — same knob the rest of the suite
// uses (#383/#407/#462).
//
// No test may depend on a public third-party service: httpbin.org returned 5xx on
// three separate runs, which is why `@stable` was removed from the API Request
// tests (#383), why they were decoupled (#409), and why it recurred with
// postman-echo (#462). CI self-hosts a go-httpbin container and points
// `ECHO_BASE_URL` at its IP, so these calls never leave the runner's network.
// `/get`, `/post` and `/delay/{n}` — the only paths used here — exist on
// postman-echo, on go-httpbin and on httpbin.
//
// The `@release`-only tests below used to keep hardcoded httpbin.org URLs, on
// the reasoning that only the daily lane needed protecting. That line did not
// hold (#1128): PR #1133 lost three of these to an httpbin 504 while its own
// diff touched none of them, and the failure read as a product error rather than
// a third party being down. Every test in this file now goes through ECHO_BASE,
// and the self-hosted service is wired into pr-validation, nightly and manual as
// well as the daily. Retiring this legacy spec into the consolidated one is still
// tracked separately.
const ECHO_BASE = (
  process.env.ECHO_BASE_URL ??
  process.env.HTTPBIN_BASE_URL ??
  "https://postman-echo.com"
).replace(/\/$/, "");

// Target of the cURL-mode test. Named because it is asserted three times — in
// the parse waiter's response body, in the mounted URL field, and in the echoed
// output — and all three must agree for the assertion chain to mean anything.
//
// Resolved from ECHO_BASE like everything else in this file (#1128): the test
// runs the component, so this is a real outbound call, and the assertion chain
// includes the echoed `source` — which agrees with whatever host ECHO_BASE names.
const CURL_TARGET_URL = `${ECHO_BASE}/post`;

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
// Creations that FAILED, captured from the same listener (#1114).
//
// Two flows have to be created before this file's setup can do anything: the
// "New Flow" click inside `awaitBootstrapTest` navigates to a freshly-created
// flow (hence the welcome overlay it reconciles), and the `blank-flow` click
// creates a second one. When one of those POSTs answers 5xx, nothing fails at
// the POST — the fixture logs it and the run continues — and the visible symptom
// lands several steps later as an editor that mounted without a usable sidebar.
// The test then reports a hidden `sidebar-search-input`, which reads like a
// selector or product regression and is neither. Recording the failure here is
// what lets `addApiRequestComponent` point at it — see `withFlowCreationCause`
// for why it points rather than concludes.
//
// Reset in `beforeEach`, NOT drained in `afterEach`: the teardown returns early
// when no flow was created, which is exactly the case this array exists for.
const failedFlowCreations: string[] = [];

test.beforeEach(({ page }) => {
  failedFlowCreations.length = 0;
  page.on("response", (resp) => {
    if (resp.request().method() !== "POST") return;
    // The creation endpoint itself only — `/flows/batch/` and `/flows/upload/`
    // also answer 201, but with a list body that carries no top-level `id`.
    if (!/^\/api\/v1\/flows\/?$/.test(new URL(resp.url()).pathname)) return;
    if (resp.status() >= 400) {
      // Status only, recorded synchronously: the body is what the fixture
      // already prints on its `🚨 Backend Error` line, and reading it here would
      // land a tick later than the setup step that needs to consult this.
      failedFlowCreations.push(`${resp.status()} ${resp.statusText()}`);
      return;
    }
    if (resp.status() !== 201) return;
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

  // Record the failing state before the navigation below.
  //
  // This is NOT rescuing Playwright's own screenshot from the navigation —
  // measured on 1.58.2, `screenshot: only-on-failure` is captured before this
  // hook runs, and `test-failed-1.png` still shows the canvas with `about:blank`
  // navigated unconditionally. It is worth capturing anyway: the config sets
  // `screenshot` to `off` outside CI (playwright.config.ts), so locally this
  // attachment is the ONLY failure artifact, and the annotation puts the flow id
  // in the report where a reader does not have to dig for it.
  //
  // This runs BEFORE the "nothing to clean up" bail below, deliberately (#1114).
  // It used to sit after it, so the one scenario where the artifact matters most
  // — a test that failed precisely BECAUSE no flow was created — was the one
  // scenario that produced no screenshot and no annotation.
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

  // Nothing was created, so there is nothing to navigate away from or delete.
  if (createdFlowIds.length === 0) return;

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
// After this call the component node is on the canvas and selected, with its
// NON-advanced fields (url_input, method) rendered on the node body. Advanced
// fields are not on the body — see `addFieldToNodeBody` below.
async function addApiRequestComponent(page: Page) {
  try {
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("API Request");
    await expect(
      page.getByTestId("add-component-button-api-request"),
    ).toBeVisible({ timeout: 10000 });
    await page.getByTestId("add-component-button-api-request").click();
    // Wait for the URL field on the node body as the "component is mounted" signal
    await expect(
      page.getByTestId("popover-anchor-input-url_input"),
    ).toBeVisible({ timeout: 15000 });
  } catch (error) {
    // Every gate above depends on a flow having been created, so when one of the
    // creating POSTs failed the timeout that surfaces here names a symptom, not
    // the cause — measured, the sidebar input is present but HIDDEN, so the
    // report reads "waiting for sidebar-search-input" with 8 resolutions to a
    // hidden element and no mention of the 5xx three log lines up (#1114).
    throw withFlowCreationCause(error);
  }
}

// Prefix a setup failure with the flow creation that probably explains it,
// keeping the original message (and with it Playwright's call log) intact.
// Returns the error untouched when no creation failed — the setup can break for
// its own reasons, and this must not claim otherwise.
//
// Deliberately a HINT and not a verdict. An earlier draft asserted the flow was
// "never created", which is not something a failed POST proves: both
// `awaitBootstrapTest` and `openNewFlowTemplatesModal` retry, so a 500 can be
// absorbed and a later attempt can succeed. Measured at 5 workers — a run with 7
// creation 500s in which every test that actually failed did so on the echo
// endpoint, not on a missing flow. Claiming otherwise would have swapped one
// misattribution for another, which is the whole thing this is meant to fix.
function withFlowCreationCause(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  if (failedFlowCreations.length === 0) return original;
  // Aggregate by status with a count. `awaitBootstrapTest` retries the modal up
  // to 5 times and `openNewFlowTemplatesModal` re-clicks up to 3 times per
  // attempt, so one broken backend produces dozens of identical entries —
  // measured, 60 of them — and listing each is noise that buries the message.
  const counts = new Map<string, number>();
  for (const status of failedFlowCreations) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const summary = [...counts]
    .map(([status, n]) => (n > 1 ? `${status} ×${n}` : status))
    .join(", ");
  return new Error(
    `FLOW CREATION FAILED during this test's setup: POST /api/v1/flows/ ` +
      `answered ${summary}. Every step of this setup depends on an editor ` +
      `mounted over a real flow, so the failure quoted below is probably a SIDE ` +
      `EFFECT of that rather than a selector or product regression — the last ` +
      `time this was seen it surfaced as a HIDDEN \`sidebar-search-input\`, ` +
      `three log lines from its cause (#1114). Response bodies are on the ` +
      `"🚨 Backend Error" lines above.\n\n` +
      `Read this as a strong hint, NOT as proof: \`awaitBootstrapTest\` and ` +
      `\`openNewFlowTemplatesModal\` both retry, so a failed creation can be ` +
      `absorbed and a later attempt can succeed — measured, a run with 7 ` +
      `creation 500s where every actual failure was the echo endpoint's. Check ` +
      `the original failure below before concluding.\n\n` +
      `Locally the creation 5xx itself is write contention from concurrent ` +
      `creation (#1114): this file creates two flows per test, so at ` +
      `Playwright's default worker count ~10 land at once. It is green at 1–2 ` +
      `workers, which is what CI uses — re-run with \`--workers=2\`.\n\n` +
      `Original failure: ${original.message}`,
  );
}

// Move an ADVANCED parameter onto the node body so its widget can be driven
// (#1107). `timeout` and `include_httpx_metadata` are declared `advanced=True`
// upstream (`lfx/components/data_source/api_request.py`), and since the nightly
// replaced the "Controls" modal with the node inspector side-panel an advanced
// parameter has no widget anywhere until it is added to the body: the panel
// itself only MANAGES parameters (add / remove / expose-to-API rows), it does
// not edit their values. So `int_int_timeout` /
// `toggle_bool_include_httpx_metadata` simply do not exist in the DOM on a
// freshly added node — which is exactly how both tests below used to fail.
//
// Same pattern the sibling spec already uses for the headers/body tables
// (`core-components/api-request-component-regression.spec.ts` →
// `addTableFieldToBody`): select the node, open the inspector, click
// `inspector-add-<field>`, close the inspector. Kept local to this file rather
// than shared, mirroring that sibling.
//
// The post-condition is asserted here, not left to the caller: if the add
// silently no-ops, this fails naming the field instead of surfacing as an
// opaque timeout on the widget several lines later.
async function addFieldToNodeBody(
  page: Page,
  field: string,
  widgetTestId: string,
) {
  await page.getByTestId("title-API Request").click();
  await openAdvancedOptions(page);
  await page.getByTestId(`inspector-add-${field}`).click();
  await closeAdvancedOptions(page);
  await expect(page.getByTestId(widgetTestId)).toBeVisible({ timeout: 10000 });
}

// The output dialog and Radix popovers both render `role="dialog"` into
// body-level portals, so scope to the dialog that actually holds the output copy
// button — an unscoped locator is non-deterministic (same reasoning as the
// sibling spec's `outputDialog`).
function outputDialog(page: Page): Locator {
  return page
    .locator('[role="dialog"]')
    .filter({ has: page.getByTestId("copy-output-button") });
}

// Close the output dialog between run attempts and assert it actually closed, so
// a stuck-open dialog surfaces here instead of as an obscured-click timeout on
// the next run.
async function closeOutputDialog(page: Page): Promise<void> {
  const dialog = outputDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 5000 });
}

// Read the component's output Data as a PARSED object, from the open output
// dialog.
//
// Why not `textContent` of the editor: the output renders in a virtualized code
// editor, so only the visible lines exist in the DOM and the text is truncated
// — it cannot be parsed. The copy button yields the whole payload; this is the
// same mechanism the sibling spec's `runOnce` uses, and `playwright.config.ts`
// already grants the clipboard permissions it needs.
//
// Why parsed rather than substring matching: a substring cannot tell a
// TOP-LEVEL key from one nested inside the echoed response body. That is not
// hypothetical — it silently defused the `include_httpx_metadata` assertion
// below (#1107); see the comment there.
async function readOutputJson(page: Page): Promise<Record<string, unknown>> {
  const dialog = outputDialog(page);
  const copyButton = dialog.getByTestId("copy-output-button");
  await expect(copyButton).toBeVisible({ timeout: 10000 });
  // The clipboard persists across tests in a worker, so clear it first —
  // otherwise the poll below can return a previous test's output immediately.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  let clipboard = "";
  await expect(async () => {
    await copyButton.click();
    clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.length).toBeGreaterThan(0);
  }).toPass({ timeout: 15000 });
  try {
    return JSON.parse(clipboard) as Record<string, unknown>;
  } catch (error) {
    // The component always emits a JSON Data object here, so a parse failure
    // means the copy button yielded something else. Report WHAT it yielded — a
    // bare SyntaxError names neither the payload nor this helper.
    throw new Error(
      `The output dialog copied a payload that is not JSON: ` +
        `${(error as Error).message}. ` +
        `Payload (first 500 chars): ${clipboard.slice(0, 500)}`,
    );
  }
}

// Run the component, open its output and return the PARSED output Data, retrying
// past a transient failure of the echo service.
//
// Why the two `@stable` tests need this and the three `@release` ones do not:
// `daily-stable.yml` resolves `ECHO_BASE_URL` to a self-hosted go-httpbin, but
// that step is deliberately FAIL-SOFT — if the container never answers, the
// variable is left unset and the specs fall back to the PUBLIC postman-echo
// (`daily-stable.yml` → "Resolve go-httpbin endpoint"). On that path a public-
// endpoint blip lands straight on a test the daily reads as release signal,
// which is the exact failure mode that got `@stable` removed from the API
// Request tests in #383 and that recurred in #407/#462. The sibling spec absorbs
// it with `runAndOpenOutput`; without this these two are the only echo-dependent
// `@stable` tests in the suite with no such guard (#1107).
//
// `isTransient` is supplied per test rather than shared, because the two want
// opposite things from a `status_code: 500`: for the GET test any non-200 is a
// failed round-trip worth re-running, while for the timeout test a 500 carrying
// an `error` key IS the assertion target. A sustained outage exhausts the
// attempts and throws — it never returns a degraded output for the caller's
// assertions to interpret (#383's rule).
async function runAndReadOutput(
  page: Page,
  isTransient: (output: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const maxAttempts = 3;
  const durationBadge = page.getByTestId("node_duration_api request");
  // The signal for a build that hard-errored. Measured, not assumed: a URL the
  // backend rejects outright leaves the node with NO status testid at all —
  // neither `node_duration_api request` nor any `node_status_icon_*` — so there
  // is nothing on the node to wait for. What does render is the inline
  // "Flow build failed" container carrying the reason, which is the same generic
  // failure signal `observability-monitoring/flow-error-message.spec.ts` uses.
  // `.first()` because it renders in both a toast and the inline container.
  const buildFailed = page.getByText("Flow build failed").first();
  const inspectButton = page.getByTestId(
    "output-inspection-api response-apirequest",
  );
  let output: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.getByTestId("button_run_api request").click();
    // Gate on the duration badge going hidden→visible, not on the "built
    // successfully" toast: a toast left over from the previous attempt would let
    // this one proceed against stale state. The badge is re-created per run.
    await expect(durationBadge).toBeHidden();
    // Race the badge against the build-failure signal. A build that hard-errors
    // never produces a duration badge, so waiting on the badge alone burns the
    // whole 45 s and then reports `element(s) not found` — naming the badge
    // instead of the error.
    await expect(durationBadge.or(buildFailed)).toBeVisible({ timeout: 45000 });
    if (!(await durationBadge.isVisible())) {
      // Deliberately NOT retried: a hard build error is not a transient echo
      // failure, and re-running it three times only delays the same verdict.
      //
      // The reason renders next to the signal rather than inside it, so slice it
      // out of the page text instead of guessing at a container. It is worth the
      // reach: on a rejected URL this reports "SSRF Protection: DNS resolution
      // failed for …", i.e. the actual cause, in the message itself.
      const pageText = (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).replace(/\s+/g, " ");
      const start = pageText.indexOf("Flow build failed");
      throw new Error(
        `The API Request build FAILED on attempt ${attempt}, so the component ` +
          `produced no output Data to read. ` +
          (start >= 0
            ? `On screen: ${pageText.slice(start, start + 300)}`
            : `The failure signal was gone by the time it was read; see the trace.`),
      );
    }
    // Kept as an assertion in its own right: the component catches an HTTP
    // failure and returns an error Data object instead of raising, so even the
    // timeout path must report a successful build.
    await expect(page.getByText("built successfully").last()).toBeVisible();
    await expect(inspectButton).toBeEnabled({ timeout: 45000 });

    await inspectButton.click();
    await expect(outputDialog(page)).toBeVisible({ timeout: 10000 });
    output = await readOutputJson(page);

    if (!isTransient(output)) return output;
    if (attempt === maxAttempts) {
      throw new Error(
        `API Request produced a transient output on all ${maxAttempts} attempts ` +
          `(sustained echo-service outage, or a regression surfacing as one). ` +
          `Last output: ${JSON.stringify(output).slice(0, 500)}`,
      );
    }
    await closeOutputDialog(page);
  }
  // Unreachable: the final attempt always returns or throws above.
  return output;
}

// A 5xx that the component did NOT raise on: the two exception branches upstream
// (`api_request.py:381-388` / `:724-732`) always attach an `error` key, so a 5xx
// without one is the echo service's own response being echoed back — transient.
//
// Key PRESENCE, never truthiness: the branches set `error` to `str(exc)`, and
// httpx's timeout exceptions stringify to the EMPTY STRING — measured, by forcing
// a connect timeout through this very predicate (`error: ""` with
// `status_code: 500`). A `!output.error` here would therefore classify the
// component's own timeout — the thing the timeout test asserts — as a transient
// and burn all three attempts on it.
function isUpstreamServerError(output: Record<string, unknown>): boolean {
  const code = Number(output.status_code);
  return Number.isInteger(code) && code >= 500 && !("error" in output);
}

test("API Request component performs GET to httpbin and returns built successfully",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Configure the URL field (in the inspector panel on the right)
    await page.getByTestId("popover-anchor-input-url_input").fill(`${ECHO_BASE}/get`);

    // Run the component
    await page.getByTestId("button_run_api request").click();

    // Wait for execution to complete successfully
    await page.waitForSelector("text=built successfully", { timeout: 30000 });
    await expect(page.getByText("built successfully").last()).toBeVisible();

    // Open output and verify status 200
    await page.getByTestId("output-inspection-api response-apirequest").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await expect(page.locator('[role="dialog"]').getByText('"status_code": 200')).toBeVisible();
    await expect(page.locator('[role="dialog"]').getByText(`"source": "${ECHO_BASE}/get"`)).toBeVisible();
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

    // Read the output through the copy button, not the rendered editor (#1128).
    //
    // This used to scrape `textContent` off the virtualized code editor, on the
    // belief that `evaluate()` returns the whole document. It does not — only the
    // RENDERED lines are in the DOM. Measured while pointing this test at the
    // self-hosted go-httpbin: the textContent was 617 characters, cut off
    // mid-token inside `"Host": [`, with the echoed payload never in it. The
    // assertion had been passing only because httpbin.org's response happened to
    // be short enough for the payload to land inside the rendered window; the
    // same server's response formatted one line per header value pushed it out.
    // An assertion that depends on how much of a response fits on screen proves
    // nothing about whether the body was sent.
    //
    // `readOutputJson` copies the full output Data to the clipboard and parses
    // it, so this now reads the whole document regardless of rendering.
    const output = await readOutputJson(page);
    expect(output.status_code).toBe(200);
    expect(output.source).toBe(CURL_TARGET_URL);

    // Shape-agnostic on purpose: the echoed body lands under `json` on
    // httpbin/go-httpbin and under `data` on postman-echo, and ECHO_BASE may
    // point at any of the three. Serializing the echoed result and looking for
    // the payload tokens proves the cURL body round-tripped without pinning the
    // test to one echo server's response schema.
    const echoed = JSON.stringify(output.result ?? output);
    expect(echoed).toContain("langflow");
    expect(echoed).toContain("regression-test");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — include_httpx_metadata=true adds request headers to output",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    await page.getByTestId("popover-anchor-input-url_input").fill(`${ECHO_BASE}/get`);

    // Enable include_httpx_metadata toggle — adds outgoing request headers to output.
    // Advanced field: put it on the node body first (#1107).
    await addFieldToNodeBody(
      page,
      "include_httpx_metadata",
      "toggle_bool_include_httpx_metadata",
    );
    const httpxToggle = page.getByTestId("toggle_bool_include_httpx_metadata");
    // Assert the switch actually flips. Without this the causal link is
    // assumed: a click that no-ops would surface as the "headers" assertion
    // failing at the end, which reads as a product regression rather than as
    // the test failing to set the flag it is testing.
    await expect(httpxToggle).toHaveAttribute("aria-checked", "false");
    await httpxToggle.click();
    await expect(httpxToggle).toHaveAttribute("aria-checked", "true");

    // Any non-200 is a failed round-trip worth re-running: on the daily's
    // fail-soft path this test can be hitting the public echo endpoint, and a
    // blip there is not a Langflow regression. A sustained one still fails.
    const output = await runAndReadOutput(
      page,
      (o) => Number(o.status_code) !== 200,
    );

    // Assert on the PARSED output, not on a substring of the rendered text.
    //
    // `include_httpx_metadata=True` makes the component add the outgoing request
    // headers as a TOP-LEVEL `headers` key (`api_request.py` →
    // `metadata.update({"headers": headers})`). The base metadata is
    // `source` / `status_code` / `response_headers` / `result`, and `result`
    // carries the echo service's OWN `"headers"` object — so the previous
    // `toContain('"headers"')` on the editor text matched the echoed body and
    // passed with the flag OFF. Measured on 1.12.0.dev9 (#1107): top-level keys
    // are `[source, status_code, response_headers, result, headers]` with the
    // flag on versus `[source, status_code, response_headers, result]` with it
    // off, i.e. the key's presence at the top level is the flag's only
    // deterministic observable. Same trap the sibling spec documents for
    // `status_code` in `isTransientOutput`.
    expect(output.status_code).toBe(200);
    // The top-level `headers` key is flag-exclusive ONLY on the success path:
    // both exception branches upstream (`api_request.py:381-388` / `:724-732`)
    // attach `headers` UNCONDITIONALLY, whatever the flag is set to. The 200
    // above already excludes them (they hardcode 500), and asserting the absence
    // of `error` fences that off explicitly — so a later edit that reorders or
    // drops the status assertion cannot silently defuse the check below a second
    // time, the way the original `toContain('"headers"')` was defused (#1107).
    expect(output).not.toHaveProperty("error");
    expect(Object.keys(output)).toContain("headers");
    // Independent of the flag, and kept from the original assertion: Langflow
    // identifies itself to the endpoint (`User-Agent: Langflow/1.0`, the default
    // value of the component's `headers` table upstream), which the echo service
    // reflects back inside `result.headers`. Scoped to that object so it can no
    // longer be confused with the top-level metadata asserted above.
    //
    // Asserted as a stringify-substring rather than by reading the header key,
    // ON PURPOSE — the two endpoints this test can run against disagree on the
    // shape: postman-echo (the default) emits a lowercase key with a string
    // value, `{"user-agent": "Langflow/1.0"}`, while go-httpbin (what the daily
    // points `ECHO_BASE_URL` at) emits Go's canonical casing with array values,
    // `{"User-Agent": ["Langflow/1.0"]}`. A keyed read needs per-endpoint
    // normalization; the substring does not care. Do not "improve" this into
    // `headers["user-agent"]` — it would pass locally and fail only on CI.
    //
    // The presence check is separate so a changed echo shape reports as the
    // missing key it is, instead of as `"{}" does not contain "Langflow"`.
    const echoedHeaders = (output.result as { headers?: unknown } | undefined)
      ?.headers;
    expect(
      echoedHeaders,
      "the echo service returned no result.headers — its response shape changed",
    ).toBeDefined();
    expect(JSON.stringify(echoedHeaders)).toContain("Langflow");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — timeout error returns status_code 500 with error field",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    // Set a very short timeout (3s) and point at an endpoint that delays 5s —
    // the component should catch the exception and return status_code 500.
    // Advanced field: put it on the node body first (#1107).
    await addFieldToNodeBody(page, "timeout", "int_int_timeout");
    const timeoutField = page.getByTestId("int_int_timeout");
    await timeoutField.fill("3");
    await page.keyboard.press("Tab");
    // The whole test hinges on this value: with the upstream default (30s) the
    // delay below completes and the run returns 200, so a fill that did not land
    // would turn this into a false negative on the 500 assertion.
    await expect(timeoutField).toHaveValue("3");
    // 5s of delay against a 3s timeout, deliberately not 10s: `/delay/10` sits
    // exactly on go-httpbin's default `-max-duration` (10s), and the daily's
    // endpoint IS a go-httpbin. It passes today (the upstream check is
    // `delay > maxDuration`) but with zero margin — tighten that flag, or let the
    // image's default move, and the endpoint answers 400 instantly instead of
    // delaying, the run returns 200, and this test fails reading like a Langflow
    // regression. 5s clears the timeout by 2s and the cap by 5s.
    await page.getByTestId("popover-anchor-input-url_input").fill(`${ECHO_BASE}/delay/5`);

    // Retry only an upstream 5xx that the component did not raise on — a 500
    // carrying `error` is this test's target, not a transient (see
    // `isUpstreamServerError`). A 200 or a 400 is NOT retried either: those mean
    // the delay never happened, and that has to fail loudly.
    const output = await runAndReadOutput(page, isUpstreamServerError);

    // Parsed, for the same reason as the test above: `status_code` and `error`
    // must be asserted at the TOP LEVEL of the output Data. A substring match on
    // the rendered text would also accept them nested inside the echoed body —
    // which is how a sibling assertion in this file silently stopped testing its
    // feature (#1107). This is now `@stable`, so the daily reads it as release
    // signal and the assertion has to be exact.
    expect(output.status_code).toBe(500);
    expect(Object.keys(output)).toContain("error");

    await page.keyboard.press("Escape");
  },
);

test("API Request component — URL mode POST via method dropdown returns 200",
  { tag: ["@release", "@regression"] },
  async ({ page }) => {
    await addApiRequestComponent(page);

    await page.getByTestId("popover-anchor-input-url_input").fill(`${ECHO_BASE}/post`);

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
    await expect(dialog.getByText(`"source": "${ECHO_BASE}/post"`)).toBeVisible();

    await page.keyboard.press("Escape");
  },
);
