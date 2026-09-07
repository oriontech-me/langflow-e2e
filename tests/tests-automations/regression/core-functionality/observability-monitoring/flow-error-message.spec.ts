import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Capture the created flow's id from POST /api/v1/flows 201 responses (Pattern
// A). Not page.url(): awaitBootstrapTest creates a competing bootstrap flow, so
// the canvas URL carries the stale bootstrap id (#681). Only ids this page
// created are captured, so cleanup stays parallel-safe.
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

// Quarantine LIFTED (#1504). It was quarantined at the triage of daily #1417 for
// the swallowed sidebar add — the click landed and no node was placed, so
// `button_run_api request` never entered the DOM (`element(s) not found`, not
// "present but not visible") on the 2026-07-16, 07-20 and 08-11 dailies.
//
// The add below is still a BARE fill + click rather than `addComponentFromSidebar`,
// and that is deliberate, not an omission. The product defect underneath was fixed
// upstream in langflow#14523: the affordance is `disabled` while the permission
// window is open, so a bare click now waits the window out via Playwright's
// actionability check instead of being discarded. That measurement — per build,
// `1.12.0.dev25` swallows and `1.12.0.dev30` lands — is in
// docs/upstream-bugs/UPSTREAM-BUG-sidebar-add-permission-gate-dead-window.md §9,
// which is also where four other bare call sites were decided against rewiring for
// the same reason. If this class returns, that decision is the first thing to
// revisit, and moving this add onto the helper is the repair.
//
// Re-validated for #1504 on nightly 1.13.0.dev5: 12/12 with three workers driving
// one backend, plus a force-fail on the "URL cannot be empty" assertion.
test(
  "a misconfigured flow surfaces an appropriate build-error message",
  { tag: ["@stable", "@release", "@components", "@observability"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    // The build failure below is intentional — without this the fixture's
    // flow-error monitor would fail the test on the backend error itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).allowFlowErrors();

    await awaitBootstrapTest(page);

    await test.step("open a blank flow", async () => {
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();
      await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("add an API Request component and leave the URL empty", async () => {
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("API Request");
      await expect(
        page.getByTestId("add-component-button-api-request"),
      ).toBeVisible({ timeout: 15000 });
      await page.getByTestId("add-component-button-api-request").click();
      await expect(page.getByTestId("button_run_api request")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("running the misconfigured flow surfaces the appropriate message", async () => {
      await page.getByTestId("button_run_api request").click();

      // Generic failure signal.
      await expect(page.getByText("Flow build failed")).toBeVisible({
        timeout: 15000,
      });
      // The distinctive, appropriate message: it names the exact problem
      // (the empty required field), not a generic failure. It renders in two
      // places — a transient alert toast (role=alert, auto-dismisses) and the
      // persistent inline error container on the failed build. `.first()`
      // targets whichever copy is present without racing the toast's fade
      // (scoping to role=alert flaked once the toast dismissed) and without a
      // strict-mode violation while both are on screen.
      await expect(
        page.getByText("URL cannot be empty").first(),
      ).toBeVisible({ timeout: 15000 });
    });
  },
);
