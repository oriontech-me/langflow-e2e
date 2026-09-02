import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { clearCanvasBottomOverlay } from "../../../../helpers/ui/clear-canvas-bottom-overlay";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";

/**
 * n_messages limits the number of retained messages (QA-CHECKLIST §6.3).
 *
 * Proven by a deterministic COUNT, not by model recall: seed a session with a
 * known number of messages (5 API chat runs -> 10 stored messages), point a
 * Message History component (mode Retrieve) at that session in the SAME flow
 * (retrieval is flow-scoped — cross-flow leak fix, PR #13087), run the node,
 * and count the messages in its output inspector.
 *
 *   Test 1 — n_messages=2:  exactly the 2 MOST RECENT messages come back.
 *   Test 2 — causal control, n_messages=100: all 10 come back. Only
 *            n_messages differs, so Test 1's truncation is caused by the limit.
 *
 * Issue #482 flagged a backend bug (value ignored) and asked to gate this
 * expected-fail. Reproduction on 1.11.0.dev33 shows the parameter is RESPECTED,
 * so this is a normal passing @stable test. The Agent-recall observable the
 * issue implies is non-deterministic at the window threshold (three sentinel
 * designs flaked at spec level); the Agent resolves memory through the same
 * backend retrieval this component uses, so the count validates the same
 * contract — deviation flagged on the issue/PR.
 *
 * No provider API key and no --workers=1 needed: the flow is a Chat Input ->
 * Chat Output passthrough created via API with a unique name and deleted after.
 */

const SEED_RUNS = 5;
const SEEDED_MESSAGES = SEED_RUNS * 2; // each run stores User + Machine

interface SeededFlow {
  flowId: string;
  session: string;
  sentinel: string;
  cleanup: () => Promise<void>;
}

// Create a passthrough flow and seed its session with SEEDED_MESSAGES messages
// via POST /api/v1/run (x-api-key auth), then verify the exact stored count via
// the monitor API — a failed seed must fail here, not silently pass an
// empty-output check later.
async function seedFlowSession(request: APIRequestContext): Promise<SeededFlow> {
  const bearer = await getAuthToken(request);

  const keyRes = await request.post("/api/v1/api_key/", {
    headers: { Authorization: bearer },
    data: { name: `nmsg-limit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  });
  expect(keyRes.status()).toBe(200);
  const { api_key: apiKey, id: apiKeyId } = await keyRes.json();

  const { flowId, deleteFlow } = await createRunnableChatFlowViaApi(request, {
    Authorization: bearer,
  });

  const sentinel = `NMSG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = `${sentinel}-session`;

  for (let i = 1; i <= SEED_RUNS; i++) {
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: `${sentinel}-${i}`,
        input_type: "chat",
        output_type: "chat",
        session_id: session,
      },
    });
    expect(runRes.status()).toBe(200);
  }

  // Persistence can lag the run response slightly — poll to the exact count.
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `/api/v1/monitor/messages?session_id=${session}`,
          { headers: { Authorization: bearer } },
        );
        if (res.status() !== 200) return -1;
        return ((await res.json()) as unknown[]).length;
      },
      { timeout: 15000 },
    )
    .toBe(SEEDED_MESSAGES);

  return {
    flowId,
    session,
    sentinel,
    cleanup: async () => {
      // Multi-step teardown: swallow so a failed flow delete still lets the
      // API-key cleanup below run.
      await deleteFlow().catch(() => {});
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    },
  };
}

