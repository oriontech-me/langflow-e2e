import type { Page } from "@playwright/test";
import {
  expect,
  test,
  type PageWithErrorHooks,
} from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Playground execution on 1.11 runs through POST /api/v2/workflows (SSE), NOT
// the retired /api/v1/build/{id}/flow path — the mocks below intercept that
// endpoint. Confirmed live on 1.11.0.dev41: aborting it surfaces a persistent
// "Workflow run failed" / "Failed to fetch" entry in the notifications dropdown.
const WORKFLOWS_ENDPOINT = "**/api/v2/workflows";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach. awaitBootstrapTest runs
// first, so a bare page.url() capture races the bootstrap flow's stale id
// (#490/#681); the response ids are authoritative and worker-safe.
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

async function setupChatFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add ChatOutput first (hover → click add button)
  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 30000,
  });
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await page.waitForSelector('[data-testid="input_outputChat Output"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  // Add ChatInput via drag to a different position to avoid overlap
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await page.waitForSelector('[data-testid="input_outputChat Input"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Input")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  // Connect ChatInput source → ChatOutput target
  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();
}

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
      trackCreatedFlows(page);
      await setupChatFlow(page);
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

  // Quarantined for #1063 — recurrent flake (2026-07-21 / 07-29): the
  // error-feedback waitForSelector times out at 30 s.
  test.fixme(
    "executing flow with server error shows error feedback",
    { tag: ["@release", "@workspace", "@observability"] },
    async ({ page }) => {
      const hooks = page as PageWithErrorHooks;
      hooks.allowFlowErrors();
      // The mocked 5xx below is this test's own fixture, not a finding — declare
      // it so it stays out of the advisory error log (#1084).
      hooks.allowHttpErrors();
      trackCreatedFlows(page);
      await setupChatFlow(page);
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
      trackCreatedFlows(page);
      await setupChatFlow(page);
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
