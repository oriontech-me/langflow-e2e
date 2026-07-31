import type { Page } from "@playwright/test";
import {
  expect,
  test,
  type PageWithErrorHooks,
} from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupPlayground } from "../../../helpers/flows/setup-playground";

// Playground execution on 1.11 runs through POST /api/v2/workflows (SSE), NOT
// the retired /api/v1/build/{id}/flow path — the mocks below intercept that
// endpoint. Confirmed live on 1.11.0.dev41: aborting it surfaces a persistent
// "Workflow run failed" / "Failed to fetch" entry in the notifications dropdown.
const WORKFLOWS_ENDPOINT = "**/api/v2/workflows";

// setupPlayground creates exactly ONE flow per test, over the API, and returns
// its id — so cleanup is id-scoped without intercepting POST /api/v1/flows.
//
// The local setupChatFlow this replaces entered through the home page → "New
// Flow" → templates modal → `blank-flow` path, which is what made this file
// flake (#1063): while the welcome overlay is open, FlowPage mounts the whole
// FlowSidebarComponent inside a `display: none` wrapper, so
// `sidebar-search-input` sits in the DOM with an empty box — exactly what
// Playwright reports as `hidden`. "New Flow" opens that overlay BEFORE
// navigating and "Browse more templates" does not close it, so the setup raced a
// multi-hop settle it did not drive. Creating the flow over the API never calls
// `openWelcome`, so the sidebar is never hidden. Full chain in the spec doc.
let createdFlowId: string | null = null;

test.afterEach(async ({ request }) => {
  if (!createdFlowId) return;
  const id = createdFlowId;
  createdFlowId = null;
  // Explicit bearer: under AUTO_LOGIN a bare request context is unauthenticated,
  // so an unheadered DELETE 401s and silently leaks the flow.
  const bearer = await getAuthToken(request);
  await deleteFlow(request, id, {
    headers: { Authorization: bearer },
  }).catch(() => {});
});

async function openPlayground(page: Page): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', {
    timeout: 30000,
  });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
}

test.describe("Execution Error Notifications", () => {
  test(
    "executing flow with network error shows error feedback",
    { tag: ["@stable", "@release", "@workspace", "@observability"] },
    async ({ page }) => {
      // The run is intercepted and aborted on purpose — allow the flow error.
      (page as any).allowFlowErrors();
      createdFlowId = await setupPlayground(page);
      await openPlayground(page);

      // Abort the execution request at the transport layer (dropped connection
      // / timeout). The browser reports this to fetch as "Failed to fetch".
      await page.route(WORKFLOWS_ENDPOINT, async (route) => {
        await route.abort("timedout");
      });

      await sendMessage(page, "network error test");

      // Assert against the PERSISTENT notifications dropdown, not the
      // auto-dismissing slide-in toast (toast-fade race — #695). The dropdown
      // entry distinguishes a transport failure ("Failed to fetch") from a
      // server-side failure (which carries the server's detail instead).
      await page.getByTestId("notification_button").click();
      const dropdown = page.getByTestId("notification-dropdown-content");
      await expect(dropdown).toBeVisible({ timeout: 15000 });
      await expect(dropdown).toContainText("Workflow run failed", {
        timeout: 15000,
      });
      await expect(dropdown).toContainText("Failed to fetch");
    },
  );

  // Quarantine lifted in #1063: the 30 s timeout was in the shared setup's
  // sidebar-entry wait, not in this test's error-feedback assertion. The setup
  // no longer walks through the welcome overlay, so the condition is gone.
  test(
    "executing flow with server error shows error feedback",
    { tag: ["@stable", "@release", "@workspace", "@observability"] },
    async ({ page }) => {
      const hooks = page as PageWithErrorHooks;
      hooks.allowFlowErrors();
      // The mocked 5xx below is this test's own fixture, not a finding — declare
      // it so it stays out of the advisory error log (#1084).
      hooks.allowHttpErrors();
      createdFlowId = await setupPlayground(page);
      await openPlayground(page);

      // Return a 5xx from the execution endpoint (server-side failure). 503 was
      // originally chosen to slip past the fixture's monitor, which only matched
      // 400/404/422/500 — that filter now covers every 4xx/5xx, so the evasion
      // no longer works and `allowHttpErrors()` above is what keeps the mocked
      // response out of the log (#1084). The status stays 503 because it drives
      // the same "Workflow run failed" path, live-confirmed on 1.11.0.dev41.
      await page.route(WORKFLOWS_ENDPOINT, async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Service unavailable",
          }),
        });
      });

      await sendMessage(page, "server error test");

      await page.getByTestId("notification_button").click();
      const dropdown = page.getByTestId("notification-dropdown-content");
      await expect(dropdown).toBeVisible({ timeout: 15000 });
      await expect(dropdown).toContainText("Workflow run failed", {
        timeout: 15000,
      });
    },
  );

  test(
    "flow run button shows loading state during execution",
    { tag: ["@release", "@workspace", "@observability"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);
      await openPlayground(page);

      // Hold the execution request open so the in-progress state is observable.
      // Never fulfilling keeps the run pending; the route is torn down after the
      // assertion so the test can finish.
      await page.route(WORKFLOWS_ENDPOINT, async () => {
        await new Promise<void>(() => {});
      });

      await sendMessage(page, "loading state test");

      // While the run is pending, the send button is replaced by a stop button.
      await expect(page.getByTestId("button-stop").last()).toBeVisible({
        timeout: 15000,
      });

      // Release the pending request so teardown (afterEach) is not blocked.
      await page.unroute(WORKFLOWS_ENDPOINT);
    },
  );
});
