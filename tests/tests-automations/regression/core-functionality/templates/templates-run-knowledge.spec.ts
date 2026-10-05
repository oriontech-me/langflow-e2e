import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect, test, type PageWithErrorHooks } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { isRunRequest } from "../../../../helpers/flows/watch-run-model-binding";
import {
  ingestFiles,
  listAllChunks,
  waitForRunToFinish,
} from "../../../../helpers/knowledge/ingestion";
import {
  assertEmbeddingCredentialConfigured,
  createKnowledgeBase,
  deleteKnowledgeBase,
} from "../../../../helpers/knowledge/knowledge-base";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { resolveGptModel } from "../../../../helpers/provider-setup/resolve-gpt-model";
import { PlaygroundPage } from "../../../../pages/PlaygroundPage";

// §11.5 — the three knowledge-base templates EXECUTE against a knowledge base the
// test fills (#2045, row E4 of docs/core-functionality/templates/templates-coverage-scope.md).
// Instantiation through the gallery is S1's (templates-instantiate.spec.ts), which proves
// the created flow equals the `basic_examples` entry this spec reads — so the flow is
// created from that entry through the API, id-addressed and private to the test.
// Spec doc: docs/core-functionality/templates/templates-run-knowledge.md

/** The #2043 embedding: the only provider this file needs, with the Agent's model. */
const EMBEDDING = { provider: "OpenAI", modelId: "text-embedding-3-small" };

/** The dialog's defaults. The document is far shorter than one chunk either way. */
const INGEST_SETTINGS = { chunkSize: 1000, chunkOverlap: 200, separator: "\\n" };

const QUESTION = "What is the Kestrel access codename?";

interface TemplateUnderTest {
  /** Exact name in `GET /api/v1/flows/basic_examples/`. */
  name: string;
  /** Knowledge Retrieval has no LLM; the two RAG templates end in an Agent. */
  hasAgent: boolean;
}

const KNOWLEDGE_RETRIEVAL: TemplateUnderTest = { name: "Knowledge Retrieval", hasAgent: false };
const DOCUMENT_QA: TemplateUnderTest = { name: "Document Q&A", hasAgent: true };
const VECTOR_STORE_RAG: TemplateUnderTest = { name: "Vector Store RAG", hasAgent: true };

type TemplateField = { value?: unknown; options?: unknown[] } | undefined;

interface FlowNode {
  id: string;
  type?: string;
  data?: { type?: string; node?: { template?: Record<string, TemplateField> } };
}

interface FlowData {
  nodes: FlowNode[];
  edges: unknown[];
  [key: string]: unknown;
}

/**
 * A per-test token only this test's ingestion can put in a reply: a stale message or
 * a knowledge base left over from another run cannot contain it.
 */
function newNonce(): string {
  return `kb2045-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Three short lines — one chunk under the defaults — with the nonce in the middle one. */
function sentinelDocument(nonce: string): string {
  return (
    "Project Kestrel field notes.\n" +
    `The Kestrel access codename is ${nonce}.\n` +
    "Kestrel ships quarterly.\n"
  );
}

/** The template as the image registers it, deep-copied so the pins never leak. */
async function readTemplate(
  request: APIRequestContext,
  name: string,
  headers: Record<string, string>,
): Promise<{ data: FlowData; description: string }> {
  const url = "/api/v1/flows/basic_examples/";
  const res = await request.get(url, { headers });
  if (res.status() !== 200) {
    throw new Error(`GET ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  const listing = (await res.json()) as Array<{
    name?: string;
    description?: string;
    data?: FlowData;
  }>;
  const entry = listing.find((f) => f.name === name);
  if (!entry?.data) {
    throw new Error(
      `Template "${name}" is not in ${url} (registered: ` +
        `${listing.map((f) => f.name).join(", ")}). templates-registration.spec.ts ` +
        `names a missing template; this spec cannot run one that is not there.`,
    );
  }
  return {
    data: JSON.parse(JSON.stringify(entry.data)) as FlowData,
    description: entry.description ?? "",
  };
}

/**
 * The one component node of `type` in the template. Exactly one, because every pin and
 * every locator below is keyed on it — a template that gained a second one must be
 * re-read by a human, not pinned at random.
 */
function onlyNode(data: FlowData, type: string, template: string): FlowNode {
  const matches = data.nodes.filter((n) => n.type === "genericNode" && n.data?.type === type);
  if (matches.length !== 1) {
    throw new Error(
      `Template "${template}" has ${matches.length} "${type}" component(s); this spec ` +
        `expects exactly one. The template changed upstream — re-read it before pinning.`,
    );
  }
  return matches[0];
}

