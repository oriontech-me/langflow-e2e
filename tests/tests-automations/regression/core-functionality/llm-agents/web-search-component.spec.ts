import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

// Replaces `duckduckgo.spec.ts` (#1912, Wave 9 T2). The DuckDuckGo Search component
// is on no tested image — and, unlike the three specs parked alongside it, NOT because
// of `lfx-bundles` packaging: there is no `lfx/components/duckduckgo` directory at all,
// so no distribution exists for an availability gate to wait for. The capability moved
// into the core `UnifiedWebSearch`, whose `Web` mode is the DuckDuckGo search
// (`lfx/components/data_source/web_search.py` → `html.duckduckgo.com`). That is the
// "family is core and vanished / component reparented → fix the spec" row of
// docs/component-distribution-policy.md, not the gate-and-skip row.
//
// No live search is executed, and that is a decision recorded in the spec doc: the
// deleted version raced `built successfully` against `ratelimit` and asserted on
// whichever won, so its ratelimit branch passed when the search did NOT work. It also
// called the public internet, the coupling #1128 exists to remove. What this asserts
// instead is the component's persisted contract, which the instance answers alone.
//
// See docs/core-functionality/llm-agents/web-search-component.md.

const WEB_SEARCH_CARD = "data_sourceWeb Search";
const WEB_SEARCH_ADD_BUTTON = "add-component-button-web-search";
const QUERY_INPUT = "popover-anchor-input-query";

// A sentinel rather than a plausible query: a default value, a neighbouring worker's
// flow or a stale template cannot satisfy it, so the persistence assert cannot pass by
// coincidence.
const QUERY_SENTINEL = "WEBSEARCH_SENTINEL_Q7X2";

interface PersistedWebSearchNode {
  type?: string;
  template?: {
    query?: { value?: unknown };
    search_mode?: { value?: unknown; options?: unknown };
  };
  outputs?: Array<{ name?: string; types?: string[] }>;
}

/**
 * Read the flow back from the server and return its nodes' component data.
 *
 * Server truth rather than the canvas: the canvas shows what React rendered, which is
 * also true of a node that never reached the database. Autosave is debounced, so this
 * is polled by `expect.poll` at the call site instead of read once.
 */
async function readFlowNodes(
  request: Parameters<typeof getAuthToken>[0],
  flowId: string,
): Promise<PersistedWebSearchNode[]> {
  const bearer = await getAuthToken(request);
  const response = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  if (!response.ok()) return [];
  const flow = await response.json();
  return (flow?.data?.nodes ?? []).map(
    (node: { data?: { type?: string; node?: unknown } }) => ({
      type: node?.data?.type,
      ...((node?.data?.node as object) ?? {}),
    }),
  );
}

test.describe("Web Search component", () => {
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
  });

  test(
    "Web Search component places, offers its three search modes and persists its query",
    { tag: ["@stable", "@release", "@components", "@agents"] },
    async ({ page, request }) => {
      await test.step("create a blank flow", async () => {
        await awaitBootstrapTest(page);
        await page.waitForSelector('[data-testid="blank-flow"]', {
          timeout: 30000,
        });
        await page.getByTestId("blank-flow").click();
        await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("add the Web Search component from the sidebar", async () => {
        await page.getByTestId("sidebar-search-input").click();
        await page.getByTestId("sidebar-search-input").fill("web search");

        await expect(page.getByTestId(WEB_SEARCH_CARD)).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId(WEB_SEARCH_CARD).hover();
        await page.getByTestId(WEB_SEARCH_ADD_BUTTON).click();
        await adjustScreenView(page);

        await expect(page.getByTestId("title-Web Search")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("the node offers all three search modes", async () => {
        // Web is the DuckDuckGo mode this spec inherited its subject from; News and
        // RSS are asserted so a build that silently dropped a mode is a failure here
        // rather than a surprise in a flow.
        await expect(page.getByTestId("tab_0_web")).toBeVisible();
        await expect(page.getByTestId("tab_1_news")).toBeVisible();
        await expect(page.getByTestId("tab_2_rss")).toBeVisible();
      });

      await test.step("type a search query", async () => {
        await page.getByTestId(QUERY_INPUT).fill(QUERY_SENTINEL);
        await expect(page.getByTestId(QUERY_INPUT)).toHaveValue(
          QUERY_SENTINEL,
        );
      });

      await test.step("the node declares its Results output", async () => {
        await expect(
          page.getByTestId("handle-unifiedwebsearch-shownode-results-right"),
        ).toBeVisible();
        await expect(
          page.getByTestId("output-inspection-results-unifiedwebsearch"),
        ).toBeVisible();
      });

      await test.step("the configured component persists to the flow", async () => {
        await flows.settle();

        // Anchor on the flow the CANVAS is editing, never on `ids()[0]`.
        // `awaitBootstrapTest` provisions the starter projects first, so the tracker
        // legitimately holds several ids by this point (measured: 4, with the canvas
        // flow last) and the first one is an empty "New Flow" — reading it asserted
        // nothing and failed with `undefined`.
        const flowId = page.url().match(/\/flow\/([^/?#]+)/)?.[1];
        expect(
          flowId,
          "the blank-flow click must have routed into a flow editor",
        ).toBeTruthy();
        // Cross-check rather than trust the URL: if the canvas id were not one the
        // tracker captured, cleanup would leak it and this assertion would be read
        // against a flow nothing owns.
        expect(
          flows.ids(),
          "the canvas flow must be one this page created, so afterEach deletes it",
        ).toContain(flowId);

        // Autosave is debounced (~4 s), so poll rather than read once.
        await expect
          .poll(
            async () => {
              const nodes = await readFlowNodes(request, flowId!);
              return nodes.length === 1
                ? nodes[0]?.template?.query?.value
                : undefined;
            },
            { timeout: 30000, intervals: [1000] },
          )
          .toBe(QUERY_SENTINEL);

        const nodes = await readFlowNodes(request, flowId!);
        expect(nodes).toHaveLength(1);

        const node = nodes[0];
        expect(node.type).toBe("UnifiedWebSearch");
        expect(node.template?.search_mode?.value).toBe("Web");
        expect(node.template?.search_mode?.options).toEqual([
          "Web",
          "News",
          "RSS",
        ]);

        const outputs = node.outputs ?? [];
        expect(outputs.map((output) => output.name)).toEqual(["results"]);
        expect(outputs[0]?.types).toContain("Table");
      });
    },
  );
});
