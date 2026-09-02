import { readFileSync } from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { clearCanvasBottomOverlay } from "../../../../helpers/ui/clear-canvas-bottom-overlay";

// §5.2.1 — the *processing* step of RAG ingestion: a document (delivered by
// Chat Input) is split into chunks by Split Text. Embedding the chunks requires
// a vector store (all of which are bundles, not core) and is covered by the
// Vector Store spec (#674, §5.2.2) — it is deliberately out of scope here so
// this spec stays on core, non-legacy, bundle-free components. Spec doc:
// docs/core-functionality/knowledge-ingestion-management/split-text-chunking.md

// Pre-wired fixture flow: Chat Input(input_value = the 5-line sentinel doc) ->
// Split Text(chunk_size=100, chunk_overlap=0, separator="\n"). Built and
// validated live on 1.11.0.dev38.
const FIXTURE_PATH = "tests/assets/flows/split-text-chunking-fixture.json";

// The document is 5 newline-separated sentences, each 91–97 chars, with
// Chunk Size 100 / Overlap 0. No adjacent pair fits in 100 chars, so each
// sentence becomes its own chunk → deterministically 5 chunks.
const EXPECTED_CHUNKS = 5;

// A distinctive phrase that lives inside exactly one chunk, so the grid match
// cannot be coincidental (it is verbatim text from the ingested document).
const CHUNK_SENTINEL = "embedding vector";

// Ids of the flows each test creates; teardown deletes only these via the API
// (scoped) — never a global cleanAllFlows, which wipes flows other parallel
// workers are actively building mid-run (#515).
const createdFlowIds: string[] = [];

// Named flows created via the API race on unique-name suffixing under
// parallelism; run the file serially (same rationale as the sibling
// core-components specs).
test.describe.configure({ mode: "serial" });

/**
 * Creates the chunking fixture flow via the API (unique name per run) and opens
 * it on the canvas, ready for a node run. The created id is pushed to
 * `createdFlowIds` for scoped teardown.
 */
async function openChunkingFlow(page: Page): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  const authHeader = await getAuthToken(page.request);
  const headers: Record<string, string> = authHeader
    ? { Authorization: authHeader }
    : {};

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const flowId = await createFlow(
    page.request,
    {
      name: `Split Text Chunking ${uniqueSuffix}`,
      description: fixture.description,
      data: fixture.data,
      is_component: false,
    },
    { headers },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  // The imported flow loads with its nodes wired; wait for the canvas to render
  // the Split Text node before interacting.
  await expect(page.getByTestId("title-Split Text")).toBeVisible({
    timeout: 30000,
  });

  // Fit the view so the node run controls are not occluded by the bottom
  // react-flow toolbar panel (which intercepts the run-button click otherwise).
  await adjustScreenView(page);
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a
  // flow we are about to delete, then pass an explicit auth header —
  // page.request is unauthenticated under AUTO_LOGIN and would 401 otherwise.
  await page.goto("/");
  const authHeader = await getAuthToken(page.request);
  const opts = authHeader
    ? { headers: { Authorization: authHeader } }
    : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

test(
  "Split Text splits an ingested document into the expected number of chunks",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    await test.step("open the pre-wired chunking fixture flow", async () => {
      await openChunkingFlow(page);
    });

    await test.step("run the Split Text component", async () => {
      await page.getByTestId("button_run_split text").click({ timeout: 15000 });
      // Successful build badge — the deterministic completion signal (Chat Input
      // builds too, as the upstream dependency).
      await expect(page.getByTestId("node_duration_split text")).toBeVisible({
        timeout: 60000,
      });
    });

    await test.step("the Chunks output holds exactly the expected chunks", async () => {
      // Free the canvas bottom-centre overlay slot before reaching for the
      // inspector. Langflow shares that slot between the transient build-status
      // bar and the "Flow needs review" banner, which this fixture raises
      // (`lf_version: 1.6.0`, one component reported outdated) and which never
      // leaves on its own — a click under it is refused for the full
      // `locator.click` budget (#1643). Measured on 1.13.0.dev0 the click is NOT
      // intercepted here: the banner's top edge (y 586.0) clears the button's
      // bottom edge (y 572.8) by 13.2 px. That margin is node height, which is
      // exactly what upstream moves — the context-id specs of #1643 had ~5 px and
      // burned three attempts a run, `agent-n-messages-limit` had ~37 px and was
      // hardened anyway. This call costs ~3 s and removes the dependence (#1675).
      await clearCanvasBottomOverlay(page);
      await page.getByTestId("output-inspection-chunks-splittext").click();
      // The Chunks DataFrame renders as an ag-Grid; each chunk is one data row
      // (carrying a `row-index`) inside the grid's center-columns viewport.
      // Scope to that viewport so the count cannot be inflated by any other row
      // element on the page (e.g. the playground preview). Exactly 5 rows for
      // this document + chunk size.
      const chunkRows = page.locator(".ag-center-cols-container [row-index]");
      await expect(chunkRows).toHaveCount(EXPECTED_CHUNKS, { timeout: 15000 });
      // Exactly one chunk row carries this verbatim phrase from the document,
      // proving the rows are the real chunks.
      await expect(chunkRows.filter({ hasText: CHUNK_SENTINEL })).toHaveCount(
        1,
        { timeout: 15000 },
      );
    });
  },
);