function field(node: FlowNode, name: string, template: string): NonNullable<TemplateField> {
  const f = node.data?.node?.template?.[name];
  if (!f) {
    throw new Error(
      `Template "${template}": node ${node.id} (${node.data?.type}) has no ` +
        `template.${name} field — the pin would silently leave it unset.`,
    );
  }
  return f;
}

/**
 * The value a node field carried in the run, read off the object the run builds from:
 * the request's live-canvas `data` (which takes priority over the saved flow, #1372),
 * or — when the request carried none — the saved flow itself.
 */
async function ranFieldValue(
  runBody: unknown,
  savedFlow: () => Promise<FlowData>,
  nodeId: string,
  fieldName: string,
): Promise<unknown> {
  const live = (runBody as { data?: { nodes?: unknown } } | null)?.data?.nodes;
  const nodes = Array.isArray(live) ? (live as FlowNode[]) : (await savedFlow()).nodes;
  return nodes.find((n) => n?.id === nodeId)?.data?.node?.template?.[fieldName]?.value;
}

/** `name / provider` for each entry of a unified model selector value. */
function modelPairs(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map((e) =>
    e !== null && typeof e === "object"
      ? `${(e as { name?: unknown }).name} / ${(e as { provider?: unknown }).provider}`
      : String(e),
  );
}

/** The output-inspection dialog (it is the only dialog carrying the copy button). */
function outputDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByTestId("copy-output-button") });
}

/**
 * Closes it through its own button and proves it closed. Escape does not close it
 * while focus is inside the results grid (measured on 1.13.0.dev25), and a dialog left
 * open intercepts every later click on the canvas.
 */
async function closeOutputDialog(page: Page): Promise<void> {
  const dialog = outputDialog(page);
  await dialog.getByTestId("btn-close-modal").click();
  await expect(dialog).toBeHidden({ timeout: 5000 });
}

