import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { type ApiVersion, selectApiVersion } from "../../../helpers/ui/select-api-version";

// Run this file's tests serially. All four open the same "Basic Prompting" template, each creating a
// fresh flow; running them in parallel within one worker pool makes the backend receive near-identical
// concurrent flow-creation requests, which intermittently 500s ("An internal error occurred while
// creating the flow"). Serializing removes that self-collision and keeps the run free of backend errors.
test.describe.configure({ mode: "serial" });

// Ids of flows created by THIS page's own requests, collected from the
// flow-creating POST responses and deleted one by one in afterEach. The
// previous diff-based cleanup (snapshot the list, delete the difference)
// deleted any flow a PARALLEL worker created during the test window — the
// cross-worker destructive-cleanup class from #553/#561; here it was the
// wiper that killed edit-flow-name's in-flight flows in the daily (#519).
// This also runs for tests that fail mid-way, so a flow created before an
// assertion failure is still swept.
let createdFlowIds: string[] = [];

const trackFlowCreations = (page: Page) => {
  page.on("response", async (resp) => {
    if (
      !resp.url().includes("/api/v1/flows") ||
      resp.request().method() !== "POST" ||
      !resp.ok()
    ) {
      return;
    }
    try {
      const body = await resp.json();
      const items = Array.isArray(body) ? body : (body?.flows ?? [body]);
      for (const item of items) {
        if (item?.id) createdFlowIds.push(item.id);
      }
    } catch {
      // Non-JSON response — nothing to track.
    }
  });
};

test.beforeEach(async ({ page }) => {
  createdFlowIds = [];
  trackFlowCreations(page);
});

test.afterEach(async ({ request }) => {
  const headers = { Authorization: await getAuthToken(request) };
  for (const id of createdFlowIds) {
    // Best-effort per-flow so one failure does not abort the sweep.
    await deleteFlow(request, id, { headers }).catch(() => {});
  }
  createdFlowIds = [];
});

// Opens the Basic Prompting template (matching curlApiGeneration / pythonApiGeneration), then opens
// the API access modal from the Publish dropdown on the requested API version. Returns the flow ID
// parsed from the editor URL.
//
// The version is selected explicitly because the default differs by release line (#2415): upstream
// #13508 made the modal open on v2 on release-1.14.0 (1.14.0.dev23+), while main and the 1.13 lines
// still open on v1. v1 renders one snippet (btn-copy-code) on /api/v1/run; v2 renders two steps
// (btn-copy-step1/2) on /api/v2/workflows. Tests 1-4 assert v1; Test 5 asserts v2.
//
// The flow ID is read only AFTER the modal is open: awaitBootstrapTest already leaves the page on a
// flow, and clicking the Basic Prompting heading then creates a *new* flow and navigates to it.
// Reading the URL right after the heading click races that navigation (the URL may still show the
// bootstrap flow), so we wait until the modal is rendered — by then the editor has fully settled on
// the template's flow and page.url() reflects it.
async function openApiAccessModal(page: import("@playwright/test").Page, apiVersion: ApiVersion) {
  await awaitBootstrapTest(page);
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();

  await page.getByTestId("publish-button").click();
  await page.getByTestId("api-access-item").click();
  await expect(page.getByTestId("api_tab_curl")).toBeVisible({
    timeout: 10000,
  });
  await selectApiVersion(page, apiVersion);

  // Editor URL pattern is /flow/{flowId}; read it now that the modal (and thus the flow) has settled
  expect(page.url()).toMatch(/\/flow\/[0-9a-f-]+/);
  return page.url().match(/\/flow\/([0-9a-f-]+)/)![1];
}

// Forces the cURL tab onto the macOS/Linux platform variant. getOS() seeds the default platform from
// navigator.platform, which differs between local Chromium and CI runners (Windows/PowerShell would
// otherwise be selected), so the generated snippet is non-deterministic without this — the same guard
// curlApiGeneration.spec.ts uses.
async function selectUnixCurlTab(page: import("@playwright/test").Page) {
  await page.getByTestId("api_tab_curl").click();
  await page.getByRole("tab", { name: "macOS/Linux" }).click();
}

test(
  "API access modal opens from the Publish dropdown exposing the Python, JavaScript and cURL tabs",
  { tag: ["@stable", "@regression", "@api", "@workspace"] },
  async ({ page }) => {
    await test.step("Open the API access modal from the Publish dropdown, on v1", async () => {
      await openApiAccessModal(page, "v1");
    });

    await test.step("Modal surface is rendered", async () => {
      // Scope to the dialog: the Publish dropdown's "API access" menu item is force-mounted and could
      // otherwise match the same exact text, so we anchor the title assertion inside the open modal.
      await expect(
        page.getByRole("dialog").getByText("API access", { exact: true }),
      ).toBeVisible({ timeout: 10000 });
      // dev49: the modal header entry point is the Endpoint Name button
      // (replaces the removed Input Schema / tweaks button).
      await expect(page.getByTestId("endpoint-name-button")).toBeVisible();
    });

    await test.step("The API version selector offers both v1 and v2", async () => {
      // Which one is the DEFAULT is deliberately not asserted: v2 on release-1.14.0, v1 on main
      // and the 1.13 lines (#2415). That both are offered holds on every line.
      await expect(page.getByTestId("api_version_v1")).toBeVisible();
      await expect(page.getByTestId("api_version_v2")).toBeVisible();
    });

    await test.step("All three language tabs are present", async () => {
      await expect(page.getByTestId("api_tab_python")).toBeVisible();
      await expect(page.getByTestId("api_tab_javascript")).toBeVisible();
      await expect(page.getByTestId("api_tab_curl")).toBeVisible();
    });

    await test.step("A copyable code snippet is shown", async () => {
      await expect(page.getByTestId("btn-copy-code")).toBeVisible();
    });
  },
);

