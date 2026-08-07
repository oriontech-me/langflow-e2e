import { randomUUID } from "crypto";
import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { separateOverlappingNodes } from "../../../../helpers/ui/separate-overlapping-nodes";

// Spec doc: docs/core-functionality/a2a/a2a-client-agent-internal.md
//
// A2A has two halves — serving an agent and CONSUMING one. The server half is
// covered by the eight a2a-server-* specs; the A2AAgent component is the whole
// client half and had no coverage at all. This is its first.
//
// Two things are proven and they fail independently: the dropdown OFFERS the
// published agent (regress this and the component is unusable — there is nothing
// to pick), and the call actually EXECUTES the remote flow (regress this and the
// dropdown still looks healthy while every run returns nothing). The target is a
// Chat Input -> Chat Output passthrough, so the sentinel coming back is causal
// evidence the other flow's graph ran, with no LLM on either side.
//
// The run is asserted through a wired Chat Output and the playground rather than
// through the node's own output modal, which is the shorter path and the one a
// reader would expect: `output-inspection-response-a2aagent` renders "No Data
// Available" even after a successful run whose stream carried
// outputs.response.message (measured 3x on 1.12.0.dev18). See the spec doc —
// candidate product defect, recorded and not filed.

const A2A_SEARCH_TERM = "A2A";
const A2A_ADD_BUTTON = "add-component-button-a2a-agent";
const CHAT_OUTPUT_SEARCH_TERM = "Chat Output";
const CHAT_OUTPUT_ADD_BUTTON = "add-component-button-chat-output";

// The node opens in External mode: without this click the Internal picker is not
// rendered at all, so it is a required step rather than a no-op.
const MODE_TAB_INTERNAL = "tab_0_internal";
const AGENT_DROPDOWN = "value-dropdown-dropdown_str_agent_name_selected";
// The component's `message` input is named `input_value` in the template, so the
// testid is NOT textarea_str_message.
const MESSAGE_INPUT = "textarea_str_input_value";
const A2A_RESPONSE_HANDLE = "handle-a2aagent-shownode-response-right";
const CHAT_OUTPUT_TARGET_HANDLE = "handle-chatoutput-noshownode-inputs-target";

// Must exceed the A2A Agent node's own height (measured 401px in Internal mode)
// or the second node stays inside the first — see the call site.
const A2A_NODE_SEPARATION_STEP_PX = 450;

async function patchFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  data: Record<string, unknown>,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  return res.json();
}

test.describe("A2A Client — A2AAgent component in Internal mode", () => {
  test(
    "the Internal dropdown lists a locally published agent and calling it runs that flow",
    { tag: ["@stable", "@components", "@workspace", "@a2a"] },
    async ({ page }) => {
      const headers = { Authorization: await getAuthToken(page.request) };
      await requireA2aEnabled(page.request, headers);

      // The dropdown lists agents by NAME (ids live in options_metadata), so the
      // test must own a name it can assert on unambiguously while the shared
      // superuser account may hold other published agents.
      const agentName = `a2a-target-${randomUUID().slice(0, 8)}`;
      const sentinel = `a2a-internal-${randomUUID()}`;

      const target = await createRunnableChatFlowViaApi(page.request, headers);
      let callerFlowId: string | null = null;

      try {
        await test.step("publish the target flow as an A2A agent under a known name", async () => {
          // One PATCH does both: publishing and naming. The name is what step 2
          // matches in the dropdown.
          const patched = await patchFlow(page.request, headers, target.flowId, {
            name: agentName,
            flow_type: "agent",
            a2a_enabled: true,
          });
          expect(patched.name).toBe(agentName);
          expect(patched.a2a_enabled).toBe(true);
        });

        await test.step("open a blank caller flow in the same project", async () => {
          // Created via the API and entered by id rather than through the New Flow
          // entry point, whose welcome overlay can leave the sidebar in the DOM
          // but not visible (#1265 signature).
          callerFlowId = await createFlow(
            page.request,
            {
              name: `a2a-caller-${randomUUID().slice(0, 8)}`,
              description: "Calls a published A2A agent in Internal mode",
              data: { nodes: [], edges: [] },
              is_component: false,
            },
            { headers },
          );
          await openFlowById(page, callerFlowId);
        });

        await test.step("add the A2A Agent component and switch it to Internal", async () => {
          await addComponentFromSidebar(page, A2A_SEARCH_TERM, A2A_ADD_BUTTON);
          await expect(page.getByTestId("title-A2A Agent")).toBeVisible();

          // Required: the node renders in External mode, where the picker does
          // not exist.
          await page.getByTestId(MODE_TAB_INTERNAL).click();
          await expect(page.getByTestId(AGENT_DROPDOWN)).toBeVisible();
        });

        await test.step("the dropdown offers the published agent, and it is selected", async () => {
          await page.getByTestId(AGENT_DROPDOWN).click();

          // Presence of THIS test's agent, never option count: the account is
          // shared and a parallel spec may hold its own published agent in the
          // same project.
          const option = page.getByTestId(`${agentName}-0-option`);
          await expect(option).toBeVisible();
          await option.click();

          await expect(page.getByTestId(AGENT_DROPDOWN)).toContainText(agentName);
        });

        await test.step("send a per-run sentinel as the message", async () => {
          await page.getByTestId(MESSAGE_INPUT).fill(sentinel);
        });

        await test.step("wire the response into a Chat Output", async () => {
          await addComponentFromSidebar(
            page,
            CHAT_OUTPUT_SEARCH_TERM,
            CHAT_OUTPUT_ADD_BUTTON,
          );
          // Sidebar adds land on top of each other; without this the drag below
          // can hit the wrong handle and fabricate a different connection (#939).
          //
          // The step is explicit because the helper's default (220) is SHORTER
          // than this node: the A2A Agent renders 401px tall in Internal mode
          // (measured), so a 220px move leaves Chat Output still inside it and
          // the helper's own overlap poll fails after 15s. Measured: the first
          // run of this spec failed exactly there.
          await separateOverlappingNodes(page, A2A_NODE_SEPARATION_STEP_PX);

          await page
            .getByTestId(A2A_RESPONSE_HANDLE)
            .dragTo(page.getByTestId(CHAT_OUTPUT_TARGET_HANDLE));
          await expect(page.locator(".react-flow__edge")).toHaveCount(1);
        });

        await test.step("running the flow returns what the remote agent echoed", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          await page.getByTestId("button-send").click();

          // The passthrough echoes its input verbatim, so the sentinel arriving
          // as the AI turn is causal evidence the TARGET flow ran — not that the
          // component returned something.
          await expect(
            page.getByTestId(`chat-message-AI-${sentinel}`),
          ).toBeVisible({ timeout: 60_000 });
        });
      } finally {
        // Guarded so one failure cannot skip the other: the caller flow is
        // deleted first because the editor is still open on it.
        if (callerFlowId) {
          await page.goto("/").catch(() => {});
          await deleteFlow(page.request, callerFlowId, { headers }).catch((e) =>
            console.warn(`⚠️ caller flow cleanup failed: ${e}`),
          );
        }
        await target
          .deleteFlow()
          .catch((e) => console.warn(`⚠️ target flow cleanup failed: ${e}`));
      }
    },
  );
});
