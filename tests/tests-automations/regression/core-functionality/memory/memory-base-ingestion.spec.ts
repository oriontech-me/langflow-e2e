import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { retryOnDroppedConnection } from "../../../../helpers/enterprise/rbac";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  isEmbeddingModelEnabled,
  setEmbeddingModelEnabled,
} from "../../../../helpers/knowledge/embedding-model";
import {
  emptyFlowFolder,
  ingestFlowFolder,
  resolveAllowListRoots,
  uploadToFlowFolder,
} from "../../../../helpers/knowledge/folder-source";
import {
  cancelIngestion,
  getChunkingSettings,
  getRun,
  ingestFiles,
  ingestFolderViaConnector,
  listAllChunks,
  listRuns,
  previewChunks,
  TERMINAL_RUN_STATUSES,
  waitForRunToFinish,
  type IngestionRun,
} from "../../../../helpers/knowledge/ingestion";
import {
  assertEmbeddingCredentialConfigured,
  createKnowledgeBase,
  deleteKnowledgeBase,
} from "../../../../helpers/knowledge/knowledge-base";
import { selectPinnedModelOption } from "../../../../helpers/provider-setup/model-option";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

// Memory Base — ingestion (QA-CHECKLIST §20.4, issue #2043).
// Spec doc: docs/core-functionality/memory/memory-base-ingestion.md
//
// Every route is under /api/v1/knowledge_bases: a Memory Base owns a knowledge base,
// and the association guard answers 403 on /ingest, /chunks and /cancel for one a
// Memory Base manages, so the ingestion pipeline is reachable only through a plain
// knowledge base. The failure modes (unreachable provider, the guard itself) are #2044.

const EMBEDDING = { provider: "OpenAI", modelId: "text-embedding-3-small" };
const KB_API = "/api/v1/knowledge_bases";

/** 120 lines of 20 characters: a split point every 20 characters (test 1). */
const SHORT_LINES_DOC = Array.from(
  { length: 120 },
  (_, i) => `kb2043 line ${String(i).padStart(4, "0")} ok\n`,
).join("");

/** Twelve lines, every one shorter than the 200-character chunk size (test 2). */
const FITTING_LINES = Array.from(
  { length: 12 },
  (_, i) => `parity line ${String(i).padStart(2, "0")} of the preview check`,
);
/** One 539-character line with no newline in it (test 3). */
const LONG_LINE = Array.from({ length: 60 }, (_, i) => `alpha${String(i).padStart(3, "0")}`).join(" ");

/** The settings the parity tests send: the dialog's own separator default. */
const PARITY_SETTINGS = { chunkSize: 200, chunkOverlap: 0, separator: "\\n" };

