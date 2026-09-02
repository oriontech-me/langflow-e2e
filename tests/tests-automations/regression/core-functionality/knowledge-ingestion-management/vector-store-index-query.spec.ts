import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { loadFixtureFlow } from "../../../../helpers/flows/load-fixture-flow";
import { runNodeAndWait } from "../../../../helpers/flows/run-node-and-wait";
import {
  assertEmbeddingCredentialConfigured,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
} from "../../../../helpers/knowledge/knowledge-base";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { clearCanvasBottomOverlay } from "../../../../helpers/ui/clear-canvas-bottom-overlay";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

// §5.2.2 + §5.2.3 — the *vectorization + retrieval* step of RAG ingestion. The
// chunks produced by Split Text are embedded and indexed into a native (core,
// Chroma-backed) Langflow Knowledge Base, then a static query retrieves the
// relevant chunk. Uses the core Knowledge component, not a vector-store bundle,
// so it never yields a false failure on a packaging change. Spec doc:
// docs/core-functionality/knowledge-ingestion-management/vector-store-index-query.md

// Pre-wired fixture flow: Chat Input(the 5-line sentinel doc) -> Split Text
// (chunk_size=100, overlap=0) -> Knowledge[Ingest], plus a standalone
// Knowledge[Retrieve] (top_k=1, static query) over the same KB. The KB name is a
// placeholder the spec replaces per run. Built and validated live on 1.11.0.dev38.
const FIXTURE_PATH = "tests/assets/flows/vector-store-index-query-fixture.json";

// The Knowledge component indexes one chunk per input row and its chunk_size is
// the embedding batch size (not a text splitter), so the multi-chunk split is
// done by Split Text: the 5-sentence document at chunk_size 100 -> exactly 5
// rows -> 5 indexed chunks.
const EXPECTED_CHUNKS = 5;

// A distinctive phrase that lives inside exactly one chunk (sentence 3), so the
// top-1 retrieval match cannot be coincidental — it is verbatim text from the
// ingested document and the only chunk about the query's topic.
const CHUNK_SENTINEL = "embedding vector";

// The KB is created with the embedding model enabled out-of-the-box on the
// instance; GOOGLE_API_KEY is auto-imported as a credential and is injected in
// the daily-stable CI. The KB API resolves the embedding at ingest time from
// this provider/model + that credential.
const EMBEDDING_PROVIDER = "Google Generative AI";
const EMBEDDING_MODEL = "models/gemini-embedding-001";

// Stable node ids baked into the fixture, so the shared `button_run_knowledge` /
// `node_duration_knowledge` / `output-inspection-results-knowledge` testids can
// be scoped to the right Knowledge node.
const INGEST_NODE = "Knowledge-ingest";
const RETRIEVE_NODE = "Knowledge-retrieve";

// Ids of the resources each test creates; teardown deletes only these via the
// API (scoped) — never a global wipe, which would remove flows/KBs other
// parallel workers are actively using (#515).
const createdFlowIds: string[] = [];
const createdKbNames: string[] = [];

// Named flows created via the API race on unique-name suffixing under
// parallelism; run the file serially (same rationale as the sibling
// knowledge-ingestion specs).
test.describe.configure({ mode: "serial" });

// Google embeds every chunk into the Knowledge Base, so gate on provider HEALTH
// rather than on the mere presence of the env var: a key that exists but is
// drained blocks the backend past gunicorn's 300s timeout and kills the shard's
// Langflow worker (#1029).
const gate = providerSkipGate("google");
test.skip(gate.skip, gate.reason);

async function authHeaders(page: Page): Promise<Record<string, string>> {
  const authHeader = await getAuthToken(page.request);
  return authHeader ? { Authorization: authHeader } : {};
}

/**
 * Creates a fresh, uniquely-named Knowledge Base, then imports the fixture flow
 * with both Knowledge nodes pointed at that KB, and opens it on the canvas ready
 * for a node run. Records the created KB name and flow id for scoped teardown.
 */
