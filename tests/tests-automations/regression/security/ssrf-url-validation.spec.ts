import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createApiRequestFlowViaApi } from "../../../helpers/flows/create-api-request-flow-via-api";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";

/**
 * SSRF allow-list round trip on a URL-fetching component (issue #1391).
 *
 * Spec doc: docs/security/ssrf-url-validation.md
 *
 * Langflow refuses a URL whose address falls in a blocked range unless
 * `LANGFLOW_SSRF_ALLOWED_HOSTS` covers it. Only the REFUSAL is observable
 * anywhere in this suite today, and always as a side effect of something else
 * (`agent-tool-error-handling` uses it as an error generator;
 * `api-request-component-regression` runs against a private `ECHO_BASE_URL`
 * without ever asserting why that address is reachable). The allow-list itself —
 * the mechanism `.github/actions/resolve-echo-endpoint` depends on — is asserted
 * nowhere, which is exactly the defect class upstream reported in
 * `langflow-ai/langflow#14264`: the guard was rewritten, the allow-list stopped
 * being consulted, and every operator pointing a component at a local service
 * lost it in a patch release.
 *
 * So this file asserts BOTH directions on the same instance, in the same
 * component, differing only in whether the address is allow-listed:
 *   - refused: loopback (Test 1) and the cloud-metadata address (Test 2), which
 *     no lane allow-lists;
 *   - admitted: the private RFC-1918 address `ECHO_BASE_URL` points at (Test 3),
 *     blocked by default and reachable only because a CIDR entry admits it.
 * Test 2 and Test 3 disagreeing on one instance is the round trip. Test 4 covers
 * the fourth bullet: the refusal reaches the user as an error, not as silence.
 */

// Serial: every test creates a flow through the same API and the file is short;
// running them in parallel buys nothing and adds name-collision surface (#588).
test.describe.configure({ mode: "serial" });

// A loopback address that WOULD answer 200 if the request were made — Langflow
// listens on 7860 inside its own container regardless of the published port — so
// a failure here can only be the guard, never "nothing listening". No lane
// allow-lists loopback, and none may: `agent-tool-error-handling.spec.ts` uses an
// SSRF-blocked loopback fetch as its deterministic error generator.
const LOOPBACK_URL = "http://127.0.0.1:7860/api/v1/version";

// The canonical SSRF target (AWS/GCP/Azure instance metadata). It sits in the
// blocked link-local range 169.254.0.0/16 and is allow-listed by NO lane, so it
// stays refused on the very instance where Test 3's private address goes
// through — which is what makes Test 3's 200 attributable to the allow-list.
const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

// The echo endpoint each CI lane self-hosts; `resolve-echo-endpoint` sets this to
// the go-httpbin CONTAINER IP (a private RFC-1918 address), which the lane's
// `LANGFLOW_SSRF_ALLOWED_HOSTS` CIDRs admit. Unset (or public) means the accept
// arm has nothing to prove — see `privateEchoUrl()`.
const ECHO_BASE = (
  process.env.ECHO_BASE_URL ??
  process.env.HTTPBIN_BASE_URL ??
  ""
).replace(/\/$/, "");

/**
 * The ranges `lfx/utils/ssrf_protection.py` blocks by default and that a lane may
 * allow-list. Only these prove anything: a PUBLIC echo host is reachable with or
 * without an allow-list, so asserting a 200 against it would pass on an instance
 * that ignores `LANGFLOW_SSRF_ALLOWED_HOSTS` entirely.
 *
 * Deliberately wider than `isPrivateIpv4` in `scripts/resolve-echo-endpoint.mjs`,
 * which answers a different question (may this endpoint need the allow-list?) and
 * covers RFC-1918 only. Here the question is whether a 200 is attributable to the
 * allow-list, which is true for every range the guard blocks by default.
 */
function isBlockedRangeIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host ?? "");
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 (loopback)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local / metadata)
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 (CGNAT)
  );
}

/** `${ECHO_BASE}/get` when the echo host is an address the guard blocks by default. */
function privateEchoUrl(): { url: string } | { skipReason: string } {
  if (!ECHO_BASE) {
    return {
      skipReason:
        "ECHO_BASE_URL/HTTPBIN_BASE_URL is unset, so there is no private endpoint whose " +
        "reachability could only come from LANGFLOW_SSRF_ALLOWED_HOSTS. Every CI lane sets it " +
        "via .github/actions/resolve-echo-endpoint; locally see docs/security/ssrf-url-validation.md.",
    };
  }
  let host: string;
  try {
    host = new URL(ECHO_BASE).hostname;
  } catch {
    return { skipReason: `ECHO_BASE_URL is not a URL: ${ECHO_BASE}` };
  }
  if (!isBlockedRangeIpv4(host)) {
    return {
      skipReason:
        `the echo endpoint resolved to ${ECHO_BASE}, whose host is not an address Langflow blocks ` +
        "by default (a public host, or a name rather than an IP). Reaching it proves nothing about " +
        "the allow-list, so this test would be vacuous rather than green.",
    };
  }
  return { url: `${ECHO_BASE}/get` };
}

