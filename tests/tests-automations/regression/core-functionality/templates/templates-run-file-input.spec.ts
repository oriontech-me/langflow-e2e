import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect, test, type PageWithErrorHooks } from "../../../../fixtures/fixtures";
import { retryOnDroppedConnection } from "../../../../helpers/api/retry-on-dropped-connection";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  buildableNodes,
  componentNodes,
  field,
  inspectionControl,
  modelPairs,
  nodesOfType,
  onlyNode,
  ranField,
  readNodeOutput,
  readTemplate,
  resolveModelOption,
  type FlowData,
  type FlowEdge,
} from "../../../../helpers/flows/template-run";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { isRunRequest } from "../../../../helpers/flows/watch-run-model-binding";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { resolveGptModel } from "../../../../helpers/provider-setup/resolve-gpt-model";

// §11.4 — the three file-input templates EXECUTE on a plain-text file the test uploads, on
// one model the test chose (#2461, row E3 of
// docs/core-functionality/templates/templates-coverage-scope.md). The file goes in through
// the API in the shape the Read File node's own upload writes; the upload UI is
// upload-via-component.spec.ts's. Siblings: templates-run-prompts.spec.ts (E1, #2459) and
// templates-run-knowledge.spec.ts (E4, #2045), sharing helpers/flows/template-run.ts (#2467).
// Spec doc: docs/core-functionality/templates/templates-run-file-input.md

interface TemplateUnderTest {
  /** Exact name in `GET /api/v1/flows/basic_examples/`. */
  name: string;
  /** Every model node is an Agent; how many the template has. */
  agents: number;
  /** How many of those Agents the Read File node feeds directly. */
  fileFedAgents: number;
  /** One AI message per Chat Output. */
  chatOutputs: number;
  /**
   * The component types whose output-inspection control must go disabled → enabled,
   * sorted. Derived from the template at run time and compared with this list, so an
   * upstream edit fails naming the difference instead of shrinking the check.
   */
  builtTypes: string[];
  /** The plain-text document the test uploads, carrying the per-test nonce. */
  fixture: (nonce: string) => string;
}

const FINANCIAL_REPORT_PARSER: TemplateUnderTest = {
  name: "Financial Report Parser",
  agents: 1,
  fileFedAgents: 1,
  chatOutputs: 1,
  // Its Chat Output ships with `showNode: false` and renders no control; the reply
  // itself is that node's output.
  builtTypes: ["Agent", "File", "ParserComponent"],
  fixture: (nonce) =>
    `Kestrel Dynamics - Annual Report FY2026 (reference ${nonce})\n` +
    "Revenue: $12.4 million\n" +
    "Gross profit: $5.1 million\n" +
    "EBITDA: $2.3 million\n" +
    "Operating income (EBIT): $1.9 million\n" +
    "Net income: $1.2 million\n" +
    "Net margin: 9.7%\n",
};
const PORTFOLIO_WEBSITE_CODE_GENERATOR: TemplateUnderTest = {
  name: "Portfolio Website Code Generator",
  agents: 1,
  fileFedAgents: 1,
  chatOutputs: 1,
  builtTypes: ["Agent", "File"],
  fixture: (nonce) =>
    `Jordan Avery - Software Engineer (reference ${nonce})\n` +
    "Summary: Backend engineer with six years of experience building data pipelines.\n" +
    "Experience: Acme Corp, Senior Engineer, 2021-2026.\n" +
    "Skills: Python, TypeScript, PostgreSQL.\n" +
    "Contact: jordan.avery@example.com\n",
};
const TEXT_SENTIMENT_ANALYSIS: TemplateUnderTest = {
  name: "Text Sentiment Analysis",
  agents: 3,
  // Agents A and C read the file; Agent B reads Agent A's output through the Prompt.
  fileFedAgents: 2,
  chatOutputs: 2,
  builtTypes: ["Agent", "Agent", "Agent", "File", "Prompt"],
  fixture: (nonce) =>
    `Community discussion digest (reference ${nonce})\n` +
    "User A: The new flow editor is great, but saving large flows is slow.\n" +
    "User B: I love the Playground; please add keyboard shortcuts.\n" +
    "User C: The docs for custom components are confusing.\n",
};