test(
  "API access modal switches the displayed snippet when changing language tabs",
  { tag: ["@stable", "@regression", "@api", "@workspace"] },
  async ({ page }) => {
    await test.step("Open the API access modal on v1", async () => {
      await openApiAccessModal(page, "v1");
    });

    // Reading the clipboard after each tab's Copy click is the reliable way to capture what the
    // modal renders — the visible code is a tokenized SyntaxHighlighter tree, not a plain string.
    const copyVisibleSnippet = async () => {
      await page.getByTestId("btn-copy-code").click();
      return page.evaluate(() => navigator.clipboard.readText());
    };

    let pythonSnippet = "";
    let curlSnippet = "";

    await test.step("Python tab yields a requests snippet", async () => {
      await page.getByTestId("api_tab_python").click();
      pythonSnippet = await copyVisibleSnippet();
      expect(pythonSnippet).toMatch(/^import requests/);
    });

    await test.step("cURL tab (macOS/Linux) yields a curl command", async () => {
      await selectUnixCurlTab(page);
      curlSnippet = await copyVisibleSnippet();
      expect(curlSnippet).toMatch(/^curl --request POST/);
    });

    await test.step("Switching tabs changes the rendered snippet", async () => {
      expect(curlSnippet).not.toBe(pythonSnippet);
    });
  },
);

test(
  "API access modal embeds the current flow ID in the generated run endpoint URL",
  { tag: ["@stable", "@regression", "@api", "@workspace"] },
  async ({ page }) => {
    let flowId: string;

    await test.step("Open the API access modal on v1", async () => {
      flowId = await openApiAccessModal(page, "v1");
    });

    await test.step("Generated cURL command targets /api/v1/run/{currentFlowId}", async () => {
      await selectUnixCurlTab(page);
      await page.getByTestId("btn-copy-code").click();
      const snippet = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      // Assert we are reading the cURL snippet (not a stale Python one): both snippets embed the run
      // URL, so without this guard the tab selection above would be cosmetic and the test would pass
      // on any tab.
      expect(snippet).toMatch(/^curl --request POST/);
      // The endpoint must reference THIS flow, not just any UUID — that coherence with the open
      // flow is what the sibling curl/python specs (which only match `[0-9a-f-]{36}`) do not assert.
      expect(snippet).toContain(`/api/v1/run/${flowId!}`);
    });
  },
);

test(
  "API access modal closes cleanly via Escape and via the close button",
  { tag: ["@stable", "@regression", "@api", "@workspace"] },
  async ({ page }) => {
    await test.step("Open the API access modal on v1", async () => {
      await openApiAccessModal(page, "v1");
    });

    await test.step("Escape dismisses the modal", async () => {
      await expect(page.getByTestId("api_tab_curl")).toBeVisible({
        timeout: 10000,
      });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("api_tab_curl")).toBeHidden({
        timeout: 10000,
      });
    });

    await test.step("Reopen and dismiss via the close (X) button", async () => {
      await page.getByTestId("publish-button").click();
      await page.getByTestId("api-access-item").click();
      await expect(page.getByTestId("api_tab_curl")).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByTestId("api_tab_curl")).toBeHidden({
        timeout: 10000,
      });
    });
  },
);

test(
  "API access modal v2 offers a full-result and a streaming snippet bound to the open flow",
  { tag: ["@stable", "@regression", "@api", "@workspace"] },
  async ({ page }) => {
    let flowId: string;

    await test.step("Open the API access modal on v2", async () => {
      flowId = await openApiAccessModal(page, "v2");
    });

    await test.step("The Python tab renders exactly two steps", async () => {
      await page.getByTestId("api_tab_python").click();
      await expect(page.getByTestId("api-step-1")).toBeVisible();
      await expect(page.getByTestId("api-step-2")).toBeVisible();
      await expect(page.getByTestId("api-step-3")).toHaveCount(0);
    });

    const copyStep = async (n: number) => {
      await page.getByTestId(`btn-copy-step${n}`).click();
      return page.evaluate(() => navigator.clipboard.readText());
    };
    // The body is pretty-printed JSON, so `"flow_id": "<id>"` is one exact substring.
    const runsThisFlowOnV2 = (snippet: string) => {
      expect(snippet).toMatch(/url = "[^"]*\/api\/v2\/workflows"/);
      expect(snippet).toContain(`"flow_id": "${flowId!}"`);
    };

    await test.step("The full-result snippet (step 1) runs THIS flow on /api/v2/workflows", async () => {
      const snippet = await copyStep(1);
      runsThisFlowOnV2(snippet);
      expect(snippet).toContain('"input_value": "Hello"');
      // The full-result step must not be the streaming one: reading both from one copy
      // button would satisfy the URL and flow_id checks twice.
      expect(snippet).not.toContain('"mode": "stream"');
    });

    await test.step("The streaming snippet (step 2) runs the same flow as a stream", async () => {
      const snippet = await copyStep(2);
      runsThisFlowOnV2(snippet);
      expect(snippet).toContain('"mode": "stream"');
    });
  },
);