/** The component's own result object inside a `POST /api/v1/run/{id}` response. */
interface ApiRequestResult {
  source?: string;
  status_code?: number;
  [key: string]: unknown;
}

/**
 * Digs the API Request node's result out of a run response. Measured shape on
 * 1.12.0.dev23/dev24: `outputs[0].outputs[0].artifacts.data.raw`. Throws with the
 * body when the shape moves, so an upstream change to the run payload reports
 * itself instead of surfacing as `undefined !== 200`.
 */
function apiRequestResult(body: unknown): ApiRequestResult {
  const outer = (body as { outputs?: { outputs?: unknown[] }[] })?.outputs?.[0];
  const inner = outer?.outputs?.[0] as
    | { artifacts?: { data?: { raw?: ApiRequestResult } } }
    | undefined;
  const raw = inner?.artifacts?.data?.raw;
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "the run response carries no API Request result at " +
        `outputs[0].outputs[0].artifacts.data.raw — body: ${JSON.stringify(body).slice(0, 600)}`,
    );
  }
  return raw;
}

let bearer: string;
let apiKey: string;
let apiKeyId: string;

// Every flow this file creates is pushed here and deleted id-scoped in
// afterEach (repo convention, #490/#681/#1108).
const createdFlows: { id: string; delete: (req: APIRequestContext) => Promise<void> }[] = [];

test.beforeAll(async ({ request }) => {
  bearer = await getAuthToken(request);
  // POST /api/v1/run/{id} authenticates with x-api-key, not Bearer.
  const keyRes = await request.post("/api/v1/api_key/", {
    headers: { Authorization: bearer },
    data: { name: `ssrf-url-validation-${Date.now()}` },
  });
  expect(keyRes.status(), await keyRes.text()).toBe(200);
  const keyBody = (await keyRes.json()) as { id: string; api_key: string };
  apiKey = keyBody.api_key;
  apiKeyId = keyBody.id;
});

test.afterEach(async ({ request }) => {
  for (const flow of createdFlows.splice(0)) {
    await flow.delete(request).catch(() => {});
  }
});

test.afterAll(async ({ request }) => {
  if (!apiKeyId) return;
  await request
    .delete(`/api/v1/api_key/${apiKeyId}`, { headers: { Authorization: bearer } })
    .catch(() => {});
});

/** Creates the single-node API Request flow for `url` and registers its cleanup. */
async function createFlowFor(
  request: APIRequestContext,
  url: string,
): Promise<string> {
  const flow = await createApiRequestFlowViaApi(
    request,
    { Authorization: bearer },
    { url },
  );
  createdFlows.push({ id: flow.flowId, delete: flow.deleteFlow });
  return flow.flowId;
}

/** Runs a flow through the endpoint an API client uses. */
async function runFlow(
  request: APIRequestContext,
  flowId: string,
): Promise<APIResponse> {
  return request.post(`/api/v1/run/${flowId}?stream=false`, {
    headers: { "x-api-key": apiKey },
    data: { input_type: "text", output_type: "debug", input_value: "run" },
    // Explicit, well above `actionTimeout` (20 s): the FIRST component build
    // after a container start pays the registry/import cost and was measured at
    // ~60 s on a cold local instance, while every later run answers in ~4 s. On
    // the default timeout that cold start reads as "the run never answered",
    // i.e. an unattributable red on whichever test happens to run first — and CI
    // starts a fresh Langflow for every lane. This bounds the transport, not the
    // verdict: the assertions on the response are unchanged.
    timeout: 120_000,
  });
}

/**
 * Both refusal tests assert the same two-part verdict: the guard's own message
 * (not a generic build failure) AND that nothing was fetched. A single
 * "the run failed" assertion would also pass on a broken flow, a missing
 * component or an auth error.
 */