// In the seeded flow: add a Message History node, expose its hidden
// n_messages/session_id fields, point it at the session, run it, and return
// the retrieved text from the output inspector. The default retrieve template
// renders one "{sender_name}: {text}" line per message, so sentinel
// occurrences in the returned text count the retrieved messages exactly.
async function retrieveViaMessageHistory(
  page: Page,
  flowId: string,
  session: string,
  nMessages: string,
): Promise<string> {
  await page.goto(`/flow/${flowId}`);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });

  await addComponentFromSidebar(
    page,
    "message history",
    "add-component-button-message-history",
  );
  const node = page.locator('[data-testid^="rf__node-Memory"]').first();
  await expect(node).toBeVisible({ timeout: 15000 });
  // Fit the canvas BEFORE selecting the node: a sidebar-added node can land
  // outside the viewport, taking `parameters-button` — which mounts in the
  // node's own toolbar — off-screen with it (#989). Order matters: fitting
  // AFTER selection drops the selection and unmounts the toolbar (#867).
  await adjustScreenView(page, { numberOfZoomOut: 0 });

  // n_messages and session_id are hidden by default — expose them on the node
  // body via the inspector (dev46 replaced the edit-fields modal + show<field>).
  await page.getByTestId("title-Message History").click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-n_messages").click();
  await page.getByTestId("inspector-add-session_id").click();
  await closeAdvancedOptions(page);

  await page.getByTestId("int_int_n_messages").fill(nMessages);
  await page.getByTestId("popover-anchor-input-session_id").fill(session);
  await waitForFlowSaveSettled(page);

  await page.getByTestId("button_run_message history").click();
  await page.waitForSelector("text=built successfully", { timeout: 30000 });

  // The canvas' bottom-centre slot is shared by the build-status bar and the
  // "Flow needs review" banner, and the banner takes the slot back the moment the
  // bar auto-dismisses. This node's inspect button sits ~5 px from that slot, so
  // the click is refused for as long as the taller banner owns it — #1643. Free
  // the slot instead of retrying under it.
  await clearCanvasBottomOverlay(page);

  // The inspector button stays disabled until the selected output has
  // non-empty data — it becoming enabled already signals a non-empty retrieval.
  const inspectButton = page.getByTestId("output-inspection-messages-memory");
  await expect(inspectButton).toBeEnabled({ timeout: 20000 });
  await inspectButton.click();

  const dialog = page.locator('[role="dialog"]').last();
  const textarea = dialog.getByTestId("textarea");
  await expect(textarea).toBeVisible({ timeout: 15000 });
  return textarea.inputValue();
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test.describe("Message History n_messages limit", () => {
  test(
    "a small n_messages truncates retrieval to the most recent messages",
    { tag: ["@stable", "@regression", "@agents", "@components"] },
    async ({ page, request }) => {
      const seeded = await seedFlowSession(request);
      try {
        const retrieved = await test.step(
          "retrieve the seeded session with n_messages=2",
          () => retrieveViaMessageHistory(page, seeded.flowId, seeded.session, "2"),
        );

        await test.step("assert exactly the 2 most recent messages came back", async () => {
          // Exact count — an unbounded retrieval (the #482 bug) returns all 10.
          expect(countOccurrences(retrieved, seeded.sentinel)).toBe(2);
          // The limit keeps the most recent slice: newest present, oldest absent.
          expect(retrieved).toContain(`${seeded.sentinel}-${SEED_RUNS}`);
          expect(retrieved).not.toContain(`${seeded.sentinel}-1`);
        });
      } finally {
        await seeded.cleanup();
      }
    },
  );

  test(
    "causal control — a large n_messages retrieves the full seeded history",
    { tag: ["@stable", "@regression", "@agents", "@components"] },
    async ({ page, request }) => {
      const seeded = await seedFlowSession(request);
      try {
        const retrieved = await test.step(
          "retrieve the seeded session with n_messages=100",
          () => retrieveViaMessageHistory(page, seeded.flowId, seeded.session, "100"),
        );

        await test.step("assert all 10 seeded messages came back", async () => {
          // Only n_messages differs from Test 1, so Test 1's truncation is
          // attributable to the limit, not to a broken seed or retrieval.
          expect(countOccurrences(retrieved, seeded.sentinel)).toBe(SEEDED_MESSAGES);
          expect(retrieved).toContain(`${seeded.sentinel}-1`);
          expect(retrieved).toContain(`${seeded.sentinel}-${SEED_RUNS}`);
        });
      } finally {
        await seeded.cleanup();
      }
    },
  );
});
