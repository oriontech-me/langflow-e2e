import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createThrowawayUser,
  deleteThrowawayUser,
  type ThrowawayUser,
} from "../../../../helpers/auth/throwaway-user";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  firstUnservedModel,
  readEmbeddingCatalog,
} from "../../../../helpers/knowledge/embedding-catalog";
import {
  ingestFiles,
  listAllChunks,
  listRuns,
  waitForRunToFinish,
  type IngestionRun,
} from "../../../../helpers/knowledge/ingestion";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  type KnowledgeBaseInfo,
} from "../../../../helpers/knowledge/knowledge-base";
import {
  deleteMemoryBase,
  listMemoryBases,
  registerMemoryBase,
} from "../../../../helpers/knowledge/memory-base";
import { readOllamaCapabilities } from "../../../../helpers/provider-setup/ollama-capabilities";
import {
  ollamaBaseUrl,
  ollamaBaseUrlFromLangflow,
} from "../../../../helpers/provider-setup/ollama-endpoint";

// Memory Base — ingestion failure modes (QA-CHECKLIST §20.4, issue #2044).
// Spec doc: docs/core-functionality/memory/memory-base-ingestion-failures.md
//
// API-only. Tests 2 and 3 run on a throwaway user because OLLAMA_BASE_URL and
// GOOGLE_API_KEY are per-user global variables every other spec shares through the
// superuser: collect-models imports the keys there and ollama-provider.spec.ts sets
// and deletes OLLAMA_BASE_URL.

const KB_API = "/api/v1/knowledge_bases";

/** One line — the failures below happen before any chunk is written. */
const SENTINEL_FILE = { name: "kb2044.txt", content: "kb2044 sentinel line\n" };
const CHUNKING = { chunkSize: 200, chunkOverlap: 0, separator: "\\n" };

/** A folder no lane has: the guarded routes must refuse before the path is read. */
const MISSING_FOLDER = "/nonexistent-kb2044";

/** The two models Google's v1beta endpoint answers 404 for (langflow-ai/langflow#12277). */
const RETIRED_GOOGLE_EMBEDDINGS = ["models/text-embedding-004", "models/embedding-001"];

