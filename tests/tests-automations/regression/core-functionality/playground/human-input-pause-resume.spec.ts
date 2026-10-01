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
 * A third test (issue #2050) reloads the page while the run is suspended and
 * claims the run outlives the tab: the same job is still parked, the decision is
 * re-offered from both stores that hold it, approving it completes that job, and
 * a second reload renders the answer as resolved. It lives in this file on
 * purpose — tests 1–2 run the identical pause/resume WITHOUT a reload in the same
 * shard against the same instance, so a red in test 3 carries its own control
 * (the spec doc's "rule out #1921 first" section).
 *
 * Sibling coverage — do not duplicate here:
 * - The node's configuration surface (default handles, adding a choice live,
 *   persistence across reload) is `core-components/human-input-node-config.spec.ts`
 *   (issue #1190). This spec never edits the node.
 * - `Enable Fallback` / `Timeout` and the resume API's 409/422 guards are listed
 *   as out of scope in the spec doc.
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
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";

// Pre-wired fixture: Chat Input (input_value = SENTINEL_PROMPT) -> Human Input
// (default Approve/Reject) -> one Chat Output per branch, each with its own
// `sender_name`. Built by wiring it in the UI on a live nightly and exporting
// through `GET /api/v1/flows/{id}` — a hand-written flow JSON renders empty
// (nodes need `type: "genericNode"` plus their full template) and an edge only
// attaches when its `sourceHandle` matches the handle's own `data-handleid`
// verbatim.
const FIXTURE_PATH = "tests/assets/flows/human-input-branching-fixture.json";

// The fixture's Human Input node id. `POST /api/v1/flows/` keeps node ids as
// sent (the pending request's `request_id` is `<this id>:<job_id>`), so the
// canvas pause badge can be scoped to this node's own `rf__node-<id>` wrapper.
const HUMAN_INPUT_NODE_ID: string = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf-8"),
).data.nodes.find(
  (node: { data?: { type?: string } }) => node.data?.type === "HumanInput",
).id;

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

// PARALLEL-SAFE, deliberately not serial. Each test owns its flow (a unique
// `${Date.now()}-${random}` name, so the backend's unique-name suffixing has
// nothing to race) and its own page, and a suspended run is flow-scoped, so the
// two cannot observe each other. The sibling fixture specs run serial for the
// name race; inheriting that here would cost real signal — under `mode: "serial"`
// a flake in the first test SKIPS the second, so one bad day in the daily would
// lose the Reject verdict entirely. Measured green at `--workers=2`.


/**
 * Create the fixture flow via the API, open it on the canvas and open the
 * Playground, ready for a run.
 *
 * The Playground input is asserted to be **pre-filled** from the Chat Input node
 * rather than typed into: that field re-injects the template default
 * asynchronously and races any text typed directly into it
 * (`authoring-conventions.md`).
 */
async function openHitlPlayground(page: Page): Promise<string> {
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
  // Both branch sinks are on the canvas.
  //
  // Explicit budgets, like every other readiness check here: the config sets no
  // `expect.timeout`, so a bare assertion gets Playwright's 5 s default, and a
  // canvas that hydrates node-by-node under a saturated CI backend would fail
  // these while the flow is merely slow.
  await expect(page.getByTestId("title-Approved Output")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("title-Rejected Output")).toBeVisible({
    timeout: 30000,
  });

  // The EDGES are the precondition, and they need their own assertion: React
  // Flow renders nodes independently of edges, so a fixture that lost a branch
  // edge still shows both titles above (measured — both visible with both branch
  // edges stripped). Without this, that defect surfaces 30 s later as "the
  // decision card never appeared", blaming the card UI for a wiring problem —
  // because a Human Input with no downstream consumer SKIPS the pause entirely
  // (`_has_downstream_consumer()` → "Skipped: no connected outputs").
  await expect(page.locator(".react-flow__edge")).toHaveCount(3, {
    timeout: 30000,
  });

  await adjustScreenView(page);

  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground")).toHaveValue(
    SENTINEL_PROMPT,
    { timeout: 30000 },
  );

  return flowId;
}

/**
 * How many HITL requests the backend currently holds suspended for this flow.
 *
 * The server-side counterpart to the card: `GET /api/v2/workflows/pending` lists
 * the suspended jobs of ONE flow (it 422s without `flow_id`, so it can never see
 * another spec's run). It is what separates "the card is on screen" from "the run
 * is parked", and, after the answer, "a bubble rendered" from "the run is no
 * longer suspended".
 */
async function pendingHitlCount(page: Page, flowId: string): Promise<number> {
  const rows = await pendingHitlRequests(page, flowId);
  return rows === null ? -1 : rows.length;
}

/**
 * The suspended HITL requests the backend holds for this flow, one row per
 * suspended job — `null` when the body is not a list. Test 3 reads `job_id` to
 * prove the request recovered after a reload is the SAME run, not a new one.
 */