test.describe("core-functionality/templates — knowledge-base templates run (§11.5)", () => {
  let token: string;
  /** The flow this test created, deleted by id in afterEach. */
  let flowId: string | null;
  /** The knowledge base this test created, deleted by dir_name in afterEach. */
  let dirName: string | null;

  const auth = () => ({ Authorization: token });

  test.beforeEach(async ({ request }) => {
    // Reset BEFORE the gate: a skip still runs afterEach, which must then find nothing
    // to clean rather than the previous test's state.
    flowId = null;
    dirName = null;

    // OpenAI embeds the sentinel and backs the Agent, so gate on the health
    // collect-models recorded, not on the env var alone (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    token = await getAuthToken(request);
    // Ingestion and retrieval resolve embeddings from the Langflow credential, not
    // the env var; without it every ingest fails with a misleading error.
    await assertEmbeddingCredentialConfigured(request, "OPENAI_API_KEY", {
      headers: auth(),
    });
  });

  test.afterEach(async ({ page, request }) => {
    const failures: string[] = [];
    if (flowId) {
      // Leave the editor first so its polls stop hitting the flow being deleted.
      await unmountEditorForCleanup(page, "/");
      try {
        await deleteFlow(request, flowId, { headers: auth() });
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (dirName) {
      try {
        await deleteKnowledgeBase(request, dirName, { headers: auth() });
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length > 0) {
      throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
    }
  });

  async function runKnowledgeTemplate(
    page: Page,
    request: APIRequestContext,
    template: TemplateUnderTest,
  ): Promise<void> {
    const nonce = newNonce();
    const headers = auth();

    // Resolved up front so a missing catalog fails before anything is created.
    const model = template.hasAgent ? resolveGptModel() : undefined;
    if (template.hasAgent && !model) {
      throw new Error(
        "No OpenAI chat model in models.json — run `npx playwright test " +
          "tests/collect-models.spec.ts` first. The Agent must run a model the test " +
          "chose, never the template's first option (gpt-5.5-pro).",
      );
    }

    await test.step("fill a knowledge base with the sentinel document", async () => {
      dirName = await createKnowledgeBase(
        request,
        {
          name: `kb_tpl_${nonce}`,
          embeddingProvider: EMBEDDING.provider,
          embeddingModel: EMBEDDING.modelId,
        },
        { headers },
      );
      const runId = await ingestFiles(
        request,
        dirName,
        { name: `sentinel-${nonce}.txt`, content: sentinelDocument(nonce) },
        INGEST_SETTINGS,
        { headers },
      );
      const run = await waitForRunToFinish(request, dirName, runId, { headers });
      expect(run.status, `ingestion run: ${run.error_message ?? "no error message"}`).toBe(
        "succeeded",
      );
      // Precondition proof: a later retrieval miss cannot be an ingestion miss.
      const { chunks } = await listAllChunks(request, dirName, {}, { headers });
      expect(chunks, "the knowledge base should hold exactly one chunk").toHaveLength(1);
      expect(chunks[0].content).toContain(nonce);
    });

    let knowledgeId = "";
    let promptId = "";
    let agentId = "";

    await test.step(`create the ${template.name} flow pinned to that knowledge base`, async () => {
      const { data, description } = await readTemplate(request, template.name, headers);
      // Every template here routes Chat Input -> Knowledge -> Parser; the pins and the
      // locators below are keyed on these node ids.
      onlyNode(data, "ChatInput", template.name);
      onlyNode(data, "parser", template.name);
      onlyNode(data, "ChatOutput", template.name);

      const knowledge = onlyNode(data, "Knowledge", template.name);
      knowledgeId = knowledge.id;
      expect(field(knowledge, "mode", template.name).value, "Knowledge node mode").toBe(
        "Retrieve",
      );
      // The dropdown treats a value as selected only when it is also in `options`.
      const kb = field(knowledge, "knowledge_base", template.name);
      kb.value = dirName;
      kb.options = [dirName];

      if (template.hasAgent) {
        promptId = onlyNode(data, "Prompt", template.name).id;
        const agent = onlyNode(data, "Agent", template.name);
        agentId = agent.id;
        const modelField = field(agent, "model", template.name);
        // The template's own OpenAI entry supplies the provider metadata (model class,
        // parameter names); only the model name changes.
        const openaiOption = (modelField.options ?? []).find(
          (o) =>
            o !== null &&
            typeof o === "object" &&
            (o as { provider?: unknown }).provider === "OpenAI",
        );
        if (!openaiOption) {
          throw new Error(
            `Template "${template.name}": the Agent's model options carry no OpenAI ` +
              `entry to pin ${model} from.`,
          );
        }
        modelField.value = [{ ...(openaiOption as object), name: model }];
      }

      flowId = await createFlow(
        request,
        { name: `${template.name} ${nonce}`, description, data, is_component: false },
        { headers },
      );
    });

    const playground = new PlaygroundPage(page);
    let runBody: unknown = null;

    await test.step("ask the question in the Playground", async () => {
      await page.goto(`/flow/${flowId}`);
      await expect(
        page.locator(`[data-id="${knowledgeId}"]`).getByTestId("title-knowledge"),
      ).toBeVisible({ timeout: 30000 });
      await page.getByTestId("playground-btn-flow-io").click();
      await expect(page.getByTestId("input-chat-playground")).toBeVisible({ timeout: 30000 });

      // Armed before the send, or the capture races the request it reads.
      const runRequest = page.waitForRequest((r: Request) => isRunRequest(r), {
        timeout: 60000,
      });
      await playground.sendMessage(QUESTION);
      const sent = await runRequest;
      try {
        runBody = sent.postDataJSON();
      } catch {
        runBody = null;
      }
    });

    await test.step("the run carried the pinned knowledge base and model", async () => {
      // The run builds its live-canvas payload, not the saved flow, so this is where
      // a silent fallback shows (#1372, #1678).
      const savedFlow = async () => {
        const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
        return ((await res.json()) as { data: FlowData }).data;
      };
      expect(
        await ranFieldValue(runBody, savedFlow, knowledgeId, "knowledge_base"),
        "knowledge base the run used",
      ).toBe(dirName);
      if (template.hasAgent) {
        expect(
          modelPairs(await ranFieldValue(runBody, savedFlow, agentId, "model")),
          "model the Agent ran",
        ).toEqual([`${model} / OpenAI`]);
      }
    });

    await test.step("the reply completes", async () => {
      // Model-agnostic completion: the bot bubble mounted, then the stop control gone
      // and the send control back (memory-history-regression.spec.ts, #354/#569).
      const replies = page.getByTestId("div-chat-message");
      await expect(replies).toHaveCount(1, { timeout: 120000 });
      await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 120000 });
      await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 10000 });
      const reply = (await replies.last().innerText()).trim();
      if (template.hasAgent) {
        // The model's wording is never asserted: repeating the retrieved text would
        // be the model choosing to comply.
        expect(reply.length, "the Agent's reply should not be empty").toBeGreaterThan(0);
      } else {
        // No LLM: the reply IS the Parser's formatting of the retrieved row.
        expect(reply).toContain(nonce);
      }
      await page.getByTestId("playground-close-button").click();
      await expect(page.getByTestId("input-chat-playground")).toBeHidden({ timeout: 10000 });
    });

    await test.step("the Knowledge node retrieved the sentinel", async () => {
      const inspect = page
        .locator(`[data-id="${knowledgeId}"]`)
        .getByTestId("output-inspection-results-knowledge");
      // An empty retrieval leaves the control disabled ("Output can't be displayed");
      // name that here instead of spending the click budget on it (measured by FF).
      await expect(
        inspect,
        "the Knowledge node has no output to display — retrieval returned nothing",
      ).toBeEnabled({ timeout: 15000 });
      await inspect.click();
      // One chunk in the knowledge base and top_k = 5: exactly one row, with the nonce.
      const rows = outputDialog(page).locator(".ag-center-cols-container [row-index]");
      await expect(rows).toHaveCount(1, { timeout: 15000 });
      await expect(rows.filter({ hasText: nonce })).toHaveCount(1);
      await closeOutputDialog(page);
    });

    if (template.hasAgent) {
      await test.step("the retrieved sentinel reached the Agent's prompt", async () => {
        const inspect = page
          .locator(`[data-id="${promptId}"]`)
          .getByTestId("output-inspection-prompt-prompt");
        await expect(inspect, "the Prompt node has no output to display").toBeEnabled({
          timeout: 15000,
        });
        await inspect.click();
        // Langflow's formatting of {context} and {question}, not model output: the
        // model-free proof that retrieval fed the answer path.
        const prompt = outputDialog(page).locator("textarea");
        await expect(prompt).toBeVisible({ timeout: 15000 });
        const text = await prompt.inputValue();
        expect(text).toContain(nonce);
        expect(text).toContain(QUESTION);
        await closeOutputDialog(page);
      });
    }

    await test.step("the flow-error report is evaluated and clean", async () => {
      const report = await (page as PageWithErrorHooks).flowErrorReport();
      // `clean` is vacuously true when nothing was read, so both are asserted (#1452).
      expect(report.evaluated, report.summary).toBeGreaterThan(0);
      expect(report.clean, report.summary).toBe(true);
    });
  }

  // Quarantined for #2175: hard failure on the VM daily of 2026-10-05 (1.13.0.dev33), a guard-tripped
  // day judged non-environmental. Upstream langflow-ai/langflow#15509 removed Chroma, which this
  // spec still uses. Lifting it (drop `test.fixme`, restore `@stable`) is #2175's deliverable.
  test.fixme(
    "should run Knowledge Retrieval and show the ingested sentinel in its reply",
    { tag: ["@release", "@templates", "@playground"] },
    async ({ page, request }) => {
      await runKnowledgeTemplate(page, request, KNOWLEDGE_RETRIEVAL);
    },
  );

  // Quarantined for #2175: hard failure on the VM daily of 2026-10-05 (1.13.0.dev33), a guard-tripped
  // day judged non-environmental. Upstream langflow-ai/langflow#15509 removed Chroma, which this
  // spec still uses. Lifting it (drop `test.fixme`, restore `@stable`) is #2175's deliverable.
  test.fixme(
    "should run Document Q&A with the ingested sentinel in the Agent's prompt",
    { tag: ["@release", "@templates", "@playground"] },
    async ({ page, request }) => {
      await runKnowledgeTemplate(page, request, DOCUMENT_QA);
    },
  );

  // Quarantined for #2175: hard failure on the VM daily of 2026-10-05 (1.13.0.dev33), a guard-tripped
  // day judged non-environmental. Upstream langflow-ai/langflow#15509 removed Chroma, which this
  // spec still uses. Lifting it (drop `test.fixme`, restore `@stable`) is #2175's deliverable.
  test.fixme(
    "should run Vector Store RAG with the ingested sentinel in the Agent's prompt",
    { tag: ["@release", "@templates", "@playground"] },
    async ({ page, request }) => {
      await runKnowledgeTemplate(page, request, VECTOR_STORE_RAG);
    },
  );
});
