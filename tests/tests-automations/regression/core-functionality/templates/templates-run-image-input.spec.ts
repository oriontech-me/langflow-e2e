import path from "path";
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
  onlyNode,
  ranField,
  readTemplate,
  resolveModelOption,
  type FlowData,
  type FlowEdge,
} from "../../../../helpers/flows/template-run";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { isRunRequest } from "../../../../helpers/flows/watch-run-model-binding";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { resolveGptModel } from "../../../../helpers/provider-setup/resolve-gpt-model";

// §11.3 — Image Sentiment Analysis EXECUTES on an image attached in the Playground, and the
// image reaches the vision model the test pinned (#2460, row E2 of
// docs/core-functionality/templates/templates-coverage-scope.md). Siblings:
// templates-run-prompts.spec.ts (E1), templates-run-file-input.spec.ts (E3) and
// templates-run-knowledge.spec.ts (E4), sharing helpers/flows/template-run.ts (#2467).
// Spec doc: docs/core-functionality/templates/templates-run-image-input.md

const TEMPLATE = "Image Sentiment Analysis";
const IMAGE = path.resolve(__dirname, "../../../../assets/media/chain.png");

/**
 * Typed on both turns. Without text the Chat Input's output-inspection control stays
 * disabled after the run (its message has nothing to show), which would leave its build
 * unproven; the same text on both turns keeps the image the only difference between them.
 */
const PROMPT = "Classify the sentiment of this image.";

/**
 * The least the image turn's input tokens must exceed the control turn's by. The two turns
 * are otherwise identical requests and differ by 0 (measured 92 and 92); an image costs at
 * least the model's base charge, the smallest OpenAI documents being 70 tokens. Measured on
 * gpt-4o-mini: 8592 - 92 = 8500.
 */
const MIN_IMAGE_TOKENS = 50;

/** The `POST /api/v1/files/upload/{flow_id}` response. */
interface UploadedAttachment {
  flowId: string;
  file_path: string;
}

/** The fields of a `GET /api/v1/monitor/messages` row this spec reads. */
interface StoredMessage {
  sender?: string;
  timestamp?: string;
  files?: unknown;
  properties?: { usage?: { input_tokens?: unknown } | null };
}