async function expectSsrfRefusal(
  response: APIResponse,
  url: string,
): Promise<void> {
  const body = await response.text();
  expect(
    response.status(),
    `expected ${url} to be refused by the SSRF guard; body: ${body.slice(0, 400)}`,
  ).toBe(500);
  expect(body).toMatch(/SSRF Protection/);
  // The message must name the escape hatch — that is what tells an operator the
  // allow-list exists at all, and it is the string #14264 is about.
  expect(body).toMatch(/LANGFLOW_SSRF_ALLOWED_HOSTS/);
  // Nothing was fetched: no component result, so no status code came back.
  expect(body).not.toMatch(/"status_code":\s*\d/);
}

test.describe("SSRF URL validation — allow-list round trip", () => {
  test("a loopback address is refused, and the refusal names the allow-list",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      let flowId = "";
      await test.step("create a flow whose API Request targets loopback", async () => {
        flowId = await createFlowFor(request, LOOPBACK_URL);
      });

      await test.step("running it is refused by the SSRF guard", async () => {
        await expectSsrfRefusal(await runFlow(request, flowId), LOOPBACK_URL);
      });
    },
  );

  test("a blocked address the allow-list does not cover is refused the same way",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      let flowId = "";
      await test.step("create a flow targeting the cloud-metadata endpoint", async () => {
        flowId = await createFlowFor(request, METADATA_URL);
      });

      // The control for the next test: on THIS instance a blocked-range address
      // that is not allow-listed stays blocked, so the next test's 200 can only
      // come from the allow-list.
      await test.step("running it is refused by the SSRF guard", async () => {
        await expectSsrfRefusal(await runFlow(request, flowId), METADATA_URL);
      });
    },
  );

  test("an address inside a blocked range is admitted when a CIDR entry covers it",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const echo = privateEchoUrl();
      test.skip(
        "skipReason" in echo,
        "skipReason" in echo ? echo.skipReason : "",
      );
      const url = (echo as { url: string }).url;

      let flowId = "";
      await test.step(`create a flow targeting the allow-listed private endpoint ${url}`, async () => {
        flowId = await createFlowFor(request, url);
      });

      await test.step("the request goes through and comes back", async () => {
        const response = await runFlow(request, flowId);
        const body = await response.text();
        expect(
          response.status(),
          `expected ${url} to be admitted by LANGFLOW_SSRF_ALLOWED_HOSTS; body: ${body.slice(0, 400)}`,
        ).toBe(200);
        // Not merely "no error": the component fetched the URL the test chose and
        // the endpoint answered 200.
        const result = apiRequestResult(JSON.parse(body));
        expect(result.status_code).toBe(200);
        expect(result.source).toBe(url);
        expect(body).not.toMatch(/SSRF Protection/);
      });
    },
  );

  test("the refusal surfaces in the editor as an error, not a silent empty result",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page, request }) => {
      // The run is MEANT to fail: declare both so the fixture's advisory logs stay
      // trustworthy for every other spec (#1084/#1162).
      (page as any).allowFlowErrors();
      (page as any).allowHttpErrors();

      let flowId = "";
      await test.step("open a flow whose API Request targets loopback", async () => {
        // Created over the API and opened by id rather than added from the
        // sidebar: the sidebar add silently drops the click under contention
        // (#1301), and component insertion is already covered by
        // core-components/api-request-component-regression.spec.ts.
        flowId = await createFlowFor(request, LOOPBACK_URL);
        await openFlowById(page, flowId);
        await expect(page.getByTestId("title-API Request")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("running the component raises a visible error", async () => {
        await page.getByTestId("button_run_api request").click();
        // 60 s rather than the default: same cold-start cost as the API tests
        // (first build after a container start), and the banner is what proves
        // the user was told — timing out here would report "no error surfaced"
        // for a run that had not finished yet.

        // The build-failure banner. Its header wording is volatile across
        // versions ("Error building Component …" ≤1.10, "Flow build failed"
        // 1.11+), so match either; the banner carries no data-testid, which is
        // why the flow name must not contain the token asserted below (the
        // helper keeps it out).
        await expect(
          page.getByText(/flow build failed|error building component/i).first(),
        ).toBeVisible({ timeout: 60000 });

        // The meaningful half: the user is told the cause, not just that
        // something failed.
        await expect(page.getByText(/SSRF Protection/).first()).toBeVisible();
      });

      await test.step("the node produced no output to inspect", async () => {
        // A silent empty result would leave this enabled with an empty payload —
        // the failure mode the checklist bullet is about.
        await expect(
          page.getByTestId("output-inspection-api response-apirequest"),
        ).toBeDisabled();
      });
    },
  );
});
