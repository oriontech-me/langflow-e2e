import { randomUUID } from "node:crypto";
import { expect, Page } from "@playwright/test";
import { adjustScreenView } from "../ui/adjust-screen-view";
import { getAuthToken } from "../auth/get-auth-token";
import { zoomOut } from "../ui/zoom-out";
import { deleteFlow } from "./delete-flow";

/** Empty graph payload — what the SPA posts when the "Blank Flow" card is picked. */
const BLANK_FLOW_DATA = {
  nodes: [],
  edges: [],
  viewport: { zoom: 1, x: 0, y: 0 },
};

/**
 * Creates the empty flow through the REST API and returns its id.
 *
 * Why not the UI (#988): `POST /api/v1/flows/` derives the flow name
 * server-side with a check-then-insert (`_deduplicate_flow_name` SELECTs the
 * highest `New Flow (N)` and the INSERT follows in a separate statement). Two
 * concurrent creations for the same user therefore resolve to the SAME name and
 * the loser dies on `UNIQUE constraint failed: flow.user_id, flow.name`, which
 * the endpoint maps to a bare **500** — measured directly in the container log
 * while reproducing this helper's flake. The SPA stays on the flows list when
 * that happens, so the old UI path then waited 30s for a navigation that could
 * never occur.
 *
 * Posting an explicit, unique name takes the deduplication branch out of play
 * entirely: the exact-name lookup misses, the name is used verbatim, and there
 * is no shared value left for two workers to collide on.
 */
async function createBlankFlow(
  page: Page,
): Promise<{ id: string; name: string; authorization: string }> {
  // Hyphens stripped on purpose: Langflow derives an MCP tool slug from the flow
  // name and normalises `-` the same way it normalises spaces, which would make
  // the slug unpredictable for `mcp-server-regression.spec.ts`.
  const name = `E2E Playground ${randomUUID().replace(/-/g, "")}`;
  // The browser context has not loaded the app yet, so it carries no session:
  // mint one up front (auto-login mode) and let the resulting cookies serve the
  // subsequent `page.goto` as well. Falls back to whatever credentials the
  // context already holds when the instance is not in auto-login mode.
  const authorization = await getAuthToken(page.request);
  const res = await page.request.post("/api/v1/flows/", {
    data: {
      name,
      description: "",
      data: BLANK_FLOW_DATA,
      // The SPA's `createNewFlow` hardcodes this to true while the column
      // defaults to false, so omitting it produces a flow that — unlike every
      // UI-created one — is NOT exposed as an MCP tool. Caught by
      // `mcp-server-regression.spec.ts` on a clean instance.
      mcp_enabled: true,
    },
    headers: authorization ? { Authorization: authorization } : undefined,
  });

  if (!res.ok()) {
    // Surface the real reason instead of the downstream navigation timeout the
    // old implementation reported (#988).
    throw new Error(
      `setupPlayground: flow creation failed — POST /api/v1/flows/ → ${res.status()} ${res.statusText()}: ${await res
        .text()
        .catch(() => "<unreadable body>")}`,
    );
  }

  const created = await res.json();
  const flowId = created?.id as string | undefined;
  if (!flowId || flowId.trim() === "") {
    throw new Error(
      "setupPlayground: flow creation response did not include a valid non-empty id.",
    );
  }
  return {
    id: flowId,
    name: (created?.name as string) ?? name,
    authorization,
  };
}

/**
 * Blocks until the persisted graph satisfies `predicate`.
 *
 * Exists to serialise our canvas edits against the SPA's debounced autosave
 * (#988). Each graph change schedules its own `PATCH /api/v1/flows/{id}` with
 * the WHOLE graph, and those requests are not serialised client-side: under
 * parallel load two of them overlap and the older one can be committed last,
 * silently rolling the graph back. Measured on a failing run — the PATCH issued
 * at 6.2s (nodes, no edge) answered at 7.56s, AFTER the 7.36s PATCH that carried
 * the edge; the flow then stayed edge-less permanently, so no amount of waiting
 * downstream recovered it. Letting each change reach the database before making
 * the next one removes the overlap, and makes "the graph this helper built is
 * durable" a postcondition callers can rely on after a reload.
 */