function newNonce(): string {
  return `tpl2460-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A message's `files`, which the listing serialises as a JSON string. */
function messageFiles(message: StoredMessage): unknown[] {
  const { files } = message;
  if (Array.isArray(files)) return files;
  if (typeof files === "string" && files.trim() !== "") {
    const parsed: unknown = JSON.parse(files);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return [];
}

test.describe("core-functionality/templates — image template runs (§11.3)", () => {
  let token: string;
  /** The flow this test created, deleted by id in afterEach after its attachments. */
  let flowId: string | null;

  const auth = () => ({ Authorization: token });

  test.beforeEach(async ({ request }) => {
    // Reset BEFORE the gate: a skip still runs afterEach, which must then find nothing to
    // clean rather than the previous test's state.
    flowId = null;

    // Gate on the health collect-models recorded, not on the env var alone (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    token = await getAuthToken(request);
  });

  test.afterEach(async ({ page, request }) => {
    const id = flowId;
    if (!id) return;
    const failures: string[] = [];
    // Leave the editor first so its polls stop hitting the flow being deleted.
    await unmountEditorForCleanup(page, "/");
    // Attachments first: deleting the flow does not delete them, and the file routes need
    // the flow to exist (measured on 1.14.0.dev29).
    try {
      const listUrl = `/api/v1/files/list/${id}`;
      const listed = async () => {
        const res = await retryOnDroppedConnection(() =>
          request.get(listUrl, { headers: auth() }),
        );
        if (!res.ok()) throw new Error(`GET ${listUrl} → ${res.status()}`);
        return ((await res.json()) as { files?: string[] }).files ?? [];
      };
      for (const file of await listed()) {
        const name = file.split("/").pop() ?? file;
        const res = await retryOnDroppedConnection(() =>
          request.delete(`/api/v1/files/delete/${id}/${encodeURIComponent(name)}`, {
            headers: auth(),
          }),
        );
        if (!res.ok() && res.status() !== 404) {
          failures.push(`DELETE /api/v1/files/delete/${id}/${name} → ${res.status()}`);
        }
      }
      const left = await listed();
      if (left.length > 0) failures.push(`attachments left behind: ${left.join(", ")}`);
    } catch (e) {
      failures.push(String(e));
    }
    try {
      // A re-dialled DELETE is safe: deleteFlow reads a 404 as already gone.
      await retryOnDroppedConnection(() => deleteFlow(request, id, { headers: auth() }));
    } catch (e) {
      failures.push(String(e));
    }
    if (failures.length > 0) {
      throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
    }
  });

  /** Clicks send and returns the run request's JSON body, naming a send that ran nothing. */
  async function sendAndCaptureRun(page: Page): Promise<Record<string, unknown>> {
    // Armed before the send, or the capture races the request it reads.
    const runRequest = page.waitForRequest((r: Request) => isRunRequest(r), { timeout: 60000 });
    await page.getByTestId("button-send").click();
    const sent = await runRequest.catch((e: unknown) => {
      throw new Error(
        "the Playground sent no run request (POST /api/v2/workflows) within 60 s — " +
          `the run never started (${String(e).split("\n")[0]})`,
      );
    });
    return (sent.postDataJSON() ?? {}) as Record<string, unknown>;
  }

  /** Waits for the `count`-th AI reply to complete and checks it is not empty. */
  async function expectReply(page: Page, count: number, label: string): Promise<void> {
    const replies = page.locator('[data-testid^="chat-message-AI-"]');
    await expect(replies, `${label}: AI replies`).toHaveCount(count, { timeout: 120000 });
    await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 120000 });
    await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 10000 });
    // The model's wording is never asserted. An empty message renders as the placeholder
    // "Message empty.", so a bare non-whitespace check would pass on an empty reply.
    await expect(replies.nth(count - 1), `${label}: the reply should not be empty`).not.toHaveText(
      /^\s*(Message empty\.)?\s*$/,
    );
  }

  async function runImageTemplate(page: Page, request: APIRequestContext): Promise<void> {
    const headers = auth();

    // Resolved up front so a missing catalog fails before anything is created.
    const model = resolveGptModel();
    if (!model) {
      throw new Error(
        "No OpenAI chat model in models.json — run `npx playwright test " +
          "tests/collect-models.spec.ts` first. The template must run a vision model the test " +
          "chose, never its first option (gpt-5.5-pro).",
      );
    }

    let modelNodeId = "";
    let chatInputId = "";
    let builtNodeIds: string[] = [];

    await test.step(`create the ${TEMPLATE} flow pinned to ${model}`, async () => {
      const option = await resolveModelOption(request, model, headers);
      const { data, description } = await readTemplate(request, TEMPLATE, headers);

      const modelNodes = componentNodes(data).filter(
        (n) => n.data?.node?.template?.model?.type === "model",
      );
      expect(
        modelNodes.map((n) => n.data?.type),
        `${TEMPLATE}: the model nodes this spec pins`,
      ).toEqual(["LanguageModelComponent"]);
      field(modelNodes[0], "model", TEMPLATE).value = [{ ...option }];
      modelNodeId = modelNodes[0].id;

      chatInputId = onlyNode(data, "ChatInput", TEMPLATE).id;
      onlyNode(data, "ChatOutput", TEMPLATE);
      // The image travels on the Chat Input's message, so this edge is what makes
      // "the model got the image" mean "through the template's own wiring".
      expect(
        data.edges.some(
          (e) =>
            e.source === chatInputId &&
            e.target === modelNodeId &&
            e.data?.targetHandle?.fieldName === "input_value",
        ),
        `${TEMPLATE}: Chat Input should feed the Language Model's input`,
      ).toBe(true);

      const built = buildableNodes(data);
      expect(
        built.map((n) => n.type).sort(),
        `${TEMPLATE}: the components whose build this spec checks`,
      ).toEqual(["ChatInput", "ChatOutput", "LanguageModelComponent"]);
      builtNodeIds = built.map((n) => n.id);

      flowId = await createFlow(
        request,
        { name: `${TEMPLATE} ${newNonce()}`, description, data, is_component: false },
        { headers },
      );
    });

    let attachment: UploadedAttachment | null = null;
    let imageRun: Record<string, unknown> = {};

    await test.step("attach the image in the Playground and run it", async () => {
      await page.goto(`/flow/${flowId}`);
      // The editor can sit on "Loading..." for over 30 s on a loaded host (measured on
      // 1.14.0.dev29); name that, instead of a node control that is "not found".
      await expect(
        page.getByTestId("canvas_controls_dropdown"),
        "the flow editor did not finish loading",
      ).toBeVisible({ timeout: 60000 });
      // Fresh flow: no component has an output yet, so the enabled state after the run is
      // attributable to this run.
      for (const id of builtNodeIds) {
        await expect(
          inspectionControl(page, id),
          `node ${id} should have no output before the run`,
        ).toBeDisabled({ timeout: 30000 });
      }

      await page.getByTestId("playground-btn-flow-io").click();
      const input = page.getByTestId("input-chat-playground");
      await expect(input).toBeVisible({ timeout: 30000 });

      const upload = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === `/api/v1/files/upload/${flowId}`,
        { timeout: 30000 },
      );
      await page.locator('[data-testid="input-wrapper"] input[type="file"]').setInputFiles(IMAGE);
      const uploaded = await upload;
      expect(uploaded.status(), "the Playground's upload of the image").toBe(201);
      attachment = (await uploaded.json()) as UploadedAttachment;
      // The tile shows a spinner while the upload runs; the image is the resolved state.
      await expect(page.locator('[data-testid="input-wrapper"] img').first()).toBeVisible({
        timeout: 15000,
      });

      await input.fill(PROMPT);
      imageRun = await sendAndCaptureRun(page);
    });

    await test.step("the image run carried the attachment, the pinned model and the input edge", async () => {
      const file = (attachment as UploadedAttachment | null)?.file_path;
      expect(file, "the upload returned no file_path").toBeTruthy();
      expect(imageRun.files, "the files the image run sent").toEqual([file]);
      expect(imageRun.input_value, "the text the image run sent").toBe(PROMPT);

      // The run builds its live-canvas payload, not the saved flow, so this is where a
      // silent fallback shows (#1372, #1678).
      const savedFlow = async () => {
        const res = await retryOnDroppedConnection(() =>
          request.get(`/api/v1/flows/${flowId}`, { headers }),
        );
        return ((await res.json()) as { data: FlowData }).data;
      };
      expect(
        modelPairs((await ranField(imageRun, savedFlow, modelNodeId, "model"))?.value),
        "the model the Language Model ran",
      ).toEqual([`${model} / OpenAI`]);
      const live = (imageRun as { data?: { edges?: unknown } }).data?.edges;
      const runEdges = Array.isArray(live) ? (live as FlowEdge[]) : (await savedFlow()).edges;
      expect(
        runEdges.some(
          (e) =>
            e.source === chatInputId &&
            e.target === modelNodeId &&
            e.data?.targetHandle?.fieldName === "input_value",
        ),
        "the Language Model ran with the Chat Input wired into its input",
      ).toBe(true);
    });

    await test.step("both turns replied: the image turn, then a control turn with no image", async () => {
      await expectReply(page, 1, "image turn");
      // The tile clears after the send, so this send carries no attachment.
      await page.getByTestId("input-chat-playground").fill(PROMPT);
      const controlRun = await sendAndCaptureRun(page);
      expect(controlRun.files ?? [], "the files the control run sent").toEqual([]);
      expect(controlRun.input_value, "the text the control run sent").toBe(PROMPT);
      await expectReply(page, 2, "control turn");
      await page.getByTestId("playground-close-button").click();
      await expect(page.getByTestId("button-send")).toBeHidden({ timeout: 10000 });
    });

    let stored: StoredMessage[] = [];

    await test.step("the image reached the model: it billed the image turn for it", async () => {
      const url = `/api/v1/monitor/messages?flow_id=${flowId}`;
      // The reply's usage can land a moment after the bubble does.
      await expect
        .poll(
          async () => {
            const res = await retryOnDroppedConnection(() => request.get(url, { headers }));
            if (!res.ok()) return `GET ${url} → ${res.status()}`;
            stored = ((await res.json()) as StoredMessage[])
              .slice()
              .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
            const machine = stored.filter((m) => m.sender === "Machine");
            const counted = machine.filter(
              (m) => typeof m.properties?.usage?.input_tokens === "number",
            );
            return `${machine.length} AI message(s), ${counted.length} with usage.input_tokens`;
          },
          { message: "both stored AI messages should record the provider's token usage", timeout: 30000 },
        )
        .toBe("2 AI message(s), 2 with usage.input_tokens");

      const [imageTurn, controlTurn] = stored
        .filter((m) => m.sender === "Machine")
        .map((m) => m.properties?.usage?.input_tokens as number);
      expect(
        imageTurn - controlTurn,
        `input tokens: image turn ${imageTurn}, control turn ${controlTurn} — an image that ` +
          "reached the model is billed as input",
      ).toBeGreaterThanOrEqual(MIN_IMAGE_TOKENS);
    });

    await test.step("the backend stored the image on the user's message", async () => {
      const users = stored.filter((m) => m.sender === "User");
      expect(users, "stored user messages").toHaveLength(2);
      expect(messageFiles(users[0]), "the image turn's stored files").toEqual([
        (attachment as UploadedAttachment | null)?.file_path,
      ]);
      expect(messageFiles(users[1]), "the control turn's stored files").toEqual([]);
    });

    await test.step("every component built", async () => {
      for (const id of builtNodeIds) {
        await expect(
          inspectionControl(page, id),
          `node ${id} has no output to display — it did not build`,
        ).toBeEnabled({ timeout: 15000 });
      }
    });

    await test.step("the flow-error report is evaluated and clean", async () => {
      const report = await (page as PageWithErrorHooks).flowErrorReport();
      // `clean` is vacuously true when nothing was read, so both are asserted (#1452).
      expect(report.evaluated, report.summary).toBeGreaterThan(0);
      expect(report.clean, report.summary).toBe(true);
    });
  }

  test(
    "should run Image Sentiment Analysis on an attached image through its pinned vision model",
    { tag: ["@stable", "@release", "@templates", "@playground"] },
    async ({ page, request }) => {
      await runImageTemplate(page, request);
    },
  );
});
