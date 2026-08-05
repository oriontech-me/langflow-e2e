/**
 * Human Input pause/resume in the Playground — the HITL decision card.
 *
 * The execution half of the Human Input feature (Langflow 1.11.0 — upstream
 * #13633 durable background execution + suspend/resume, #14090 polish): sending
 * a message parks the run and renders the decision card, answering it resumes
 * the run, and the answer routes EXACTLY one branch.
 *
 * Two mirrored tests, Approve and Reject. Mirroring is the point: a spec that
 * only ever approves cannot distinguish exclusive routing from "the approve
 * branch is the only one wired".
 *
 * Sibling coverage — do not duplicate here:
 * - The node's configuration surface (default handles, adding a choice live,
 *   persistence across reload) is `core-components/human-input-node-config.spec.ts`
 *   (issue #1190). This spec never edits the node.
 * - `Enable Fallback` / `Timeout`, recovering a suspended run after a reload
 *   (`GET /api/v2/workflows/pending`) and the resume API's 409/422 guards are
 *   listed as out of scope in the spec doc.
 *
 * Spec doc: `docs/core-functionality/playground/human-input-pause-resume.md`.
 * No provider credentials — `route_branch()` returns the prompt text itself.
 */

import { readFileSync } from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

// Pre-wired fixture: Chat Input (input_value = SENTINEL_PROMPT) -> Human Input
// (default Approve/Reject) -> one Chat Output per branch, each with its own
// `sender_name`. Built by wiring it in the UI on a live nightly and exporting
// through `GET /api/v1/flows/{id}` — a hand-written flow JSON renders empty
// (nodes need `type: "genericNode"` plus their full template) and an edge only
// attaches when its `sourceHandle` matches the handle's own `data-handleid`
// verbatim.
const FIXTURE_PATH = "tests/assets/flows/human-input-branching-fixture.json";

// The Chat Input's stored value. The Playground pre-fills from the node, so this
// is also the text of the user bubble, of the card's prompt, and of whichever
// branch output emits.
const SENTINEL_PROMPT = "HITL-1189 please review this request";

/**
 * The two branch sinks, keyed by the decision that should reach them.
 *
 * `sender_name` is what makes routing observable at all: `route_branch()`
 * returns the same `Message(text=prompt)` on whichever branch wins, so both
 * Chat Outputs would emit identical text. The bubble testid is
 * `chat-message-${sender_name}-${text}`, so a distinct sender per branch turns
 * "only the approved branch ran" into an exact locator plus a `toHaveCount(0)`.
 */
const BRANCHES = {
  approve: { decision: "human-input-decision-approve", sender: "APPROVED" },
  reject: { decision: "human-input-decision-reject", sender: "REJECTED" },
} as const;

const bubble = (page: Page, sender: string) =>
  page.getByTestId(`chat-message-${sender}-${SENTINEL_PROMPT}`);

// Ids of the flows each test creates; teardown deletes only these via the API
// (scoped) — never a global wipe, which kills flows other workers are driving.
const createdFlowIds: string[] = [];

// Each test creates a named flow through the API and those creations race on the
// backend's unique-name suffixing under parallelism (same reason as the sibling
// fixture specs).
test.describe.configure({ mode: "serial" });

/**
 * Create the fixture flow via the API, open it on the canvas and open the
 * Playground, ready for a run.
 *
 * The Playground input is asserted to be **pre-filled** from the Chat Input node
 * rather than typed into: that field re-injects the template default
 * asynchronously and races any text typed directly into it
 * (`authoring-conventions.md`).
 */