async function openVectorStoreFlow(page: Page): Promise<void> {
  const headers = await authHeaders(page);

  // The embedding provider key must be a Langflow global variable (not just an
  // env var) or the KB ingest fails with a misleading "embedding model no longer
  // recognized" error surfacing as a 90s node_duration timeout — fail fast and
  // actionably instead.
  await assertEmbeddingCredentialConfigured(page.request, "GOOGLE_API_KEY", {
    headers,
  });

  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const kbName = await createKnowledgeBase(
    page.request,
    {
      name: `kb_vsiq_${uniqueSuffix}`,
      embeddingProvider: EMBEDDING_PROVIDER,
      embeddingModel: EMBEDDING_MODEL,
    },
    { headers },
  );
  createdKbNames.push(kbName);

  // The fixture stores a frozen copy of each component's source; hydrate it from
  // the running image before creating the flow, or an upstream refactor of a
  // module that copy imports breaks the run at graph build (#1478).
  const fixture = await loadFixtureFlow(page.request, FIXTURE_PATH, { headers });
  // Point both Knowledge nodes at the freshly-created KB. The DropdownInput only
  // treats a value as a valid selection when it is also present in `options`, so
  // set both — value alone leaves the node showing "Select an option" and it
  // will not run.
  for (const node of fixture.data.nodes) {
    if (node.data?.type === "Knowledge") {
      const kb = node.data.node?.template?.knowledge_base;
      if (!kb) {
        throw new Error(
          `${FIXTURE_PATH}: node ${node.id} (type Knowledge) has no ` +
            `template.knowledge_base field — cannot pin it to the freshly-created ` +
            `KB. If upstream renamed/removed this field, the pin must target the ` +
            `new field instead of silently leaving the node unset.`,
        );
      }
      kb.value = kbName;
      kb.options = [kbName];
    }
  }

  const flowId = await createFlow(
    page.request,
    {
      name: `Vector Store Index Query ${uniqueSuffix}`,
      description: fixture.description,
      data: fixture.data,
      is_component: false,
    },
    { headers },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await expect(
    page.locator(`[data-id="${INGEST_NODE}"]`).getByTestId("title-knowledge"),
  ).toBeVisible({ timeout: 30000 });

  // Fit the view and zoom out so the node run controls are not occluded by the
  // side/bottom react-flow panels (the right Inspector Panel intercepts the
  // run-button click on nodes near the right edge otherwise).
  await adjustScreenView(page, { numberOfZoomOut: 2 });

  // Free the canvas bottom-centre overlay slot once, up front: this fixture is
  // behind the running image, so Langflow raises the "Flow needs review" banner
  // into the slot it shares with the build-status bar, the banner never leaves on
  // its own, and a click under it is refused for the full `locator.click` budget
  // (#1643). Clearing it here covers every node-output click that follows.
  // `allowAlreadyClear` because a refreshed fixture would raise no banner at all —
  // safe only because this runs AFTER a node title is on screen, the gate the
  // banner mounts within 1-3 ms of (measured on 1.13.0.dev0, #1675). The cost is
  // real and deliberate: it also opts this call site out of the helper's
  // lost-selector guard, so an upstream Tailwind rename of the slot container is
  // SILENT here (verified — mutating the selector leaves both tests green). The
  // guard is not lost to the suite, it is held where the alternative is worse:
  // `split-text-chunking` and the three #1643 specs call the helper post-build,
  // where the build bar is on screen by construction and an empty slot can only
  // mean a broken selector. Making this call site fail closed instead would tie
  // two @stable specs to the fixture STAYING outdated, so the maintenance action
  // that fixes the root cause would be the one that reddens them.
  await clearCanvasBottomOverlay(page, { allowAlreadyClear: true });
}

/**
 * Runs a Knowledge node (scoped by id) and waits for a VERDICT, not for a badge.
 *
 * `node_duration_knowledge` only renders on a SUCCESSFUL build, so waiting on it
 * alone cannot observe a failed run — it burns the whole budget and reports
 * `element(s) not found`, naming the badge instead of the cause. This spec
 * shares that surface, that provider and that failure mode with
 * `rag-pipeline.spec.ts`, whose ingest step spent four dailies on an
 * unattributable 90s timeout while a Google 429 RESOURCE_EXHAUSTED sat on screen
 * within ~1s; the two run back to back on the same shard against the same
 * project-wide per-minute embedding quota, so they are fixed together (#1667).
 */
async function runKnowledgeNode(page: Page, nodeId: string): Promise<void> {
  await runNodeAndWait(page, {
    nodeId,
    runButtonTestId: "button_run_knowledge",
    durationTestId: "node_duration_knowledge",
  });
}

test.afterEach(async ({ page }) => {
  const flowIds = createdFlowIds.splice(0);
  const kbNames = createdKbNames.splice(0);
  if (flowIds.length === 0 && kbNames.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a
  // flow we are about to delete, then pass an explicit auth header —
  // page.request is unauthenticated under AUTO_LOGIN and would 401 otherwise.
  await page.goto("/");
  const headers = await authHeaders(page);
  // Delete every resource independently and collect failures, so a throw while
  // deleting one (e.g. a flow-delete 401/persistent 5xx) can never skip the
  // rest — otherwise the KB, a persistent instance resource that MUST be
  // deleted to avoid orphans (unlike an in-memory vector store), would leak.
  // Failures still surface (aggregated) rather than being swallowed silently.
  const failures: string[] = [];
  for (const id of flowIds) {
    try {
      await deleteFlow(page.request, id, { headers });
    } catch (e) {
      failures.push(String(e));
    }
  }
  for (const name of kbNames) {
    try {
      await deleteKnowledgeBase(page.request, name, { headers });
    } catch (e) {
      failures.push(String(e));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
  }
});

test(
  "Knowledge Base indexes the ingested document chunks (available for query)",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    await test.step("open the pre-wired vector-store fixture flow", async () => {
      await openVectorStoreFlow(page);
    });

    await test.step("run the Knowledge (Ingest) node", async () => {
      await runKnowledgeNode(page, INGEST_NODE);
    });

    await test.step("the Knowledge Base holds exactly the expected chunks", async () => {
      // Causal proof the ingest embedded + indexed the document: the KB reports
      // one indexed chunk per Split Text row. A broken key/index leaves it at 0.
      const kbName = createdKbNames[createdKbNames.length - 1];
      const headers = await authHeaders(page);
      const kb = await getKnowledgeBase(page.request, kbName, { headers });
      expect(kb.chunks).toBe(EXPECTED_CHUNKS);
    });
  },
);

test(
  "Knowledge Base query returns the relevant chunk for the prompt",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    await test.step("open the pre-wired vector-store fixture flow", async () => {
      await openVectorStoreFlow(page);
    });

    await test.step("ingest the document into the Knowledge Base", async () => {
      await runKnowledgeNode(page, INGEST_NODE);
    });

    await test.step("run the Knowledge (Retrieve) node", async () => {
      await runKnowledgeNode(page, RETRIEVE_NODE);
    });

    await test.step("the top result is the chunk relevant to the query", async () => {
      await page
        .locator(`[data-id="${RETRIEVE_NODE}"]`)
        .getByTestId("output-inspection-results-knowledge")
        .click();
      // The Retrieve results render as an ag-Grid; with top_k=1 there is exactly
      // one result row (scoped to the grid viewport so the count cannot be
      // inflated by any other row element on the page), and it carries the
      // verbatim sentinel phrase — proving the vector store returned the single
      // chunk that is actually about the query's topic.
      const resultRows = page.locator(".ag-center-cols-container [row-index]");
      await expect(resultRows).toHaveCount(1, { timeout: 15000 });
      await expect(
        resultRows.filter({ hasText: CHUNK_SENTINEL }),
      ).toHaveCount(1, { timeout: 15000 });
    });
  },
);
