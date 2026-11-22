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
} from "../../../../helpers/flows/template-run";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { isRunRequest } from "../../../../helpers/flows/watch-run-model-binding";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { resolveGptModel } from "../../../../helpers/provider-setup/resolve-gpt-model";

// §11.3 — five prompt and agent templates EXECUTE from the Playground on one model the
// test chose (#2459, row E1 of docs/core-functionality/templates/templates-coverage-scope.md).
// Instantiation through the gallery is S1's (templates-instantiate.spec.ts), which proves
// the created flow equals the `basic_examples` entry this spec reads — so the flow is
// created from that entry through the API, id-addressed and private to the test.
// Sibling: templates-run-knowledge.spec.ts (#2045), the same run shape for §11.5; the
// helpers the family shares are in helpers/flows/template-run.ts (#2467).
// Spec doc: docs/core-functionality/templates/templates-run-prompts.md

/**
 * Blog Writer's source URL. The self-hosted go-httpbin every lane resolves (#1128); the
 * public fallback only ever applies to a local run without one — the resolution
 * agent-multi-tool-selection.spec.ts uses. `/html` serves the same page on both.
 */
const ECHO_BASE = (
  process.env.ECHO_BASE_URL ||
  process.env.HTTPBIN_BASE_URL ||
  "https://httpbin.org"
).replace(/\/$/, "");
const ECHO_SOURCE_URL = `${ECHO_BASE}/html`;

interface TemplateUnderTest {
  /** Exact name in `GET /api/v1/flows/basic_examples/`. */
  name: string;
  /** The component type of every model node, and how many the template has. */
  modelNodeType: "LanguageModelComponent" | "Agent";
  modelNodes: number;
  /** SEO Keyword Generator has none: its Playground renders no text input. */
  hasChatInput: boolean;
  /**
   * The component types whose output-inspection control must go disabled → enabled,
   * sorted. Derived from the template at run time and compared with this list, so an
   * upstream edit fails naming the difference instead of shrinking the check.
   */
  builtTypes: string[];
}

const BASIC_PROMPTING: TemplateUnderTest = {
  name: "Basic Prompting",
  modelNodeType: "LanguageModelComponent",
  modelNodes: 1,
  hasChatInput: true,
  builtTypes: ["ChatInput", "ChatOutput", "LanguageModelComponent", "Prompt"],
};
const BLOG_WRITER: TemplateUnderTest = {
  name: "Blog Writer",
  modelNodeType: "Agent",
  modelNodes: 1,
  hasChatInput: true,
  // The URL component is a tool: it builds only when the model calls it.
  builtTypes: ["Agent", "ChatInput", "ChatOutput", "Prompt Template"],
};
const MULTI_AGENT_FLOW: TemplateUnderTest = {
  name: "Multi Agent Flow",
  modelNodeType: "Agent",
  modelNodes: 3,
  hasChatInput: true,
  builtTypes: ["Agent", "Agent", "Agent", "ChatInput", "ChatOutput"],
};
const SEO_KEYWORD_GENERATOR: TemplateUnderTest = {
  name: "SEO Keyword Generator",
  modelNodeType: "Agent",
  modelNodes: 1,
  hasChatInput: false,
  builtTypes: ["Agent", "ChatOutput", "Prompt"],
};
const TWITTER_THREAD_GENERATOR: TemplateUnderTest = {
  name: "Twitter Thread Generator",
  modelNodeType: "Agent",
  modelNodes: 1,
  hasChatInput: true,
  // Its Chat Output ships with `showNode: false` and renders no control; the reply
  // itself is that node's output.
  builtTypes: ["Agent", "ChatInput", "Prompt"],
};