async function openHitlPlayground(page: Page): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  const authHeader = await getAuthToken(page.request);
  const headers: Record<string, string> = authHeader
    ? { Authorization: authHeader }
    : {};

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const flowId = await createFlow(
    page.request,
    {
      name: `HITL Approve Reject ${uniqueSuffix}`,
      description: fixture.description,
      data: fixture.data,
      is_component: false,
    },
    { headers },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await expect(page.getByTestId("title-Human Input")).toBeVisible({
    timeout: 30000,
  });
  // Both branch sinks must be on the canvas: a Human Input with no downstream
  // consumer SKIPS the pause entirely (`_has_downstream_consumer()` →
  // "Skipped: no connected outputs"), so a fixture that lost an edge would make
  // the whole spec assert nothing.
  await expect(page.getByTestId("title-Approved Output")).toBeVisible();
  await expect(page.getByTestId("title-Rejected Output")).toBeVisible();
  await adjustScreenView(page);

  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground")).toHaveValue(
    SENTINEL_PROMPT,
    { timeout: 30000 },
  );
}

/** Send the pre-filled prompt and wait for the run to park on the decision card. */
async function sendAndExpectPause(page: Page): Promise<void> {
  await page.getByTestId("button-send").click();

  const card = page.getByTestId("human-input-card");
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText(SENTINEL_PROMPT);

  // One enabled button per configured choice.
  await expect(page.getByTestId(BRANCHES.approve.decision)).toBeEnabled();
  await expect(page.getByTestId(BRANCHES.reject.decision)).toBeEnabled();

  // This is what makes it a PAUSE and not a slow completion: neither branch has
  // emitted. (The empty `chat-message-AI-` bubble present here is the Human
  // Input's own `Message(text="")` on the suspend path — deliberately ignored.)
  await expect(bubble(page, BRANCHES.approve.sender)).toHaveCount(0);
  await expect(bubble(page, BRANCHES.reject.sender)).toHaveCount(0);
}

/**
 * Answer the card and assert the run resumed through exactly one branch.
 *
 * The positive assertion runs FIRST, so the `toHaveCount(0)` that follows cannot
 * pass vacuously on a page where nothing rendered at all.
 */
async function answerAndExpectExclusiveRouting(
  page: Page,
  chosen: keyof typeof BRANCHES,
): Promise<void> {
  const other = chosen === "approve" ? "reject" : "approve";

  await page.getByTestId(BRANCHES[chosen].decision).click();

  await expect(bubble(page, BRANCHES[chosen].sender)).toBeVisible({
    timeout: 30000,
  });
  await expect(bubble(page, BRANCHES[other].sender)).toHaveCount(0);

  // The card records the answer: it keeps only the chosen action, disabled.
  await expect(page.getByTestId(BRANCHES[other].decision)).toHaveCount(0);
  await expect(page.getByTestId(BRANCHES[chosen].decision)).toBeDisabled();
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the editor first so it stops polling `GET /flows/{id}/events` on a
  // flow about to be deleted, then pass an explicit Bearer — `page.request` is
  // unauthenticated under AUTO_LOGIN and would 401.
  await page.goto("/").catch(() => {});
  const authHeader = await getAuthToken(page.request);
  const opts = authHeader
    ? { headers: { Authorization: authHeader } }
    : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

test.describe("Human Input pause/resume in the Playground", () => {
  test("approving a Human Input pause routes only the approved branch",
    { tag: ["@stable", "@release", "@playground"] },
    async ({ page }) => {
      await test.step("Open the pre-wired HITL flow in the Playground", async () => {
        await openHitlPlayground(page);
      });

      await test.step("Sending the prompt suspends the run on the decision card", async () => {
        await sendAndExpectPause(page);
      });

      await test.step("Approving resumes the run through the approved branch only", async () => {
        await answerAndExpectExclusiveRouting(page, "approve");
      });
    },
  );

  test("rejecting a Human Input pause routes only the reject branch",
    { tag: ["@stable", "@release", "@playground"] },
    async ({ page }) => {
      await test.step("Open the pre-wired HITL flow in the Playground", async () => {
        await openHitlPlayground(page);
      });

      await test.step("Sending the prompt suspends the run on the decision card", async () => {
        await sendAndExpectPause(page);
      });

      await test.step("Rejecting resumes the run through the reject branch only", async () => {
        await answerAndExpectExclusiveRouting(page, "reject");
      });
    },
  );
});
