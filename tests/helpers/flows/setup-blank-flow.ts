import { Page, expect } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { createFlow } from "./create-flow";
import { deleteFlow } from "./delete-flow";

/**
 * Creates a new blank flow via the REST API and navigates to it through the
 * dashboard.
 *
 * Bypasses the UI's flow-creation path (`blank-flow` button → `useAddFlow`),
 * which races on the unique-name suffix logic and emits transient
 * `POST /api/v1/flows/` 500s in tests against `release-1.10.0`. Going through
 * the API with an explicit timestamp-based name avoids the race and keeps the
 * test's network audit clean.
 *
 * Use this when the test continues on the canvas after creation. For tests
 * that need a populated flow (ChatInput → ChatOutput), use `setupPlayground`.
 *
 * Returns the created flow's ID so the caller can clean up in `afterEach`
 * with `deleteFlow(page.request, id)`. The browser-context auth (cookie/state)
 * is reused automatically — no explicit Authorization header is required on
 * the cleanup call.
 */
export async function setupBlankFlow(page: Page): Promise<string> {
  const flowName = `e2e-blank-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;

  const authToken = await getAuthToken(page.request);

  // createFlow retries the transient POST /api/v1/flows/ 500 that Langflow
  // emits under concurrent creation (#588); a 4xx still surfaces immediately.
  const flowId = await createFlow(
    page.request,
    {
      name: flowName,
      description: "",
      is_component: false,
      data: {
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
    authToken ? { headers: { Authorization: authToken } } : undefined,
  );

  try {
    // Navigate via dashboard click instead of page.goto(`/flow/${flowId}`):
    // immediately after an API-created flow, the direct URL hits a stale
    // React Router cache and redirects back to the flows list.
    await page.goto("/");
    // The /flows a11y refactor (Langflow #13891) wraps each card in a
    // `list-card-open-button` overlay and makes `flow-name-div`
    // `pointer-events-none`, so we open the flow via that overlay button.
    //
    // Target the button by the flow's exact id (via `aria-labelledby`) rather
    // than filtering cards by name, and dispatch the click: on the shared home
    // grid, residual cards left by other parallel workers overlap the target's
    // absolute-inset open button and intercept a plain hit-tested click
    // (#580/#588). Matching by id + dispatchEvent sidesteps both the name race
    // and the interception. Mirrors the validated pattern in the loop spec.
    const openButton = page.locator(
      `[data-testid="list-card-open-button"][aria-labelledby*="${flowId}"]`,
    );
    await openButton.waitFor({ state: "visible", timeout: 30000 });
    await openButton.dispatchEvent("click");
    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });
  } catch (err) {
    // Best-effort rollback of the created flow — swallow so the original
    // failure (err) is the one that surfaces, not a secondary cleanup error.
    await deleteFlow(page.request, flowId).catch(() => {});
    throw err;
  }

  return flowId;
}