function newNonce(): string {
  return `tpl2459-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("core-functionality/templates — prompt and agent templates run (§11.3)", () => {
  let token: string;
  /** The flow this test created, deleted by id in afterEach. */
  let flowId: string | null;

  const auth = () => ({ Authorization: token });

  test.beforeEach(async ({ request }) => {
    // Reset BEFORE the gate: a skip still runs afterEach, which must then find nothing
    // to clean rather than the previous test's flow.
    flowId = null;

    // Gate on the health collect-models recorded, not on the env var alone (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    token = await getAuthToken(request);
  });

  test.afterEach(async ({ page, request }) => {
    const id = flowId;
    if (!id) return;
    // Leave the editor first so its polls stop hitting the flow being deleted.
    await unmountEditorForCleanup(page, "/");
    // The first API call after a UI step is the one the keep-alive edge drops; a
    // re-dialled DELETE is safe because deleteFlow reads 404 as already gone.
    await retryOnDroppedConnection(() => deleteFlow(request, id, { headers: auth() }));
  });

  async function runTemplate(
    page: Page,
    request: APIRequestContext,
    template: TemplateUnderTest,
  ): Promise<void> {
    const headers = auth();

    // Resolved up front so a missing catalog fails before anything is created.
    const model = resolveGptModel();
    if (!model) {
      throw new Error(
        "No OpenAI chat model in models.json — run `npx playwright test " +
          "tests/collect-models.spec.ts` first. The template must run a model the test " +
          "chose, never its first option (gpt-5.5-pro).",
      );
    }

    let modelNodeIds: string[] = [];
    let builtNodeIds: string[] = [];
    let promptTemplateId = "";
    let chatMessage = "";

    await test.step(`create the ${template.name} flow pinned to ${model}`, async () => {
      const option = await resolveModelOption(request, model, headers);
      const { data, description } = await readTemplate(request, template.name, headers);

      const modelNodes = componentNodes(data).filter(
        (n) => n.data?.node?.template?.model?.type === "model",
      );
      expect(
        modelNodes.map((n) => n.data?.type),
        `${template.name}: the model nodes this spec pins`,
      ).toEqual(Array(template.modelNodes).fill(template.modelNodeType));
      for (const node of modelNodes) {
        field(node, "model", template.name).value = [{ ...option }];
      }
      modelNodeIds = modelNodes.map((n) => n.id);

      // A tool builds only when the model calls it; a hidden node renders no control.
      const built = buildableNodes(data);
      expect(
        built.map((n) => n.type).sort(),
        `${template.name}: the components whose build this spec checks`,
      ).toEqual(template.builtTypes);
      builtNodeIds = built.map((n) => n.id);

      const chatInputs = nodesOfType(data, "ChatInput");
      expect(chatInputs, `${template.name}: Chat Input components`).toHaveLength(
        template.hasChatInput ? 1 : 0,
      );

      if (template === BLOG_WRITER) {
        // The source URL the template asks for comes from the Chat Input, through the
        // Prompt Template's {URL} — the edge assertion 4 relies on.
        const chatInput = onlyNode(data, "ChatInput", template.name);
        const promptTemplate = onlyNode(data, "Prompt Template", template.name);
        promptTemplateId = promptTemplate.id;
        expect(
          data.edges.some(
            (e) =>
              e.source === chatInput.id &&
              e.target === promptTemplate.id &&
              e.data?.targetHandle?.fieldName === "URL",
          ),
          `${template.name}: Chat Input should feed the Prompt Template's {URL}`,
        ).toBe(true);
        field(chatInput, "input_value", template.name).value = ECHO_SOURCE_URL;
        field(onlyNode(data, "URLComponent", template.name), "urls", template.name).value = [
          ECHO_SOURCE_URL,
        ];
      }

      if (template.hasChatInput) {
        chatMessage = String(field(chatInputs[0], "input_value", template.name).value ?? "");
      }

      flowId = await createFlow(
        request,
        { name: `${template.name} ${newNonce()}`, description, data, is_component: false },
        { headers },
      );
    });

    let runBody: unknown = null;

    await test.step("run it from the Playground", async () => {
      await page.goto(`/flow/${flowId}`);
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
      const input = page.getByTestId("input-chat-playground");
      if (template.hasChatInput) {
        // Pre-filled from the Chat Input node: the template's own message.
        await expect(input).toHaveValue(chatMessage, { timeout: 15000 });
      } else {
        await expect(input, "a template with no Chat Input renders no text input").toHaveCount(
          0,
        );
      }

      // Armed before the send, or the capture races the request it reads.
      const runRequest = page.waitForRequest((r: Request) => isRunRequest(r), {
        timeout: 60000,
      });
      if (template.hasChatInput) {
        await input.press("Enter");
      } else {
        await page.getByTestId("button-send").click();
      }
      // A graph the Playground will not run (measured: Chat Output disconnected) leaves
      // the send control enabled and sends nothing — name that instead of a bare timeout.
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

    await test.step("the run carried the pinned model on every model node", async () => {
      // The run builds its live-canvas payload, not the saved flow, so this is where
      // a silent fallback shows (#1372, #1678).
      const savedFlow = async () => {
        const res = await retryOnDroppedConnection(() =>
          request.get(`/api/v1/flows/${flowId}`, { headers }),
        );
        return ((await res.json()) as { data: FlowData }).data;
      };
      for (const id of modelNodeIds) {
        expect(
          modelPairs((await ranField(runBody, savedFlow, id, "model"))?.value),
          `model node ${id} ran`,
        ).toEqual([`${model} / OpenAI`]);
      }
      if (template === BLOG_WRITER) {
        expect(
          (runBody as { input_value?: unknown } | null)?.input_value,
          "the run's input should be the echo endpoint's page",
        ).toBe(ECHO_SOURCE_URL);
      }
    });

    await test.step("the reply completes", async () => {
      // Counted on the AI container: on a template with no Chat Input the empty user
      // turn also renders a `div-chat-message` ("Message empty.").
      const replies = page.locator('[data-testid^="chat-message-AI-"]');
      await expect(replies).toHaveCount(1, { timeout: 120000 });
      await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 120000 });
      await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 10000 });
      // The model's wording is never asserted: the template must reply, not reply well.
      // An empty message renders as the placeholder "Message empty." (measured on the
      // empty user turn), so a bare non-whitespace check would pass on an empty reply.
      await expect(replies.first(), "the reply should not be empty").not.toHaveText(
        /^\s*(Message empty\.)?\s*$/,
      );
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

    if (template === BLOG_WRITER) {
      await test.step("the source URL reached the Agent's system prompt", async () => {
        // Langflow's formatting of the Chat Input into {URL}, not model output.
        expect(
          await readNodeOutput(
            page,
            promptTemplateId,
            "output-inspection-prompt-prompt template",
          ),
        ).toContain(ECHO_SOURCE_URL);
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
    "should run Basic Prompting and build all four of its components",
    { tag: ["@stable", "@release", "@templates", "@playground"] },
    async ({ page, request }) => {
      await runTemplate(page, request, BASIC_PROMPTING);
    },
  );

  test(
    "should run Blog Writer on a source URL served by the echo endpoint",
    { tag: ["@stable", "@release", "@templates", "@playground", "@agents"] },
    async ({ page, request }) => {
      await runTemplate(page, request, BLOG_WRITER);
    },
  );

  test(
    "should run Multi Agent Flow through all three of its Agents",
    { tag: ["@stable", "@release", "@templates", "@playground", "@agents"] },
    async ({ page, request }) => {
      await runTemplate(page, request, MULTI_AGENT_FLOW);
    },
  );

  test(
    "should run SEO Keyword Generator, which has no Chat Input, from the Playground",
    { tag: ["@stable", "@release", "@templates", "@playground", "@agents"] },
    async ({ page, request }) => {
      await runTemplate(page, request, SEO_KEYWORD_GENERATOR);
    },
  );

  test(
    "should run Twitter Thread Generator to a non-empty thread",
    { tag: ["@stable", "@release", "@templates", "@playground", "@agents"] },
    async ({ page, request }) => {
      await runTemplate(page, request, TWITTER_THREAD_GENERATOR);
    },
  );
});
