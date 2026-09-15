import { randomUUID } from "crypto";
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
// The suite's one narrow transport re-dial (#1562): retries a THROWN request once,
// never a response. Lives with the RBAC helpers that needed it first.
import { retryOnDroppedConnection } from "../../../../helpers/enterprise/rbac";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { separateOverlappingNodes } from "../../../../helpers/ui/separate-overlapping-nodes";

// Spec doc: docs/core-functionality/a2a/a2a-client-agent-external.md
//
// External mode calls an A2A agent BY URL. Its sibling, a2a-client-agent-internal,
// covers the in-project dropdown; the eight a2a-server-* specs cover the endpoint
// this one calls. What is left, and only reachable here, is the client's own half:
// fetching a remote card into the node, calling the agent over HTTP, and forwarding
// the api key a restricted agent requires. LE-1845 (`NameError: name
// 'call_a2a_agent' is not defined`) crashed every External run.
//
// The agent called is THIS instance's own. The component validates `agent_url` with
// the connector SSRF policy, which lets a literal loopback host through by default
// (`connector_ssrf_allow_loopback`) — the reason this row of the scope doc, once
// parked as blocked, is reachable at all.

const A2A_SEARCH_TERM = "A2A";
const A2A_ADD_BUTTON = "add-component-button-a2a-agent";
const CHAT_OUTPUT_SEARCH_TERM = "Chat Output";
const CHAT_OUTPUT_ADD_BUTTON = "add-component-button-chat-output";

const AGENT_URL_INPUT = "popover-anchor-input-agent_url";
const API_KEY_INPUT = "popover-anchor-input-api_key";
const API_KEY_INSPECTOR_ADD = "inspector-add-api_key";
// The component's `message` input is named `input_value` in the template.
const MESSAGE_INPUT = "textarea_str_input_value";
// Rendered ONLY when a card came back: `_fetch_card` returns None on any failure
// and the display is then hidden, with no error anywhere.
const AGENT_CARD_DISPLAY = "data_display_data_display_agent_card";
const AGENT_CARD_VIEW_BUTTON = "data_display_data_display_data_display_agent_card";
const A2A_RESPONSE_HANDLE = "handle-a2aagent-shownode-response-right";
const CHAT_OUTPUT_TARGET_HANDLE = "handle-chatoutput-noshownode-inputs-target";

const RESTRICTED_CHIP = "Requires an API key";
const COMPONENT_UPDATE_PATH = "/api/v1/custom_component/update";

// Must exceed the A2A Agent node's height in External mode once the card display
// renders (measured 481px) — otherwise Chat Output stays inside it.
const A2A_NODE_SEPARATION_STEP_PX = 540;

// The two session shapes a target flow can store an A2A call under. The server
// mints `<uuid>:<contextId>` for a JSON-RPC call; Internal mode runs the target
// in-process under `<caller session>:a2a:<target id>` instead.
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const A2A_SERVER_SESSION = new RegExp(`^${UUID_RE}:${UUID_RE}$`, "i");

interface StoredMessage {
  sender?: string;
  text?: unknown;
  session_id?: string;
}

/**
 * The origin Langflow reaches ITSELF on — not necessarily the one the test uses.
 *
 * Every lane runs the backend on the port the tests address (`localhost:7860`), so
 * the Playwright baseURL origin is the default. An instance published on a remapped
 * port — a local container mapped `7871->7860` — must set `A2A_SELF_BASE_URL` to the
 * address inside that container, or the card fetch fails without a word.
 */
function selfBaseUrl(): string {
  const override = process.env.A2A_SELF_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const baseURL = test.info().project.use.baseURL ?? "http://localhost:7860";
  return new URL(baseURL).origin;
}

async function patchFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  data: Record<string, unknown>,
) {
  // Idempotent, so safe to re-dial when a reused keep-alive socket was dropped.
  const res = await retryOnDroppedConnection(() =>
    request.patch(`/api/v1/flows/${flowId}`, { headers, data }),
  );
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  return res.json();
}

/**
 * Resolves on the node update that carries THIS `agent_url` value.
 *
 * The card is fetched inside that round trip, so it is the barrier between setting
 * the URL and reading the display. Matched by pathname (the endpoint carries a
 * `?flow_id=` query) and by the request's field/value, because the node issues
 * other updates of its own and a pathname-only wait could resolve on one of those.
 */