async function pendingHitlRequests(
  page: Page,
  flowId: string,
): Promise<Array<{ job_id: string }> | null> {
  const authHeader = await getAuthToken(page.request);
  const res = await page.request.get(
    `/api/v2/workflows/pending?flow_id=${flowId}`,
    authHeader ? { headers: { Authorization: authHeader } } : undefined,
  );
  if (!res.ok()) throw new Error(`GET /workflows/pending → ${res.status()}`);
  const body = await res.json();
  return Array.isArray(body) ? body : null;
}

/**
 * The job's status as `GET /api/v2/workflows?job_id=` reports it —
 * `"suspended"` while parked, `"completed"` once the resumed run reaches its
 * terminal state. Only `status` is read: the response's `outputs` map has
 * regressed to `{}` on a sibling path before (#1575), and the UI bubbles already
 * pin routing.
 */
async function workflowStatus(page: Page, jobId: string): Promise<string> {
  const authHeader = await getAuthToken(page.request);
  const res = await page.request.get(
    `/api/v2/workflows?job_id=${jobId}`,
    authHeader ? { headers: { Authorization: authHeader } } : undefined,
  );
  if (!res.ok()) throw new Error(`GET /workflows?job_id → ${res.status()}`);
  const body = await res.json();
  return String(body?.status);
}

/**
 * Reload the editor and wait for the canvas. After a reload the Playground is
 * closed, which is what lets the canvas pause badge render at all
 * (`useAwaitingHumanInput()` hides it while the Playground is open).
 */
async function reloadEditor(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("title-Human Input")).toBeVisible({
    timeout: 30000,
  });
}

/**
 * The Playground transcript. Scoping to it keeps the canvas popover's card —
 * which carries the same `human-input-card` testid — from standing in for the
 * Playground's.
 */
const transcript = (page: Page) =>
  page.getByRole("log", { name: "Chat messages" });