/** The `POST /api/v2/files` response fields this spec uses. */
interface UploadedFile {
  id: string;
  name: string;
  path: string;
}

function newNonce(): string {
  return `tpl2461-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("core-functionality/templates — file-input templates run (§11.4)", () => {
  let token: string;
  /** The flow this test created, deleted by id in afterEach. */
  let flowId: string | null;
  /** The file this test uploaded, deleted by id in afterEach — it outlives the flow. */
  let fileId: string | null;

  const auth = () => ({ Authorization: token });

  test.beforeEach(async ({ request }) => {
    // Reset BEFORE the gate: a skip still runs afterEach, which must then find nothing
    // to clean rather than the previous test's state.
    flowId = null;
    fileId = null;

    // Gate on the health collect-models recorded, not on the env var alone (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    token = await getAuthToken(request);
  });

  test.afterEach(async ({ page, request }) => {
    const failures: string[] = [];
    const flow = flowId;
    if (flow) {
      // Leave the editor first so its polls stop hitting the flow being deleted.
      await unmountEditorForCleanup(page, "/");
      try {
        // A re-dialled DELETE is safe: deleteFlow reads a 404 as already gone.
        await retryOnDroppedConnection(() => deleteFlow(request, flow, { headers: auth() }));
      } catch (e) {
        failures.push(String(e));
      }
    }
    const file = fileId;
    if (file) {
      try {
        const res = await retryOnDroppedConnection(() =>
          request.delete(`/api/v2/files/${file}`, { headers: auth() }),
        );
        if (!res.ok() && res.status() !== 404) {
          failures.push(`DELETE /api/v2/files/${file} → ${res.status()}`);
        }
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length > 0) {
      throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
    }
  });

  async function runFileTemplate(
    page: Page,
    request: APIRequestContext,
    template: TemplateUnderTest,
  ): Promise<void> {
    const headers = auth();
    const nonce = newNonce();

    // Resolved up front so a missing catalog fails before anything is created.
    const model = resolveGptModel();
    if (!model) {
      throw new Error(
        "No OpenAI chat model in models.json — run `npx playwright test " +
          "tests/collect-models.spec.ts` first. The template must run a model the test " +
          "chose, never its first option (gpt-5.5-pro).",
      );
    }

    let uploaded: UploadedFile | null = null;
    let fileNodeId = "";
    let parserId = "";
    let agentIds: string[] = [];
    let builtNodeIds: string[] = [];

    await test.step("upload the fixture file", async () => {
      // Not re-dialled: a retried POST whose first attempt landed would leave a second file.
      const res = await request.post("/api/v2/files", {
        headers,
        multipart: {
          file: {
            name: `tpl-${nonce}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(template.fixture(nonce)),
          },
        },
      });
      expect(res.status(), `POST /api/v2/files: ${(await res.text()).slice(0, 200)}`).toBe(201);
      uploaded = (await res.json()) as UploadedFile;
      fileId = uploaded.id;
    });

    await test.step(`create the ${template.name} flow on that file, pinned to ${model}`, async () => {
      const file = uploaded as UploadedFile | null;
      if (!file) throw new Error("the fixture upload produced no file");
      const option = await resolveModelOption(request, model, headers);
      const { data, description } = await readTemplate(request, template.name, headers);

      const modelNodes = componentNodes(data).filter(
        (n) => n.data?.node?.template?.model?.type === "model",
      );
      expect(
        modelNodes.map((n) => n.data?.type),
        `${template.name}: the model nodes this spec pins`,
      ).toEqual(Array(template.agents).fill("Agent"));
      for (const node of modelNodes) {
        field(node, "model", template.name).value = [{ ...option }];
      }
      agentIds = modelNodes.map((n) => n.id);

      expect(
        nodesOfType(data, "ChatInput"),
        `${template.name}: a file-input template has no Chat Input`,
      ).toHaveLength(0);
      expect(nodesOfType(data, "ChatOutput"), `${template.name}: Chat Outputs`).toHaveLength(
        template.chatOutputs,
      );

      // A tool builds only when the model calls it; a hidden node renders no control.
      const built = buildableNodes(data);
      expect(
        built.map((n) => n.type).sort(),
        `${template.name}: the components whose build this spec checks`,
      ).toEqual(template.builtTypes);
      builtNodeIds = built.map((n) => n.id);

      // The File → Agent edges are what make "the file was read" mean "the Agents got it".
      const fileNode = onlyNode(data, "File", template.name);
      fileNodeId = fileNode.id;
      const fedAgents = data.edges.filter(
        (e) =>
          e.source === fileNode.id &&
          agentIds.includes(e.target) &&
          e.data?.targetHandle?.fieldName === "input_value",
      );
      expect(
        fedAgents.map((e) => e.target).sort(),
        `${template.name}: the Agents the Read File node feeds`,
      ).toHaveLength(template.fileFedAgents);

      // The shape the node's own upload writes (measured: display name + server path).
      const path = field(fileNode, "path", template.name);
      path.value = [file.name];
      path.file_path = [file.path];

      if (template === FINANCIAL_REPORT_PARSER) {
        parserId = onlyNode(data, "ParserComponent", template.name).id;
      }

      flowId = await createFlow(
        request,
        { name: `${template.name} ${nonce}`, description, data, is_component: false },
        { headers },
      );
    });

    let runBody: unknown = null;

    await test.step("run it from the Playground", async () => {
      await page.goto(`/flow/${flowId}`);
      // The editor can sit on "Loading..." for over 30 s on a loaded host (measured in a
      // burst on 1.14.0.dev29); name that, instead of a node control that is "not found".
      await expect(
        page.getByTestId("canvas_controls_dropdown"),
        "the flow editor did not finish loading",
      ).toBeVisible({ timeout: 60000 });
      // Fresh flow: no component has an output yet. This is what makes the enabled
      // state after the run attributable to this run.
      for (const id of builtNodeIds) {
        await expect(
          inspectionControl(page, id),
          `node ${id} should have no output before the run`,
        ).toBeDisabled({ timeout: 30000 });
      }

      await page.getByTestId("playground-btn-flow-io").click();
      await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByTestId("input-chat-playground"),
        "a template with no Chat Input renders no text input",
      ).toHaveCount(0);

      // Armed before the send, or the capture races the request it reads.
      const runRequest = page.waitForRequest((r: Request) => isRunRequest(r), {
        timeout: 60000,
      });
      await page.getByTestId("button-send").click();
      // A graph the Playground will not run leaves the send control enabled and sends
      // nothing (measured on #2459) — name that instead of a bare timeout.
      const sent = await runRequest.catch((e: unknown) => {
        throw new Error(
          "the Playground sent no run request (POST /api/v2/workflows) within 60 s — " +
            `the run never started (${String(e).split("\n")[0]})`,
        );
      });
      try {
        runBody = sent.postDataJSON();
      } catch {
        runBody = null;
      }
    });

    await test.step("the run carried the test's file, the pinned model and every Agent's input", async () => {
      // The run builds its live-canvas payload, not the saved flow, so this is where
      // a silent fallback shows (#1372, #1678).
      const savedFlow = async () => {
        const res = await retryOnDroppedConnection(() =>
          request.get(`/api/v1/flows/${flowId}`, { headers }),
        );
        return ((await res.json()) as { data: FlowData }).data;
      };
      expect(
        (await ranField(runBody, savedFlow, fileNodeId, "path"))?.file_path,
        "the file the Read File node ran on",
      ).toEqual([(uploaded as UploadedFile | null)?.path]);
      for (const id of agentIds) {
        expect(
          modelPairs((await ranField(runBody, savedFlow, id, "model"))?.value),
          `Agent ${id} ran`,
        ).toEqual([`${model} / OpenAI`]);
      }
      // Every Agent must have something wired into its input in the graph the run
      // executed. An Agent with none still answers from its system prompt alone, so a
      // lost edge passed every other check (measured by force-fail on Text Sentiment
      // Analysis's Prompt → Agent B edge).
      const live = (runBody as { data?: { edges?: unknown } } | null)?.data?.edges;
      const runEdges = Array.isArray(live) ? (live as FlowEdge[]) : (await savedFlow()).edges;
      for (const id of agentIds) {
        expect(
          runEdges.some(
            (e) => e.target === id && e.data?.targetHandle?.fieldName === "input_value",
          ),
          `Agent ${id} ran with nothing wired into its input`,
        ).toBe(true);
      }
    });

    await test.step("every Chat Output replied", async () => {
      const replies = page.locator('[data-testid^="chat-message-AI-"]');
      await expect(replies).toHaveCount(template.chatOutputs, { timeout: 180000 });
      await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 180000 });
      await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 10000 });
      // The model's wording is never asserted: each output must exist, not be good. An
      // empty message renders as the placeholder "Message empty.", so a bare
      // non-whitespace check would pass on an empty reply.
      for (let i = 0; i < template.chatOutputs; i++) {
        await expect(replies.nth(i), `reply ${i + 1} should not be empty`).not.toHaveText(
          /^\s*(Message empty\.)?\s*$/,
        );
      }
      await page.getByTestId("playground-close-button").click();
      await expect(page.getByTestId("button-send")).toBeHidden({ timeout: 10000 });
    });

    await test.step("every component that should build did", async () => {
      for (const id of builtNodeIds) {
        await expect(
          inspectionControl(page, id),
          `node ${id} has no output to display — it did not build`,
        ).toBeEnabled({ timeout: 15000 });
      }
    });

    await test.step("the Read File node read the test's file", async () => {
      // The node's own reading of the fixture, not model output.
      expect(await readNodeOutput(page, fileNodeId, "output-inspection-raw content-file")).toContain(
        nonce,
      );
    });

    if (template === FINANCIAL_REPORT_PARSER) {
      await test.step("the Agent's structured output reached the Parser", async () => {
        // The template's table skeleton is Langflow's formatting; the values in it are
        // the model's extraction and are not asserted.
        expect(
          await readNodeOutput(page, parserId, "output-inspection-parsed text-parsercomponent"),
        ).toContain("| Metric | Value |");
      });
    }

    await test.step("the flow-error report is evaluated and clean", async () => {
      const report = await (page as PageWithErrorHooks).flowErrorReport();
      // `clean` is vacuously true when nothing was read, so both are asserted (#1452).
      expect(report.evaluated, report.summary).toBeGreaterThan(0);
      expect(report.clean, report.summary).toBe(true);
    });
  }

  test(
    "should run Financial Report Parser on an uploaded report through its Parser",
    { tag: ["@stable", "@release", "@templates", "@playground", "@files", "@agents"] },
    async ({ page, request }) => {
      await runFileTemplate(page, request, FINANCIAL_REPORT_PARSER);
    },
  );

  test(
    "should run Portfolio Website Code Generator on an uploaded resume",
    { tag: ["@stable", "@release", "@templates", "@playground", "@files", "@agents"] },
    async ({ page, request }) => {
      await runFileTemplate(page, request, PORTFOLIO_WEBSITE_CODE_GENERATOR);
    },
  );

  test(
    "should run Text Sentiment Analysis on an uploaded digest to both of its Chat Outputs",
    { tag: ["@stable", "@release", "@templates", "@playground", "@files", "@agents"] },
    async ({ page, request }) => {
      await runFileTemplate(page, request, TEXT_SENTIMENT_ANALYSIS);
    },
  );
});
