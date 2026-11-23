import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import {
  createCustomComponentGraphFlow,
  fetchComponentCatalog,
  type GraphFlow,
  type GraphSpec,
} from "../../../helpers/flows/build-custom-component-graph";

// The canvas half of the §12.6 graph-execution contract (issue #1896), sibling of
// api/flows/graph-execution-contract.spec.ts. Two surfaces the REST spec cannot
// see: the canvas's cycle-connection guard (green) and the mis-reported partial
// failure (declared failing). Graphs are built from CustomComponents over the API
// — the canvas cannot draw a cycle, which is surface 1 — then opened in the editor.
// No provider key. See docs/flow-functionality/graph-execution-canvas.md.

interface PageWithFlowHooks extends Page {
  allowFlowErrors: () => void;
}

/** A `.react-flow__handle` located by node id + its testid, so identical
 * CustomComponent handles are still distinguishable (they share a testid). */
function handle(page: Page, nodeId: string, testidSuffix: string): Locator {
  return page.locator(
    `.react-flow__handle[data-nodeid="${nodeId}"][data-testid="handle-customcomponent-shownode-${testidSuffix}"]`,
  );
}

test.describe("Graph execution on the canvas — cycle refusal and partial-failure feedback", () => {
  let bearerToken: string;
  let catalog: Record<string, unknown>;
  const created: GraphFlow[] = [];

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);
    catalog = await fetchComponentCatalog(request, { Authorization: bearerToken });
  });

  test.afterEach(async ({ request }) => {
    while (created.length > 0) {
      const flow = created.pop()!;
      await flow.deleteFlow(request);
    }
  });

  async function makeFlow(request: APIRequestContext, name: string, spec: GraphSpec): Promise<string> {
    const flow = await createCustomComponentGraphFlow(request, catalog, spec, {
      name: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      headers: { Authorization: bearerToken },
    });
    created.push(flow);
    return flow.flowId;
  }

  test(
    "the canvas refuses a cycle-closing connection and accepts a non-cycle one to the same port",
    { tag: ["@workspace", "@ui-ux", "@regression", "@stable"] },
    async ({ page, request }) => {
      // Alpha(incoming, loopback), Beta(incoming), Gamma() — no edges; the
      // connections are drawn in the canvas.
      const flowId = await makeFlow(request, "gxc-canvas-cycle", {
        nodes: [
          { id: "Alpha", kind: "echo", fields: ["incoming", "loopback"] },
          { id: "Beta", kind: "echo", fields: ["incoming"] },
          { id: "Gamma", kind: "echo" },
        ],
        edges: [],
      });
      await openFlowById(page, flowId);

      const edges = page.locator(".react-flow__edge");
      await expect(edges).toHaveCount(0);

      await test.step("Alpha -> Beta connects (one edge)", async () => {
        await handle(page, "Alpha", "output-right").click();
        await handle(page, "Beta", "incoming-left").click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Beta -> Alpha.loopback is refused — it would close a cycle", async () => {
        // react-flow decides isValidConnection synchronously on the click, so a
        // refused connection never becomes an edge (measured). The Gamma step
        // below is the definitive proof: were this edge created, the count would
        // reach 3 there, not 2.
        await handle(page, "Beta", "output-right").click();
        await handle(page, "Alpha", "loopback-left").click();
        await expect(edges).toHaveCount(1);
      });

      await test.step("Gamma -> Alpha.loopback connects — same target port, no cycle", async () => {
        await handle(page, "Gamma", "output-right").click();
        await handle(page, "Alpha", "loopback-left").click();
        await expect(edges).toHaveCount(2, { timeout: 10000 });
      });
    },
  );

  test(
    "a partial failure flags the failed node on the canvas",
    { tag: ["@workspace", "@ui-ux", "@playground", "@regression", "@stable"] },
    async ({ page, request }) => {
      // DECLARED FAILING (#1896). Root -> Raiser(raise) -> Join.left ;
      // Root -> Slow -> Tail -> Join.right. Running Join, the AG-UI stream the
      // canvas receives (measured 1.14.0.dev35, 3/3) is RUN_STARTED, two
      // STATE_SNAPSHOTs, Root's STEP_FINISHED + STATE_DELTA, a langflow.event
      // error naming Raiser, then RUN_ERROR, and it ends there. Raiser's own
      // STATE_DELTA (status "error") never arrives, so no node_status_icon
      // renders. The frontend can draw the flag: with that delta injected before
      // RUN_ERROR, node_status_icon_raiser_error appears. The assertion below is
      // that contract; it fails today and test.fail() expects that. The day the
      // backend reports the failed node before RUN_ERROR, this flips to an
      // unexpected pass: drop test.fail(), restore @stable if the daily already
      // removed it (it treats the unexpected pass as a hard failure), flip the
      // §12.6 canvas bullet.
      //
      // This test used to assert that the completed Slow -> Tail branch renders.
      // Upstream #16492 made RUN_ERROR terminal and drops every later event, so
      // that can no longer happen by design; the contract spec pins that rule.
      test.fail();
      (page as PageWithFlowHooks).allowFlowErrors();

      const flowId = await makeFlow(request, "gxc-canvas-partial", {
        nodes: [
          { id: "Root", kind: "echo" },
          { id: "Raiser", kind: "raise", fields: ["incoming"] },
          { id: "Slow", kind: "echo", fields: ["incoming"], delayS: 0.5 },
          { id: "Tail", kind: "echo", fields: ["incoming"] },
          { id: "Join", kind: "echo", fields: ["left", "right"] },
        ],
        edges: [
          { source: "Root", target: "Raiser", field: "incoming" },
          { source: "Raiser", target: "Join", field: "left" },
          { source: "Root", target: "Slow", field: "incoming" },
          { source: "Slow", target: "Tail", field: "incoming" },
          { source: "Tail", target: "Join", field: "right" },
        ],
      });
      await openFlowById(page, flowId);

      await page.getByTestId("button_run_join").click();

      // The run reached the backend: Root builds and the failure banner shows.
      // This anchors the declared-failing assertion — it is not a run that never
      // fired. Both are the CURRENT behavior, so they hold today.
      await expect(page.getByTestId("node_duration_root")).toBeVisible({ timeout: 30000 });
      await expect(page.getByText("Flow build failed")).toBeVisible({ timeout: 10000 });

      // The correct contract: the node that raised is flagged as failed. It is
      // not today (its error state never reaches the canvas before RUN_ERROR),
      // so this fails and test.fail() expects it.
      await expect(page.getByTestId("node_status_icon_raiser_error")).toBeVisible({ timeout: 8000 });
    },
  );
});