function unique(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** The longest suffix of `prev` that `next` starts with — the overlap carried over. */
function carriedOverlap(prev: string, next: string): string {
  for (let len = Math.min(prev.length, next.length); len > 0; len--) {
    const head = next.slice(0, len);
    if (prev.endsWith(head)) return head;
  }
  return "";
}

/**
 * Every chunk is at most `size` long, and every chunk after the first reopens with
 * a non-empty tail of the one before it, at most `overlap` long.
 */
function expectCutAt(contents: string[], size: number, overlap: number, label: string): void {
  for (const [i, content] of contents.entries()) {
    expect(content.length, `${label} chunk ${i}`).toBeLessThanOrEqual(size);
  }
  for (let i = 1; i < contents.length; i++) {
    const carried = carriedOverlap(contents[i - 1], contents[i]);
    expect(carried.length, `${label} overlap into chunk ${i}`).toBeGreaterThan(0);
    expect(carried.length, `${label} overlap into chunk ${i}`).toBeLessThanOrEqual(overlap);
  }
}

function isPost(pathname: RegExp) {
  return (r: Request) => r.method() === "POST" && pathname.test(new URL(r.url()).pathname);
}

test.describe("core-functionality/memory — Memory Base ingestion", () => {
  let token: string;
  let flowId: string | null;
  /** Knowledge bases this test created, deleted by dir_name in afterEach. */
  let createdKbs: string[];
  /** Set only when test 1 flipped the embeddings model on, to restore it. */
  let restoreEmbeddingTo: boolean | null;
  let pageUsed: boolean;

  const auth = () => ({ headers: { Authorization: token } });

  test.beforeEach(async ({ request }) => {
    // Reset BEFORE the gate: a skip here still runs afterEach, which must then find
    // nothing to clean rather than the previous test's state.
    flowId = null;
    createdKbs = [];
    restoreEmbeddingTo = null;
    pageUsed = false;

    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    token = await getAuthToken(request);
    // Ingestion resolves its embeddings from the Langflow credential, not the env var;
    // without it every run below would fail with a misleading "no longer recognized".
    await assertEmbeddingCredentialConfigured(request, "OPENAI_API_KEY", auth());
    // One flow per test: the anchor that keeps the Knowledge page off the empty-
    // instance welcome screen (test 1), and the owner of the upload folder the
    // `folder` connector walks (tests 4 and 5).
    flowId = await createFlow(
      request,
      {
        name: unique("kb-ingestion"),
        description: "Anchor flow for the §20.4 Memory Base ingestion tests",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      auth(),
    );
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the Knowledge page before its knowledge bases disappear under it.
    if (pageUsed) await page.goto("about:blank");
    // Every cleanup call is idempotent (a 404 delete is done, a flag set twice is
    // set), so each may re-dial the socket the UI steps left idle (see ingestion.ts).
    for (const dirName of createdKbs) {
      await retryOnDroppedConnection(() => deleteKnowledgeBase(request, dirName, auth()));
    }
    if (restoreEmbeddingTo !== null) {
      const flag = restoreEmbeddingTo;
      await retryOnDroppedConnection(() =>
        setEmbeddingModelEnabled(request, EMBEDDING, flag, auth()),
      );
    }
    const owned = flowId;
    if (owned) {
      // Uploads outlive their flow on disk and are unreachable once it is gone, so
      // the folder is emptied first (tests 4 and 5 write a file there).
      await emptyFlowFolder(request, owned, retryOnDroppedConnection, auth());
      await retryOnDroppedConnection(() => deleteFlow(request, owned, auth()));
    }
  });

  async function createApiKb(request: APIRequestContext, prefix: string): Promise<string> {
    const dirName = await createKnowledgeBase(
      request,
      {
        name: unique(prefix),
        embeddingProvider: EMBEDDING.provider,
        embeddingModel: EMBEDDING.modelId,
      },
      auth(),
    );
    createdKbs.push(dirName);
    return dirName;
  }

  async function openKnowledgePage(page: Page): Promise<void> {
    pageUsed = true;
    await page.goto("/assets/knowledge-bases");
    // The title also carries the sidebar toggle's screen-reader label
    // ("Toggle SidebarKnowledge"), so it is matched by containment.
    await expect(page.getByTestId("mainpage_title")).toContainText("Knowledge", {
      timeout: 30000,
    });
  }

  test(
    "should open Create Knowledge Base with the 1000 / 200 / newline defaults and apply the chunk settings chosen there to the stored chunks",
    { tag: ["@stable", "@regression", "@files", "@ui-ux"] },
    async ({ page, request }) => {
      const kbName = unique("kb2043_ui");

      await test.step("the embeddings model is enabled before the page loads", async () => {
        const wasEnabled = await isEmbeddingModelEnabled(request, EMBEDDING, auth());
        if (!wasEnabled) {
          await setEmbeddingModelEnabled(request, EMBEDDING, true, auth());
          restoreEmbeddingTo = false;
        }
      });

      await openKnowledgePage(page);
      await page.getByRole("button", { name: "Add Knowledge" }).click();
      const dialog = page.getByRole("dialog", { name: "Create Knowledge Base" });
      await expect(dialog).toBeVisible({ timeout: 15000 });

      await test.step("the dialog opens with chunk size 1000, overlap 200 and separator \\n (#13884)", async () => {
        await expect(dialog.getByTestId("kb-chunk-size-input")).toHaveValue("1000");
        await expect(dialog.getByTestId("kb-chunk-overlap-input")).toHaveValue("200");
        await expect(dialog.getByTestId("kb-separator-input")).toHaveValue("\\n");
      });

      await test.step("name, embedding model, one file and 300 / 60 are chosen", async () => {
        await dialog.getByTestId("kb-source-name-input").fill(kbName);
        await dialog.getByTestId("kb-embedding-model").click();
        await selectPinnedModelOption(page, {
          requested: EMBEDDING.modelId,
          providerLabel: EMBEDDING.provider,
        });
        await expect(dialog.getByTestId("kb-embedding-model")).toHaveText(EMBEDDING.modelId);
        await dialog.locator("#file-input").setInputFiles({
          name: "short-lines.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(SHORT_LINES_DOC, "utf8"),
        });
        await expect(dialog.getByTestId("kb-chunk-size-input")).toBeEnabled();
        await dialog.getByTestId("kb-chunk-size-input").fill("300");
        await dialog.getByTestId("kb-chunk-overlap-input").fill("60");
      });

      // Chromium does not expose a multipart body that carries a file (measured:
      // `request.postData()` is "" for both calls), so what the dialog sent is read off
      // what the server computed from it: the preview it answered, the chunks it stored
      // and the settings it recorded on the knowledge base.
      let previewed: string[] = [];
      await test.step("the preview the dialog shows was cut at 300 with at most 60 carried over", async () => {
        const previewResponse = page.waitForResponse((r) =>
          isPost(/\/api\/v1\/knowledge_bases\/preview-chunks$/)(r.request()),
        );
        await dialog.getByRole("button", { name: "Next Step", exact: true }).click();
        const response = await previewResponse;
        expect(response.status(), "POST /api/v1/knowledge_bases/preview-chunks").toBe(200);
        const body = (await response.json()) as {
          files: Array<{ preview_chunks: Array<{ content: string }> }>;
        };
        previewed = body.files[0].preview_chunks.map((c) => c.content);
        // The dialog asks for the server's default of 5 preview chunks.
        expect(previewed.length, "chunks previewed").toBeGreaterThan(1);
        expectCutAt(previewed, 300, 60, "preview");
        // The dialog's accessible name follows its heading, so from here on it is
        // "Review & Build", not "Create Knowledge Base".
        await expect(page.getByRole("dialog", { name: "Review & Build" })).toBeVisible();
      });

      let dirName = "";
      let runId = "";

      await test.step("the dialog creates the knowledge base and starts its ingestion", async () => {
        const created = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            /\/api\/v1\/knowledge_bases\/?$/.test(new URL(r.url()).pathname),
        );
        const ingested = page.waitForResponse((r) =>
          isPost(/\/api\/v1\/knowledge_bases\/[^/]+\/ingest$/)(r.request()),
        );
        // Registered for cleanup BEFORE the click: the server derives dir_name from the
        // typed name by replacing spaces with `_` and this name has none, so a knowledge
        // base whose create response is never read is still deleted (a 404 is fine).
        createdKbs.push(kbName);
        // exact: the sidebar's Get started panel carries a "Create a flow" button.
        await page
          .getByRole("dialog", { name: "Review & Build" })
          .getByRole("button", { name: "Create", exact: true })
          .click();

        const createdResponse = await created;
        expect(createdResponse.status(), "POST /api/v1/knowledge_bases/").toBe(201);
        dirName = ((await createdResponse.json()) as { dir_name: string }).dir_name;
        expect(dirName, "dir_name derived from the typed name").toBe(kbName);

        const ingestResponse = await ingested;
        expect(ingestResponse.status(), `POST ${KB_API}/${dirName}/ingest`).toBe(200);
        runId = ((await ingestResponse.json()) as { id: string }).id;
      });

      await test.step("the stored chunks are cut at 300 with at most 60 carried over, as previewed", async () => {
        const run = await waitForRunToFinish(request, dirName, runId, auth());
        expect(run.status, `run ${runId}: ${run.error_message ?? ""}`).toBe("succeeded");

        const { chunks } = await listAllChunks(request, dirName, { jobId: runId }, auth());
        // 10 with 300 / 60 (measured on 1.13.0.dev22); the 1000 / 200 defaults give 3.
        expect(chunks.map((c) => c.metadata.chunk_index)).toEqual(
          Array.from({ length: 10 }, (_, i) => i),
        );
        const stored = chunks.map((c) => c.content);
        expectCutAt(stored, 300, 60, "stored");
        expect(stored.slice(0, previewed.length), "the chunks the dialog previewed").toEqual(previewed);
      });

      await test.step("the knowledge base records 300 / 60 / \\n", async () => {
        const settings = await getChunkingSettings(request, dirName, auth());
        expect(settings.chunk_size).toBe(300);
        expect(settings.chunk_overlap).toBe(60);
        expect(settings.separator).toBe("\\n");
      });

      await test.step("after a reload, Ingest Files reopens with the knowledge base's 300 / 60 (#13884)", async () => {
        await page.reload();
        await expect(page.getByTestId("mainpage_title")).toContainText("Knowledge", {
          timeout: 30000,
        });
        // The list shows a knowledge base's name with its underscores as spaces.
        const row = page.getByRole("row").filter({ hasText: dirName.replace(/_/g, " ") });
        await row.getByTestId("kb-row-update-button").click();
        const addFiles = page.getByRole("dialog", { name: "Add Files" });
        await expect(addFiles).toBeVisible({ timeout: 15000 });
        await expect(addFiles.getByTestId("kb-chunk-size-input")).toHaveValue("300");
        await expect(addFiles.getByTestId("kb-chunk-overlap-input")).toHaveValue("60");
        await expect(addFiles.getByTestId("kb-separator-input")).toHaveValue("\\n");
        await addFiles.getByRole("button", { name: "Close" }).click();
        await expect(addFiles).toBeHidden();
      });
    },
  );

  /**
   * Ingests `content` with the parity settings and returns what was stored beside
   * what the preview promised for the same file and settings.
   */
  async function previewAndIngest(
    request: APIRequestContext,
    content: string,
  ): Promise<{ previewed: string[]; stored: string[] }> {
    const file = { name: "parity.txt", content };
    const preview = await previewChunks(request, file, { ...PARITY_SETTINGS, maxChunks: 50 }, auth());
    // The comparison is exact only when the preview is not truncated: at most
    // max_chunks chunks, from at most max_chunks * chunk_size * 3 characters.
    expect(preview.length, "the preview was truncated at max_chunks").toBeLessThan(50);
    expect(content.length).toBeLessThan(50 * PARITY_SETTINGS.chunkSize * 3);

    const dirName = await createApiKb(request, "kb2043_parity");
    const runId = await ingestFiles(request, dirName, file, PARITY_SETTINGS, auth());
    const run = await waitForRunToFinish(request, dirName, runId, auth());
    expect(run.status, `run ${runId}: ${run.error_message ?? ""}`).toBe("succeeded");
    const { chunks } = await listAllChunks(request, dirName, { jobId: runId }, auth());
    return { previewed: preview.map((c) => c.content), stored: chunks.map((c) => c.content) };
  }

  const PARITY_OPS = [
    `POST ${KB_API}`,
    `POST ${KB_API}/preview-chunks`,
    `POST ${KB_API}/{kb_name}/ingest`,
    `GET ${KB_API}/{kb_name}/runs/{run_id}`,
    `GET ${KB_API}/{kb_name}/chunks`,
  ];

  test(
    "should store exactly the chunks preview-chunks promised when every line fits the chunk size",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(PARITY_OPS);
      const { previewed, stored } = await previewAndIngest(request, `${FITTING_LINES.join("\n")}\n`);
      expect(previewed.length, "the document fits one chunk, so the comparison would be trivial").toBeGreaterThan(1);
      expect(stored).toEqual(previewed);
    },
  );

  test(
    "should store exactly the chunks preview-chunks promised when a line is longer than the chunk size",
    { tag: ["@stable", "@regression", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      // LE-2771, fixed by langflow-ai/langflow#15421 (1.13.0.dev28): ingestion used to
      // split on the separator alone and store this line whole. See the spec doc's Notes.
      apiCoverage.declare(PARITY_OPS);
      expect(LONG_LINE.length, "the line fits the chunk size, so this is test 2").toBeGreaterThan(PARITY_SETTINGS.chunkSize);

      const lines = [...FITTING_LINES.slice(0, 6), LONG_LINE, ...FITTING_LINES.slice(6)];
      const { previewed, stored } = await previewAndIngest(request, `${lines.join("\n")}\n`);
      expect(stored.join("\n"), "the long line reached the stored chunks").toContain("alpha059");
      for (const [i, content] of stored.entries()) {
        expect(content.length, `stored chunk ${i}`).toBeLessThanOrEqual(PARITY_SETTINGS.chunkSize);
      }
      expect(stored).toEqual(previewed);
    },
  );

  /** Reads the allow-list and starts a folder ingestion of this test's flow folder. */
  async function ingestOwnFolder(
    request: APIRequestContext,
    dirName: string,
    settings: { chunkSize: number; chunkOverlap: number },
  ): Promise<string> {
    // `/`, non-recursive, with an extension no file carries: outside any sane
    // allow-list, and harmless even on an instance whose allow-list admits it.
    const roots = await resolveAllowListRoots(() =>
      ingestFolderViaConnector(
        request,
        dirName,
        { path: "/", recursive: false, extensions: ["kb2043-probe"] },
        settings,
        auth(),
      ),
    );
    const { runId } = await ingestFlowFolder(roots, flowId as string, (folder) =>
      ingestFolderViaConnector(request, dirName, { path: folder }, settings, auth()),
    );
    return runId;
  }

  test(
    "should ingest a server-side folder through the folder connector and read its chunks back",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/files/upload/{flow_id}",
        `POST ${KB_API}/{kb_name}/ingest/connector`,
        `GET ${KB_API}/{kb_name}/runs`,
        `GET ${KB_API}/{kb_name}/runs/{run_id}`,
        `GET ${KB_API}/{kb_name}/chunks`,
      ]);
      const sentinels = { a: unique("SENTINEL_A"), b: unique("SENTINEL_B") };

      const stored = await test.step("two files are uploaded into this test's flow folder", async () => {
        return [
          await uploadToFlowFolder(
            request,
            flowId as string,
            { name: "alpha.txt", content: `alpha ${sentinels.a}\nsome alpha text\n` },
            auth(),
          ),
          await uploadToFlowFolder(
            request,
            flowId as string,
            { name: "beta.md", content: `beta ${sentinels.b}\nsome beta text\n` },
            auth(),
          ),
        ].sort();
      });

      const dirName = await createApiKb(request, "kb2043_folder");
      const runId = await ingestOwnFolder(request, dirName, { chunkSize: 200, chunkOverlap: 0 });

      await test.step("the run reports both files ingested through the folder connector", async () => {
        const run = await waitForRunToFinish(request, dirName, runId, auth());
        expect(run.status, `run ${runId}: ${run.error_message ?? ""}`).toBe("succeeded");
        expect(run.source_type).toBe("folder");
        expect(run.total_items).toBe(2);
        expect(run.succeeded).toBe(2);
        expect(run.failed).toBe(0);
        expect(run.finished_at).toBeTruthy();
        expect((run.items ?? []).map((item) => item.display_name).sort()).toEqual(stored);

        const listed = (await listRuns(request, dirName, auth())).find((r) => r.id === runId);
        expect(listed, `GET ${KB_API}/${dirName}/runs lists ${runId}`).toBeTruthy();
        expect(listed?.status).toBe("succeeded");
        expect(listed?.source_type).toBe("folder");
      });

      await test.step("the chunks read back name the folder source, the run and both files", async () => {
        const { total, chunks } = await listAllChunks(
          request,
          dirName,
          { jobId: runId, sourceType: "folder" },
          auth(),
        );
        const run = (await getRun(request, dirName, runId, auth())) as IngestionRun;
        expect(total).toBe(run.chunks_created);
        expect(total).toBeGreaterThanOrEqual(2);
        for (const chunk of chunks) {
          expect(chunk.metadata.source_type).toBe("folder");
          expect(chunk.metadata.job_id).toBe(runId);
          expect(stored).toContain(chunk.metadata.file_name);
        }
        expect([...new Set(chunks.map((c) => c.metadata.file_name))].sort()).toEqual(stored);
        const text = chunks.map((c) => c.content).join("\n");
        expect(text).toContain(sentinels.a);
        expect(text).toContain(sentinels.b);
      });
    },
  );

  test(
    "should report an in-flight folder ingestion as running and, once cancelled, as cancelled with its chunks rolled back",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/files/upload/{flow_id}",
        `POST ${KB_API}/{kb_name}/ingest/connector`,
        `GET ${KB_API}/{kb_name}/runs`,
        `GET ${KB_API}/{kb_name}/runs/{run_id}`,
        `POST ${KB_API}/{kb_name}/cancel`,
        `GET ${KB_API}/{kb_name}/chunks`,
      ]);

      await test.step("a file big enough for a ~30 s run is uploaded into this test's flow folder", async () => {
        // 3000 lines -> 3000 chunks of chunk_size 100 -> 15 embedding batches of 200;
        // measured ~32 s end to end on 1.13.0.dev22, cancelled within seconds here.
        const content = Array.from(
          { length: 3000 },
          (_, i) => `line ${String(i).padStart(5, "0")} lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n`,
        ).join("");
        await uploadToFlowFolder(request, flowId as string, { name: "large.txt", content }, auth());
      });

      const dirName = await createApiKb(request, "kb2043_cancel");
      const runId = await ingestOwnFolder(request, dirName, { chunkSize: 100, chunkOverlap: 0 });

      await test.step("the run is listed and reported running while it is in flight", async () => {
        const deadline = Date.now() + 20000;
        let detail: IngestionRun | null = null;
        let listed: IngestionRun | undefined;
        while (Date.now() < deadline) {
          detail = await getRun(request, dirName, runId, auth());
          listed = (await listRuns(request, dirName, auth())).find((r) => r.id === runId);
          if (detail?.status === "running" && listed?.status === "running") break;
          if (detail && TERMINAL_RUN_STATUSES.includes(detail.status)) {
            throw new Error(
              `run ${runId} reached '${detail.status}' before it was seen in flight — the ` +
                "cancel below would prove nothing",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(detail?.status, "GET /runs/{id} while in flight").toBe("running");
        expect(listed?.status, "GET /runs while in flight").toBe("running");
        expect(detail?.source_type).toBe("folder");
        expect(detail?.finished_at).toBeNull();
      });

      await test.step("POST /cancel stops it", async () => {
        const cancel = await cancelIngestion(request, dirName, auth());
        expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
        expect(cancel.body.message).toContain(`Ingestion job for ${runId} cancelled successfully`);
      });

      await test.step("the run reports the cancellation, not a completion, and holds no chunk", async () => {
        const run = await waitForRunToFinish(request, dirName, runId, auth());
        expect(run.status).toBe("cancelled");
        expect(run.error_message).toBe("ingestion cancelled by user");
        expect(run.finished_at).toBeTruthy();

        const listed = (await listRuns(request, dirName, auth())).find((r) => r.id === runId);
        expect(listed?.status).toBe("cancelled");

        const { total } = await listAllChunks(request, dirName, { jobId: runId }, auth());
        expect(total, "chunks left behind by the cancelled run").toBe(0);
      });
    },
  );
});