function unique(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type KbCall = (request: APIRequestContext, url: string, headers: Record<string, string>) => Promise<APIResponse>;

/**
 * The eight routes `knowledge_bases.py` declares `_check_memory_base_association`
 * on (1.13.0.dev28), each with a schema-valid request so a 422 cannot stand in for
 * the guard. The operation string doubles as the API-coverage declaration.
 */
const GUARDED_ROUTES: Array<{ op: string; call: KbCall }> = [
  { op: `GET ${KB_API}/{kb_name}`, call: (r, url, headers) => r.get(url, { headers }) },
  { op: `GET ${KB_API}/{kb_name}/chunks`, call: (r, url, headers) => r.get(url, { headers }) },
  { op: `GET ${KB_API}/{kb_name}/metadata/keys`, call: (r, url, headers) => r.get(url, { headers }) },
  {
    op: `POST ${KB_API}/{kb_name}/ingest`,
    call: (r, url, headers) =>
      r.post(url, {
        headers,
        multipart: {
          files: { name: SENTINEL_FILE.name, mimeType: "text/plain", buffer: Buffer.from(SENTINEL_FILE.content) },
          chunk_size: String(CHUNKING.chunkSize),
          chunk_overlap: String(CHUNKING.chunkOverlap),
          separator: CHUNKING.separator,
        },
      }),
  },
  {
    op: `POST ${KB_API}/{kb_name}/ingest/folder`,
    call: (r, url, headers) => r.post(url, { headers, data: { path: MISSING_FOLDER, recursive: false } }),
  },
  {
    op: `POST ${KB_API}/{kb_name}/ingest/connector`,
    call: (r, url, headers) =>
      r.post(url, { headers, data: { source_type: "folder", source_config: { path: MISSING_FOLDER } } }),
  },
  { op: `POST ${KB_API}/{kb_name}/cancel`, call: (r, url, headers) => r.post(url, { headers }) },
  { op: `DELETE ${KB_API}/{kb_name}`, call: (r, url, headers) => r.delete(url, { headers }) },
];

function routeUrl(op: string, kbName: string): string {
  return op.split(" ")[1].replace("{kb_name}", kbName);
}

type KbState = KnowledgeBaseInfo & { status?: string; failure_reason?: string | null };

test.describe("core-functionality/memory — Memory Base ingestion failure modes", () => {
  let token: string;
  let flowId: string | null;
  /** Superuser-owned resources, deleted by id in afterEach. */
  let memoryIds: string[];
  let plainKbs: string[];
  /** Throwaway users and the knowledge bases each one created. */
  let users: Array<{ user: ThrowawayUser; kbs: string[] }>;

  const auth = () => ({ headers: { Authorization: token } });

  test.beforeEach(async ({ request }) => {
    flowId = null;
    memoryIds = [];
    plainKbs = [];
    users = [];
    token = await getAuthToken(request);
  });

  test.afterEach(async ({ request }) => {
    // Every step runs even when an earlier one throws, and the failures are
    // rethrown together at the end, so one failed delete can never skip the
    // flow's (the leak memory-base-ingestion.spec.ts measured, #2175).
    const failures: string[] = [];
    const attempt = async (step: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`${step}: ${String(e)}`);
      }
    };
    // Each user's knowledge bases go first, as that user: on 1.12.x deleting the user
    // does not remove a knowledge base's storage (1.13's background erase does, #2228).
    // Then the user, which takes its variables.
    for (const { user, kbs } of users) {
      for (const kb of kbs) {
        await attempt(`delete knowledge base ${kb}`, () =>
          deleteKnowledgeBase(user.request, kb, { headers: user.headers }),
        );
      }
      await attempt("delete the throwaway user", () =>
        deleteThrowawayUser(request, { Authorization: token }, user),
      );
    }
    for (const id of memoryIds) {
      await attempt(`delete memory base ${id}`, () => deleteMemoryBase(request, id, auth()));
    }
    for (const kb of plainKbs) {
      await attempt(`delete knowledge base ${kb}`, () => deleteKnowledgeBase(request, kb, auth()));
    }
    const owned = flowId;
    if (owned) await attempt(`delete flow ${owned}`, () => deleteFlow(request, owned, auth()));
    if (failures.length > 0) {
      throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
    }
  });

  async function newUser(
    request: APIRequestContext,
    newContext: () => Promise<APIRequestContext>,
    prefix: string,
  ): Promise<{ user: ThrowawayUser; kbs: string[] }> {
    let entry: { user: ThrowawayUser; kbs: string[] } | undefined;
    await createThrowawayUser(request, {
      superHeaders: { Authorization: token },
      newContext,
      prefix,
      track: (user) => {
        entry = { user, kbs: [] };
        users.push(entry);
      },
    });
    return entry!;
  }

  async function variableNames(user: ThrowawayUser): Promise<string[]> {
    const res = await user.request.get("/api/v1/variables/", { headers: user.headers });
    expect(res.status(), "GET /api/v1/variables/").toBe(200);
    return ((await res.json()) as Array<{ name: string }>).map((v) => v.name);
  }

  /** Creates a knowledge base as `owner` and starts one ingestion of the sentinel file. */
  async function startIngestion(
    owner: { user: ThrowawayUser; kbs: string[] },
    provider: string,
    model: string,
  ): Promise<{ kb: string; runId: string }> {
    const kb = await createKnowledgeBase(
      owner.user.request,
      { name: unique("kb2044"), embeddingProvider: provider, embeddingModel: model },
      { headers: owner.user.headers },
    );
    owner.kbs.push(kb);
    const runId = await ingestFiles(owner.user.request, kb, SENTINEL_FILE, CHUNKING, {
      headers: owner.user.headers,
    });
    return { kb, runId };
  }

  /**
   * The run ended `failed` with a message matching `message`, wrote nothing, and the
   * knowledge base recorded the same failure. Returns the settled run.
   */
  async function expectFailedIngestion(
    user: ThrowawayUser,
    kb: string,
    runId: string,
    message: RegExp,
  ): Promise<IngestionRun> {
    const headers = { headers: user.headers };
    const run = await waitForRunToFinish(user.request, kb, runId, headers);
    expect(run.status, `run ${runId}: ${run.error_message}`).toBe("failed");
    expect(run.error_message ?? "").toMatch(message);
    expect(run.chunks_created).toBe(0);
    expect(run.finished_at).toBeTruthy();

    const state = (await getKnowledgeBase(user.request, kb, headers)) as KbState;
    expect(state.status).toBe("failed");
    expect(state.failure_reason).toBe(run.error_message);
    expect((await listAllChunks(user.request, kb, {}, headers)).total).toBe(0);
    return run;
  }

  test(
    "should refuse every guarded knowledge-base route for a knowledge base a Memory Base manages",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/memories",
        "GET /api/v1/memories",
        "DELETE /api/v1/memories/{memory_base_id}",
        `POST ${KB_API}`,
        `DELETE ${KB_API}`,
        `GET ${KB_API}/{kb_name}/runs`,
        ...GUARDED_ROUTES.map((route) => route.op),
      ]);

      flowId = await createFlow(
        request,
        {
          name: unique("kb2044-guard"),
          description: "Owner flow for the §20.4 association-guard test",
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
        auth(),
      );
      const memory = await registerMemoryBase(
        request,
        { name: unique("kb2044mb"), flowId, embeddingModel: "text-embedding-3-small" },
        auth(),
      );
      memoryIds.push(memory.id);
      const kb = memory.kb_name;
      const refusal = `Access denied: knowledge base '${kb}' is managed by a Memory Base.`;

      for (const route of GUARDED_ROUTES) {
        await test.step(`${route.op} refuses it with the guard's own 403`, async () => {
          const res = await route.call(request, routeUrl(route.op, kb), auth().headers);
          expect(res.status(), `${route.op}: ${await res.text()}`).toBe(403);
          expect(await res.json()).toEqual({ detail: refusal });
        });
      }

      await test.step("the bulk delete skips it and names it", async () => {
        const res = await request.delete(KB_API, { ...auth(), data: { kb_names: [kb] } });
        expect(res.status(), await res.text()).toBe(200);
        const body = (await res.json()) as { deleted_count: number; memory_base_skipped?: unknown };
        expect(body.deleted_count).toBe(0);
        expect(body.memory_base_skipped).toBe(kb);
      });

      await test.step("the refusals refused: no run was started and the Memory Base is intact", async () => {
        // GET /{kb}/runs is not guarded (owner-scoped only), which is what makes the
        // refused ingestions observable from outside.
        expect(await listRuns(request, kb, auth())).toEqual([]);
        const listed = await listMemoryBases(request, flowId!, auth());
        expect(listed.map((m) => [m.id, m.kb_name])).toContainEqual([memory.id, kb]);
      });

      await test.step("a plain knowledge base answers the same routes normally", async () => {
        // Attribution control: the 403 above is the association, not ownership,
        // authentication or a missing knowledge base.
        const plain = await createKnowledgeBase(
          request,
          { name: unique("kb2044plain"), embeddingProvider: "OpenAI", embeddingModel: "text-embedding-3-small" },
          auth(),
        );
        plainKbs.push(plain);
        const expected: Record<string, number> = {
          [`GET ${KB_API}/{kb_name}`]: 200,
          [`GET ${KB_API}/{kb_name}/chunks`]: 200,
          [`GET ${KB_API}/{kb_name}/metadata/keys`]: 200,
          // The body reaches the route: the folder is refused, not the knowledge base.
          [`POST ${KB_API}/{kb_name}/ingest/folder`]: 400,
          [`POST ${KB_API}/{kb_name}/ingest/connector`]: 400,
          [`POST ${KB_API}/{kb_name}/cancel`]: 404,
          [`DELETE ${KB_API}/{kb_name}`]: 200,
        };
        // Ingesting would start a real embedding call; the seven others suffice.
        for (const route of GUARDED_ROUTES.filter((r) => r.op in expected)) {
          const res = await route.call(request, routeUrl(route.op, plain), auth().headers);
          const text = await res.text();
          expect(res.status(), `${route.op} on a plain knowledge base: ${text}`).toBe(expected[route.op]);
          expect(text).not.toContain("managed by a Memory Base");
        }
        plainKbs.splice(plainKbs.indexOf(plain), 1);
      });

      await test.step("deleting the Memory Base takes its knowledge base with it", async () => {
        await deleteMemoryBase(request, memory.id, auth());
        memoryIds.splice(memoryIds.indexOf(memory.id), 1);
        const res = await request.get(routeUrl(`GET ${KB_API}/{kb_name}`, kb), auth());
        expect(res.status(), await res.text()).toBe(404);
      });
    },
  );

  test(
    "should fail an ingestion whose embedding provider cannot be reached, naming the provider",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, playwright }) => {
      const owner = await newUser(
        request,
        () => playwright.request.newContext({ baseURL: test.info().project.use.baseURL }),
        "kbunreach",
      );

      await test.step("the user has configured neither OLLAMA_BASE_URL nor GOOGLE_API_KEY", async () => {
        const names = await variableNames(owner.user);
        expect(names).not.toContain("OLLAMA_BASE_URL");
        expect(names).not.toContain("GOOGLE_API_KEY");
      });

      // Both started before either is awaited: each takes ~22 s to fail on Ollama's
      // connection retries, and they do not depend on each other.
      const ollama = await startIngestion(owner, "Ollama", "all-minilm");
      const google = await startIngestion(owner, "Google Generative AI", "models/gemini-embedding-001");

      await test.step("Ollama, with no OLLAMA_BASE_URL, fails naming Ollama", async () => {
        await expectFailedIngestion(owner.user, ollama.kb, ollama.runId, /^Failed to connect to Ollama\b/);
      });

      await test.step("Google, with no GOOGLE_API_KEY, fails naming Google and the variable", async () => {
        await expectFailedIngestion(
          owner.user,
          google.kb,
          google.runId,
          /^Google Generative AI API key is required\b.*\bGOOGLE_API_KEY\b/,
        );
      });
    },
  );

  test(
    "should send an Ollama ingestion to the server OLLAMA_BASE_URL names",
    { tag: ["@stable", "@regression", "@api", "@files"] },
    async ({ request, playwright }) => {
      // Regression for langflow-ai/langflow#13883: ingestion built its embeddings
      // with the component's localhost default, which outranked OLLAMA_BASE_URL.
      const oracle = await readOllamaCapabilities(request, ollamaBaseUrl());
      test.skip(!oracle.reachable, oracle.reachable ? "" : `${oracle.reason} — this test needs the lane's Ollama`);
      const served = oracle.reachable ? oracle.classes.tags : [];

      const owner = await newUser(
        request,
        () => playwright.request.newContext({ baseURL: test.info().project.use.baseURL }),
        "kbollama",
      );

      let model = "";

      await test.step("pick a catalog Ollama embedding model the server does not serve", async () => {
        // Read before OLLAMA_BASE_URL exists for this user, so the catalog is
        // Langflow's own list rather than whatever the server reports.
        const catalog = (await readEmbeddingCatalog(owner.user.request, { headers: owner.user.headers }))
          .filter((row) => row.provider === "Ollama")
          .map((row) => row.model);
        expect(catalog.length, "Langflow's catalog lists no Ollama embedding model").toBeGreaterThan(0);
        const unserved = firstUnservedModel(catalog, served);
        test.skip(
          unserved === undefined,
          `the Ollama at ${ollamaBaseUrl()} serves every catalog embedding model (${catalog.join(", ")})`,
        );
        model = unserved!;
      });

      await test.step("OLLAMA_BASE_URL is set to the lane's Ollama", async () => {
        // Langflow validates the address before storing it (400 "Invalid Ollama base
        // URL" for one it cannot reach), so a 201 means Langflow reached the server.
        const res = await owner.user.request.post("/api/v1/variables/", {
          headers: owner.user.headers,
          data: { name: "OLLAMA_BASE_URL", value: ollamaBaseUrlFromLangflow(), type: "Generic", default_fields: [] },
        });
        expect(res.status(), await res.text()).toBe(201);
      });

      const { kb, runId } = await startIngestion(owner, "Ollama", model);

      await test.step("the run fails with the configured server's own answer", async () => {
        const run = await expectFailedIngestion(
          owner.user,
          kb,
          runId,
          new RegExp(`^model "${escapeRegExp(model)}" not found\\b.*\\bstatus code: 404\\b`),
        );
        // What the run said before the fix, when it called localhost instead.
        expect(run.error_message).not.toMatch(/Failed to connect to Ollama/);
      });
    },
  );

  test(
    "should keep the Google embedding models the Knowledge dialog offers to ones Google still serves",
    { tag: ["@stable", "@regression", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      // Regression for langflow-ai/langflow#12277: the dialog offered only Google
      // embedding models Google had retired, so every Google ingestion failed 404.
      apiCoverage.declare(["GET /api/v1/models"]);
      const google = (rows: Awaited<ReturnType<typeof readEmbeddingCatalog>>) =>
        rows.filter((row) => row.provider === "Google Generative AI");

      // The query the Create Knowledge Base dialog issues when it opens.
      const offered = google(await readEmbeddingCatalog(request, auth()));
      const catalog = google(await readEmbeddingCatalog(request, { ...auth(), includeDeprecated: true }));
      const offeredNames = offered.map((row) => row.model);

      await test.step("the dialog offers Google embedding models", async () => {
        // Non-empty, or "no retired model is offered" would hold vacuously.
        expect(offeredNames.length).toBeGreaterThan(0);
      });

      await test.step("none of them is deprecated or one of the two #12277 retired", async () => {
        expect(offered.filter((row) => row.deprecated)).toEqual([]);
        for (const retired of RETIRED_GOOGLE_EMBEDDINGS) expect(offeredNames).not.toContain(retired);
      });

      await test.step("every model the catalog flags deprecated is one the dialog leaves out", async () => {
        for (const row of catalog.filter((r) => r.deprecated)) expect(offeredNames).not.toContain(row.model);
      });
    },
  );
});