async function waitForGraphPersisted(
  page: Page,
  flowId: string,
  authorization: string,
  predicate: (data: { nodes?: unknown[]; edges?: unknown[] }) => boolean,
  timeoutMs = 30000,
): Promise<void> {
  const options = authorization
    ? { headers: { Authorization: authorization } }
    : undefined;
  await expect(async () => {
    const res = await page.request.get(`/api/v1/flows/${flowId}`, options);
    expect(res.ok()).toBe(true);
    expect(predicate((await res.json())?.data ?? {})).toBe(true);
  }).toPass({ timeout: timeoutMs, intervals: [250, 500, 1000] });
}

/**
 * Creates a flow wired as ChatInput → ChatOutput and leaves the page on its
 * canvas, ready for the playground. Returns the created flow's id so callers
 * can clean it up with `deleteFlow`.
 *
 * The empty flow is created via the API (see `createBlankFlow`) and the canvas
 * is reached by direct navigation; the two components are then added and
 * connected through the real UI, which is the part the playground specs depend
 * on. Compared with driving the home page → templates modal → "Blank Flow"
 * path, this drops two of the three flow writes the setup used to perform (the
 * throwaway flow the "New Flow" entry point eagerly creates, plus the bulk
 * DELETE that disposes of it) and removes the navigation race altogether.
 *
 * Postcondition: the wired graph is durable — every canvas edit is confirmed
 * server-side before the next one is made (`waitForGraphPersisted`), so callers
 * may reload the page or read the flow back over the API immediately.
 */
export async function setupPlayground(page: Page): Promise<string> {
  const {
    id: flowId,
    name: flowName,
    authorization,
  } = await createBlankFlow(page);

  try {
    await page.goto(`/flow/${flowId}`);

    // Gate on the canvas being mounted before reaching for editor-only
    // elements. Unlike the previous URL wait, this cannot hang on a navigation
    // that never happened — the flow provably exists at this point.
    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });

    // …and on the flow store having HYDRATED this flow, not merely on the
    // canvas chrome being painted. The header name renders
    // `useFlowStore.currentFlow.name`, so a match proves the fetched flow is in
    // the store. Without it a component added into the pre-hydration window is
    // wiped when the store swaps in the persisted (empty) graph.
    await expect(page.getByTestId("flow_name")).toContainText(flowName, {
      timeout: 30000,
    });

    // …and on write permission having RESOLVED. `useAddComponent` bails out
    // silently while `useIsFlowReadOnly(currentFlow.id)` is true, and that hook
    // reports read-only for the whole time the effective-permissions query is
    // in flight — so a click landed in that window adds nothing at all, with no
    // error anywhere. The header's flow-name button is disabled by the very
    // same expression (`FlowMenu` → `useIsFlowReadOnly(currentFlow?.id)`), so
    // its enabled state is an exact observable for "the add will register".
    await expect(page.getByTestId("menu_bar_display")).toBeEnabled({
      timeout: 30000,
    });

    // The flow editor sidebar mounts after the flow payload resolves; wait for
    // sidebar-search-input before interacting (see #278).
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
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

    // Assert each component landed before adding the next one: a bare
    // "expected 2, got 1" at the end of the setup does not say WHICH add was
    // lost, and that ambiguity cost a debug cycle on #988.
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 15000,
    });

    // …and let it reach the database before the next edit — see
    // `waitForGraphPersisted`. The gate has to sit after EVERY mutation, not
    // just at the end: it is the in-flight save of edit N that edit N+1's save
    // can overtake, and the loser is committed last.
    await waitForGraphPersisted(
      page,
      flowId,
      authorization,
      (data) => (data.nodes?.length ?? 0) === 1,
    );

    await zoomOut(page, 2);

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

    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Both nodes committed before the edge is drawn.
    await waitForGraphPersisted(
      page,
      flowId,
      authorization,
      (data) => (data.nodes?.length ?? 0) === 2,
    );

    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });

    // Postcondition: the wired graph survives a reload. Several callers reload
    // the page or read the flow back over the API right after this returns.
    await waitForGraphPersisted(
      page,
      flowId,
      authorization,
      (data) => (data.edges?.length ?? 0) >= 1,
    );
  } catch (err) {
    // Best-effort rollback of the created flow — swallow so the original
    // failure (err) is the one that surfaces, not a secondary cleanup error.
    // The explicit header matters: `page.request` on its own is unauthenticated
    // under AUTO_LOGIN, so a bare delete would 401 and leak the flow.
    await deleteFlow(
      page.request,
      flowId,
      authorization ? { headers: { Authorization: authorization } } : undefined,
    ).catch(() => {});
    throw err;
  }

  return flowId;
}