function waitForAgentUrlUpdate(page: Page, url: string): Promise<Response> {
  return page.waitForResponse(
    (res) => {
      const req = res.request();
      if (req.method() !== "POST") return false;
      if (new URL(res.url()).pathname !== COMPONENT_UPDATE_PATH) return false;
      try {
        const body = req.postDataJSON() as { field?: string; field_value?: unknown };
        return body?.field === "agent_url" && body?.field_value === url;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
}

async function pointAgentAt(page: Page, url: string): Promise<void> {
  const updated = waitForAgentUrlUpdate(page, url);
  await page.getByTestId(AGENT_URL_INPUT).fill(url);
  await page.getByTestId(AGENT_URL_INPUT).press("Tab");
  const res = await updated;
  expect(res.ok(), `node update for agent_url=${url} — HTTP ${res.status()}`).toBe(true);
}

/**
 * Opens the card viewer, hands its dialog to `check`, and closes it again.
 *
 * The dialog carries no testids (measured), so it is found by the agent's unique
 * name: Radix popovers also render `role="dialog"` into body-level portals, and an
 * unscoped locator would be non-deterministic.
 */
async function inspectCard(
  page: Page,
  agentName: string,
  check: (dialog: Locator) => Promise<void>,
): Promise<void> {
  await page.getByTestId(AGENT_CARD_VIEW_BUTTON).click();
  const dialog = page.getByRole("dialog").filter({ hasText: agentName });
  await expect(dialog, `the card viewer should show the agent "${agentName}"`).toBeVisible({
    timeout: 10_000,
  });
  await check(dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

async function readTargetMessages(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<StoredMessage[]> {
  // `expect.poll` does not retry a thrown poller, so a dropped socket would end the
  // poll instead of re-reading; the re-dial keeps it on the condition.
  const res = await retryOnDroppedConnection(() =>
    request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers }),
  );
  expect(res.status(), `GET /api/v1/monitor/messages — ${await res.text()}`).toBe(200);
  return (await res.json()) as StoredMessage[];
}

/** Polls until the target flow stored `sentinel` as a User turn, and returns it. */
async function expectTargetStored(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  sentinel: string,
): Promise<StoredMessage> {
  let found: StoredMessage | undefined;
  await expect
    .poll(
      async () => {
        const messages = await readTargetMessages(request, headers, flowId);
        found = messages.find((m) => m.sender === "User" && m.text === sentinel);
        return found !== undefined;
      },
      {
        message: `target flow ${flowId} never stored the sentinel ${sentinel}`,
        timeout: 20_000,
        // Under 2 s between API reads: at a ~2000 ms idle gap the reused keep-alive
        // socket is closed under the request context and the read throws `socket hang
        // up`, which `expect.poll` does not retry.
        intervals: [250, 500, 1_000],
      },
    )
    .toBe(true);
  return found as StoredMessage;
}

async function runFromPlayground(page: Page, sentinel: string): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  await page.getByTestId("button-send").click();
  // The passthrough echoes its input verbatim, so the sentinel arriving as the AI
  // turn is causal evidence the TARGET flow ran — not that the node returned text.
  await expect(page.getByTestId(`chat-message-AI-${sentinel}`)).toBeVisible({
    timeout: 60_000,
  });
}

test.describe("A2A Client — A2AAgent component in External mode", () => {
  test("External mode fetches the card and calls the agent at its URL, forwarding the key a restricted agent requires",
    { tag: ["@stable", "@regression", "@components", "@workspace", "@a2a"] },
    async ({ page }) => {
      const headers = { Authorization: await getAuthToken(page.request) };
      await requireA2aEnabled(page.request, headers);

      const self = selfBaseUrl();
      const agentName = `a2a-external-target-${randomUUID().slice(0, 8)}`;
      const sentinel = `a2a-external-${randomUUID()}`;
      const keyedSentinel = `a2a-external-keyed-${randomUUID()}`;

      const target = await createRunnableChatFlowViaApi(page.request, headers);
      let callerFlowId: string | null = null;
      let project: Awaited<ReturnType<typeof createProjectViaApi>> | undefined;
      let apiKey: Awaited<ReturnType<typeof createApiKey>> | undefined;

      try {
        await test.step("publish the target flow as an A2A agent under a known name", async () => {
          const patched = await patchFlow(page.request, headers, target.flowId, {
            name: agentName,
            flow_type: "agent",
            a2a_enabled: true,
          });
          expect(patched.name).toBe(agentName);
          expect(patched.a2a_enabled).toBe(true);
        });

        await test.step("prepare the restricted project and the owner's API key", async () => {
          // Created here, in the API block, not where they are used: both are
          // non-idempotent POSTs, and issued after a UI step one landed in the ~2 s
          // idle window where the local nightly drops a reused keep-alive socket
          // (measured: `socket hang up` on POST /api/v1/api_key/).
          project = await createProjectViaApi(page.request, headers, {
            namePrefix: "a2a-external",
            description: "Restricted project for the A2A External-mode client spec",
            authSettings: { auth_type: "apikey" },
          });
          apiKey = await createApiKey(page.request, headers, { namePrefix: "a2a-external" });
        });

        await test.step("open a blank caller flow", async () => {
          callerFlowId = await createFlow(
            page.request,
            {
              name: `a2a-external-caller-${randomUUID().slice(0, 8)}`,
              description: "Calls a published A2A agent in External mode",
              data: { nodes: [], edges: [] },
              is_component: false,
            },
            { headers },
          );
          await openFlowById(page, callerFlowId);
        });

        await test.step("add the A2A Agent component — it opens in External mode", async () => {
          await addComponentFromSidebar(page, A2A_SEARCH_TERM, A2A_ADD_BUTTON);
          await expect(page.getByTestId("title-A2A Agent")).toBeVisible();
          // No tab click: the URL field is there from the start.
          await expect(page.getByTestId(AGENT_URL_INPUT)).toBeVisible();
        });

        await test.step("pointing it at the target's card URL fetches and renders the card", async () => {
          await pointAgentAt(
            page,
            `${self}/api/v1/a2a/${target.flowId}/.well-known/agent-card.json`,
          );
          await expect(
            page.getByTestId(AGENT_CARD_DISPLAY),
            `the node fetched no card from ${self}. A failed fetch renders nothing, so ` +
              "this is all there is to see: an SSRF refusal, an unreachable address or a " +
              "non-200 all look the same. If this instance is published on a remapped " +
              "port, set A2A_SELF_BASE_URL to the address Langflow reaches itself on.",
          ).toBeVisible({ timeout: 10_000 });

          // NEGATIVE CONTROL for the restricted step: the same flow, still public,
          // advertises no security.
          await inspectCard(page, agentName, async (dialog) => {
            await expect(dialog).not.toContainText(RESTRICTED_CHIP);
          });
        });

        await test.step("send a per-run sentinel as the message", async () => {
          await page.getByTestId(MESSAGE_INPUT).fill(sentinel);
        });

        await test.step("wire the response into a Chat Output", async () => {
          await addComponentFromSidebar(page, CHAT_OUTPUT_SEARCH_TERM, CHAT_OUTPUT_ADD_BUTTON);
          // The sidebar drops the new node inside the A2A Agent; the drag below
          // would otherwise hit the wrong handle (#939).
          await separateOverlappingNodes(page, A2A_NODE_SEPARATION_STEP_PX);
          await page
            .getByTestId(A2A_RESPONSE_HANDLE)
            .dragTo(page.getByTestId(CHAT_OUTPUT_TARGET_HANDLE));
          await expect(page.locator(".react-flow__edge")).toHaveCount(1);
        });

        await test.step("running the flow returns what the remote agent echoed", async () => {
          await runFromPlayground(page, sentinel);
        });

        await test.step("the call reached the target through the A2A server, not in-process", async () => {
          const stored = await expectTargetStored(page.request, headers, target.flowId, sentinel);
          // The session is what separates the two modes: a JSON-RPC call lands under
          // the server's `<uuid>:<contextId>`, an in-process run under `…:a2a:<id>`.
          expect(stored.session_id ?? "", "session of the stored turn").not.toContain(":a2a:");
          expect(stored.session_id ?? "", "session of the stored turn").toMatch(A2A_SERVER_SESSION);
        });

        await test.step("move the target into a project whose auth_type is apikey", async () => {
          await page.getByTestId("playground-close-button").click();

          // Asserted, not assumed: a silent no-op here would make the chip step
          // below fail for a reason it cannot name.
          const moved = await patchFlow(page.request, headers, target.flowId, {
            folder_id: project!.projectId,
          });
          expect(moved.folder_id).toBe(project!.projectId);
        });

        await test.step("re-pointed at the base URL, the refreshed card requires an API key", async () => {
          // The component accepts the base URL as well as the card URL; changing the
          // value is what makes it fetch the card again — an already-rendered display
          // does not follow the move on its own.
          await pointAgentAt(page, `${self}/api/v1/a2a/${target.flowId}`);
          await inspectCard(page, agentName, async (dialog) => {
            await expect(dialog).toContainText(RESTRICTED_CHIP);
          });
        });

        await test.step("give the node the owner's key and a second sentinel", async () => {
          // `api_key` is an advanced field: it has no widget on the node until it is
          // added from the inspector.
          await page.getByTestId("title-A2A Agent").click();
          await openAdvancedOptions(page);
          await page.getByTestId(API_KEY_INSPECTOR_ADD).click();
          await closeAdvancedOptions(page);
          await expect(page.getByTestId(API_KEY_INPUT)).toBeVisible({ timeout: 10_000 });

          await page.getByTestId(API_KEY_INPUT).fill(apiKey!.key);
          await page.getByTestId(API_KEY_INPUT).press("Tab");
          await page.getByTestId(MESSAGE_INPUT).fill(keyedSentinel);
        });

        await test.step("the keyed run reaches the restricted agent", async () => {
          await runFromPlayground(page, keyedSentinel);
          await expectTargetStored(page.request, headers, target.flowId, keyedSentinel);
        });
      } finally {
        // Each guarded so one failure cannot skip the rest. The caller goes first
        // because the editor is still open on it; the project goes last, because a
        // project still holding a flow is a different delete path.
        if (callerFlowId) {
          await unmountEditorForCleanup(page, "/");
          await deleteFlow(page.request, callerFlowId, { headers }).catch((e) =>
            console.warn(`⚠️ caller flow cleanup failed: ${e}`),
          );
        }
        await target
          .deleteFlow()
          .catch((e) => console.warn(`⚠️ target flow cleanup failed: ${e}`));
        if (apiKey) {
          await deleteApiKey(page.request, apiKey.id, headers).catch((e) =>
            console.warn(`⚠️ API key cleanup failed: ${e}`),
          );
        }
        if (project) {
          await project
            .deleteProject()
            .catch((e) => console.warn(`⚠️ project cleanup failed: ${e}`));
        }
      }
    },
  );
});
