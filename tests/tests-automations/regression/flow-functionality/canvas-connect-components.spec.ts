import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { separateOverlappingNodes } from "../../../helpers/ui/separate-overlapping-nodes";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.3 — Connect two compatible components / prevent connections between
 * incompatible types.
 *
 * Edges are asserted on the canvas AND in the persisted flow: an edge that
 * renders but never reaches the autosave `PATCH` is lost on reload.
 *
 * The type check and the topology check are separate tests on purpose. The
 * inherited `canvas-incompatible-connection.spec.ts` (merged in here and
 * removed) filed only the target-to-target case under "incompatible
 * connection", which never exercised type checking at all.
 *
 * The type test drives BOTH handles of the same Structured Output node: Message
 * into its `language model` input (LanguageModel) yields no edge, while the same
 * source into its `input message` input (Message) yields one. Same node, same
 * source, only the destination handle's type differs — so the zero cannot be a
 * missed click. Note that Langflow *coerces* some types: Split Text `chunks`
 * (DataFrame) → Chat Output (Message) DOES connect on 1.12.0.dev8, which is why
 * the closed `LanguageModel` type is the one asserted.
 *
 * The inherited "ChatInput to TextOutput" test was red because **`Text Output`
 * is now `legacy: true`** and no longer appears in the default sidebar — an
 * intentional product change, so the fixtures are non-legacy components rather
 * than the legacy toggle being switched on.
 *
 * Deleting and recreating an edge is `canvas-edge-reconnect.spec.ts`; whether a
 * connected graph runs is `run-flow.spec.ts`.
 */

const CHAT_INPUT_SOURCE = "handle-chatinput-noshownode-chat message-source";
const CHAT_OUTPUT_TARGET = "handle-chatoutput-noshownode-inputs-target";
const STRUCTURED_MODEL_TARGET =
  "handle-structuredoutput-shownode-language model-left";
const STRUCTURED_MESSAGE_TARGET =
  "handle-structuredoutput-shownode-input message-left";

test.describe("Canvas — connecting components", () => {
  let createdFlowId: string | null = null;

  /** Edges as the backend currently has them. */
  async function fetchEdges(
    request: import("@playwright/test").APIRequestContext,
    flowId: string,
  ) {
    const bearer = await getAuthToken(request);
    const response = await request.get(`/api/v1/flows/${flowId}`, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    return (body?.data?.edges ?? []) as unknown[];
  }

  test.beforeEach(async ({ page }) => {
    createdFlowId = await setupBlankFlow(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  /** Adds Chat Input + Chat Output and waits for both to render. */
  async function addChatPair(page: import("@playwright/test").Page) {
    await addComponentFromSidebar(
      page,
      "chat input",
      "add-component-button-chat-input",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 30000,
    });
    await addComponentFromSidebar(
      page,
      "chat output",
      "add-component-button-chat-output",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 30000,
    });
    // Sidebar-added components land stacked; the top node's subtree otherwise
    // intercepts the clicks aimed at the handles underneath it.
    await separateOverlappingNodes(page);
  }

  test("connecting two compatible components creates exactly one edge",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Add a Chat Input and a Chat Output", async () => {
        await addChatPair(page);
        await expect(edges).toHaveCount(0);
      });

      await test.step("Click the source handle then the target handle", async () => {
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("The edge reached the backend", async () => {
        // Polled: the canvas autosave is debounced, so an immediate GET still
        // reports an empty edge list.
        await expect
          .poll(
            async () => (await fetchEdges(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the new edge should be persisted to the flow",
            },
          )
          .toBe(1);
      });
    },
  );

  test("connecting the same compatible pair twice does not duplicate the edge",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Connect the pair once", async () => {
        await addChatPair(page);
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Repeating the connection leaves a single edge", async () => {
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("The flow holds a single edge too", async () => {
        await expect
          .poll(
            async () => (await fetchEdges(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the duplicate attempt must not persist a second edge",
            },
          )
          .toBe(1);
      });
    },
  );

  test("a type-incompatible pair does not connect",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Add a Chat Input and a Structured Output", async () => {
        await addComponentFromSidebar(
          page,
          "chat input",
          "add-component-button-chat-input",
        );
        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 30000,
        });
        await addComponentFromSidebar(
          page,
          "structured output",
          "add-component-button-structured-output",
        );
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 30000,
        });
        await separateOverlappingNodes(page);
        await expect(edges).toHaveCount(0);
      });

      await test.step("Message into a LanguageModel input creates no edge", async () => {
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(STRUCTURED_MODEL_TARGET).click();
        await expect(edges).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("The same source into the Message input connects (positive control)", async () => {
        // Same node, same source handle — only the destination type changed, so
        // the zero above cannot be explained by a click that missed.
        await page.keyboard.press("Escape");
        await page.getByTestId(CHAT_INPUT_SOURCE).click();
        await page.getByTestId(STRUCTURED_MESSAGE_TARGET).click();
        await expect(edges).toHaveCount(1, { timeout: 10000 });
      });
    },
  );

  test("clicking the same target handle twice does not create an edge",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const edges = page.locator(".react-flow__edge");

      await test.step("Add a single Chat Output", async () => {
        await addComponentFromSidebar(
          page,
          "chat output",
          "add-component-button-chat-output",
        );
        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 30000,
        });
      });

      await test.step("Target-to-target is invalid topology, not a type mismatch", async () => {
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await page.getByTestId(CHAT_OUTPUT_TARGET).click();
        await expect(edges).toHaveCount(0, { timeout: 10000 });
      });
    },
  );
});