/** Send the pre-filled prompt and wait for the run to park on the decision card. */
async function sendAndExpectPause(page: Page, flowId: string): Promise<void> {
  await page.getByTestId("button-send").click();

  const card = page.getByTestId("human-input-card");
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText(SENTINEL_PROMPT);

  // One enabled button per configured choice.
  await expect(page.getByTestId(BRANCHES.approve.decision)).toBeEnabled({
    timeout: 15000,
  });
  await expect(page.getByTestId(BRANCHES.reject.decision)).toBeEnabled({
    timeout: 15000,
  });

  // The run is parked SERVER-SIDE, not just visually: the backend holds exactly
  // one suspended request for this flow.
  await expect
    .poll(() => pendingHitlCount(page, flowId), { timeout: 30000 })
    .toBe(1);

  // And it is a pause rather than a slow completion: neither branch has emitted.
  // (The empty `chat-message-AI-` bubble present here is NOT the component's
  // return value — it is a host message the frontend synthesizes in
  // `injectHumanInputCard()` purely to carry the card's content block. Ignored on
  // purpose; every assertion here is scoped to the sender-named bubbles.)
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
  flowId: string,
  chosen: keyof typeof BRANCHES,
): Promise<void> {
  const other = chosen === "approve" ? "reject" : "approve";

  await page.getByTestId(BRANCHES[chosen].decision).click();

  await expect(bubble(page, BRANCHES[chosen].sender)).toBeVisible({
    timeout: 30000,
  });
  await expect(bubble(page, BRANCHES[other].sender)).toHaveCount(0);

  // The run left the suspended state — the answer reached the backend and the
  // job resumed. Without this, a resume that silently never completed would pass
  // every assertion above: the routed bubble arrives through the message-query
  // invalidation, independent of the run's own event stream.
  await expect
    .poll(() => pendingHitlCount(page, flowId), { timeout: 30000 })
    .toBe(0);

  // The card's own affordance follows the answer: only the chosen action remains,
  // disabled. Deliberately weak claims — `HumanInputCard` sets this from local
  // state synchronously (measured 45 ms after the click, before the request is
  // even sent) and keeps it locked on an error too, so this pins the UI, never
  // that the backend accepted anything. The `pending` poll above is what does
  // that.
  await expect(page.getByTestId(BRANCHES[other].decision)).toHaveCount(0);
  await expect(page.getByTestId(BRANCHES[chosen].decision)).toBeDisabled();
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the editor first so it stops polling `GET /flows/{id}/events` on a
  // flow about to be deleted, then pass an explicit Bearer — `page.request` is
  // unauthenticated under AUTO_LOGIN and would 401.
  await unmountEditorForCleanup(page, "/");
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
      let flowId = "";

      await test.step("Open the pre-wired HITL flow in the Playground", async () => {
        flowId = await openHitlPlayground(page);
      });

      await test.step("Sending the prompt suspends the run on the decision card", async () => {
        await sendAndExpectPause(page, flowId);
      });

      await test.step("Approving resumes the run through the approved branch only", async () => {
        await answerAndExpectExclusiveRouting(page, flowId, "approve");
      });
    },
  );

  test("rejecting a Human Input pause routes only the reject branch",
    { tag: ["@stable", "@release", "@playground"] },
    async ({ page }) => {
      let flowId = "";

      await test.step("Open the pre-wired HITL flow in the Playground", async () => {
        flowId = await openHitlPlayground(page);
      });

      await test.step("Sending the prompt suspends the run on the decision card", async () => {
        await sendAndExpectPause(page, flowId);
      });

      await test.step("Rejecting resumes the run through the reject branch only", async () => {
        await answerAndExpectExclusiveRouting(page, flowId, "reject");
      });
    },
  );

  test("a suspended Human Input run survives a page reload and completes on approval",
    { tag: ["@stable", "@database", "@playground"] },
    async ({ page }) => {
      let flowId = "";
      let jobId = "";

      await test.step("Open the pre-wired HITL flow in the Playground", async () => {
        flowId = await openHitlPlayground(page);
      });

      await test.step("Sending the prompt suspends the run on the decision card", async () => {
        await sendAndExpectPause(page, flowId);

        const rows = await pendingHitlRequests(page, flowId);
        expect(rows).toHaveLength(1);
        jobId = rows![0].job_id;
        expect(jobId).toBeTruthy();
        expect(await workflowStatus(page, jobId)).toBe("suspended");
      });

      await test.step("Reloading the page leaves the same run parked server-side", async () => {
        await reloadEditor(page);

        // Exactly one suspended request, and it is the run started before the
        // reload — a reload that started a fresh run, or lost the job, fails here.
        const rows = await pendingHitlRequests(page, flowId);
        expect(rows).toHaveLength(1);
        expect(rows![0].job_id).toBe(jobId);
        expect(await workflowStatus(page, jobId)).toBe("suspended");
      });

      await test.step("The canvas re-offers the decision on the Human Input node", async () => {
        // Derived from the pending-job list, not from the chat history.
        const node = page.getByTestId(`rf__node-${HUMAN_INPUT_NODE_ID}`);
        await expect(node.getByTestId("human-input-node-badge")).toBeVisible({
          timeout: 30000,
        });
        const card = node.getByTestId("human-input-card");
        await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card).toContainText(SENTINEL_PROMPT);
        await expect(card.getByTestId(BRANCHES.approve.decision)).toBeEnabled();
        await expect(card.getByTestId(BRANCHES.reject.decision)).toBeEnabled();
      });

      await test.step("The Playground transcript is restored with the open decision card", async () => {
        await page.getByTestId("playground-btn-flow-io").click();

        // Derived from the persisted chat message — the second store.
        const log = transcript(page);
        await expect(
          log.getByTestId(`chat-message-User-${SENTINEL_PROMPT}`),
        ).toBeVisible({ timeout: 30000 });
        const card = log.getByTestId("human-input-card");
        await expect(card).toBeVisible({ timeout: 30000 });
        await expect(card).toContainText(SENTINEL_PROMPT);
        await expect(card.getByTestId(BRANCHES.approve.decision)).toBeEnabled({
          timeout: 15000,
        });
        await expect(card.getByTestId(BRANCHES.reject.decision)).toBeEnabled({
          timeout: 15000,
        });

        // The reload neither completed nor replayed the run.
        await expect(bubble(page, BRANCHES.approve.sender)).toHaveCount(0);
        await expect(bubble(page, BRANCHES.reject.sender)).toHaveCount(0);
      });

      await test.step("Approving the recovered card completes the original run", async () => {
        await transcript(page)
          .getByTestId("human-input-card")
          .getByTestId(BRANCHES.approve.decision)
          .click();

        await expect(bubble(page, BRANCHES.approve.sender)).toBeVisible({
          timeout: 30000,
        });
        await expect(bubble(page, BRANCHES.reject.sender)).toHaveCount(0);

        await expect
          .poll(() => pendingHitlCount(page, flowId), { timeout: 30000 })
          .toBe(0);
        // The terminal state, on the job started before the reload.
        await expect
          .poll(() => workflowStatus(page, jobId), { timeout: 30000 })
          .toBe("completed");
      });

      await test.step("A second reload renders the answered card as resolved", async () => {
        await reloadEditor(page);
        await page.getByTestId("playground-btn-flow-io").click();

        const log = transcript(page);
        // The approved bubble is the positive anchor: it proves the transcript
        // loaded, so the decision assertions below cannot pass on an empty log.
        await expect(
          log.getByTestId(`chat-message-${BRANCHES.approve.sender}-${SENTINEL_PROMPT}`),
        ).toBeVisible({ timeout: 30000 });
        await expect(bubble(page, BRANCHES.reject.sender)).toHaveCount(0);

        // No local state survives the reload, so this rendering can only come from
        // the `submitted_action` the resume persisted on the card message.
        const card = log.getByTestId("human-input-card");
        await expect(card).toBeVisible({ timeout: 30000 });
        await expect(card.getByTestId(BRANCHES.reject.decision)).toHaveCount(0);
        await expect(card.getByTestId(BRANCHES.approve.decision)).toBeDisabled();
      });
    },
  );
});
