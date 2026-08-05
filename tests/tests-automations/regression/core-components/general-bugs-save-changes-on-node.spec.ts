import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { renameFlow } from "../../../helpers/flows/rename-flow";
import { leaveFlowEditor } from "../../../helpers/flows/leave-flow-editor";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { expandFocusedNode } from "../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

// This file had no teardown of any kind, so every run left the blank flow it
// creates behind (#1154). Captured by id from the creation responses and deleted
// id-scoped — never a name or wipe sweep, which would kill flows other parallel
// workers are driving (#553). Shared implementation (#1108), so the fix lands in
// one place rather than as another hand-copied local variant.
let flows: FlowTracker | undefined;

test.beforeEach(async ({ page }) => {
  flows = trackCreatedFlows(page);
  // Before the first document load — the only moment the assistant onboarding
  // tooltip can be suppressed, since upstream reads its flag once at the mount of
  // the canvas-controls bar (#1220). `expandFocusedNode` below asserts this ran.
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ request }) => {
  const tracker = flows;
  // Null out BEFORE awaiting. This file has ONE test today, so the hazard the
  // null-out closes cannot occur here — it needs a later test whose `beforeEach`
  // threw while the binding still holds the previous test's tracker. Kept anyway
  // so both files this issue touches carry one shape, and so a second test added
  // here is covered without anyone re-deriving the reasoning. See the block in
  // `flow-functionality/flow-rename-header.spec.ts`, where it IS load-bearing.
  flows = undefined;
  // Default (log and continue), not `strict`: there was no teardown to preserve
  // the contract of, and failing an otherwise-green test on a cleanup blip would
  // be a new one.
  await tracker?.cleanup(request);
});

/**
 * The `input_value` the server currently holds for the flow's single node.
 *
 * Takes the bearer rather than resolving one, because this runs inside
 * `expect.poll`: `getAuthToken` carries a `[2000, 8000, 20000]` retry budget, so a
 * backend hiccup on ONE poll iteration could block for up to 30 s — longer than
 * the poll's own 20 s timeout — and the failure would then read as "the autosave
 * never persisted" when the real cause was auth.
 */
async function readPersistedInputValue(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
): Promise<unknown> {
  const response = await request.get(`/api/v1/flows/${flowId}`, {
    headers: bearer ? { Authorization: bearer } : undefined,
  });
  if (!response.ok()) return `GET /api/v1/flows/${flowId} → ${response.status()}`;
  const body = await response.json();
  const nodes = body?.data?.nodes ?? [];
  if (nodes.length !== 1) return `expected 1 node, got ${nodes.length}`;
  return nodes[0]?.data?.node?.template?.input_value?.value;
}

/**
 * Fill the node's textarea, wait for the AUTOSAVE to persist it, leave the flow,
 * come back, and assert the value is rehydrated.
 *
 * The server gate is the oracle, and it is load-bearing for two separate reasons
 * (both measured while reviewing #1290):
 *
 *  1. **It is what makes autosave the thing under test.** Without it the value was
 *     persisted by the EXIT, not by the autosave: the debounced `PATCH` fires at
 *     fill + ~1015 ms, while `leaveFlowEditor`'s drain (`quietMs = 700`, armed
 *     immediately because nothing is in flight yet) resolved ~707 ms after the
 *     fill — before the autosave was even issued. `FlowPage.handleSave`, reached
 *     through the unsaved-changes blocker, then saved the flow itself, so the
 *     assertion below passed with the debounced autosave disabled entirely.
 *  2. **It keeps the #1153 blocker out of the run.** That dialog renders whenever
 *     the store has diverged from what is persisted, which at exit time was ALWAYS
 *     — measured on 4 of 4 iterations. `leaveFlowEditor` sizes its 15 s grace on
 *     that dialog being rare (#1005 measured twice in 24 runs), and this spec was
 *     making it certain, four times per run, in the daily. With the value already
 *     persisted the store is clean and the dialog never appears.
 */
async function verifyTextareaValue(
  page: Page,
  request: APIRequestContext,
  bearer: string,
  value: string,
  flowId: string,
) {
  const textarea = page.getByTestId("textarea_str_input_value");
  await textarea.waitFor({ state: "visible" });
  await textarea.fill(value);
  await expect(textarea).toHaveValue(value);

  // The autosave — not the exit — must be what commits it.
  await expect
    .poll(() => readPersistedInputValue(request, bearer, flowId), {
      timeout: 20000,
      intervals: [500, 1000, 2000],
      message: "the debounced autosave should persist the typed value",
    })
    .toBe(value);

  // Now a clean exit. The verdict is asserted for ONE narrow property, stated
  // narrowly on purpose: a blocker that LINGERS is caught, a blocker that flashes
  // is not. `classifyEditorExit` polls every 200 ms, so a dialog that renders and
  // clears inside that window reads as "left" — measured: removing the gate above
  // still produced "left" on all four exits. What it does catch is the
  // flake-relevant case, the dialog still up when the poll looks, which is the
  // shape that costs #1153's 15 s grace and then throws.
  //
  // The gate above is what makes the autosave the oracle; this only keeps the
  // #1153 exposure visible.
  const verdict = await leaveFlowEditor(page);
  expect(
    verdict,
    "the exit should not sit on the unsaved-changes blocker — with the value " +
      "already persisted there is nothing for it to block on (#1153)",
  ).toBe("left");

  // Re-enter by flow ID, never `getByText(flowName).first()`: the home list sorts
  // by `updated_at`, so position 0 belongs to whichever worker touched a flow
  // last, and the card's own name div is `pointer-events-none` since the a11y
  // refactor (Langflow #13891). Same pattern as `setup-blank-flow.ts`.
  const openButton = page.locator(
    `[data-testid="list-card-open-button"][aria-labelledby*="${flowId}"]`,
  );
  await openButton.waitFor({ state: "visible", timeout: 30000 });
  await openButton.dispatchEvent("click");

  await expect(page.getByTestId("textarea_str_input_value")).toHaveValue(value, {
    timeout: 30000,
  });
}

test("any changes on the node must be saved on user interaction",
  { tag: ["@stable", "@release", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const randomValues = Array.from({ length: 4 }, () =>
      Math.random().toString(36).substring(2, 8),
    );
    const randomFlowName = Math.random().toString(36).substring(2, 8);

    await awaitBootstrapTest(page);

    // `awaitBootstrapTest` creates a flow of its own, and the tracker captures
    // EVERY `POST /flows` 201 — so the ids present before the click are not ours.
    // Taking the set difference rather than the first (or last) captured id: the
    // first is the bootstrap's, and depending on insertion order is how #490/#681
    // deleted the wrong flow twice.
    await flows!.settle();
    const bootstrapIds = new Set(flows!.ids());

    await page.getByTestId("blank-flow").click();
    await adjustScreenView(page);

    await renameFlow(page, { flowName: randomFlowName });

    // Chat Input, not Text Output: upstream marked Text Input/Output
    // `legacy: true` and hides them from the sidebar, so this spec waited 20 s on
    // a testid that no longer renders (#1290). Chat Input's `input_value` is the
    // same `MultilineInput` (`multiline: true`), so it renders the SAME
    // `textarea_str_input_value` — the mechanism under test is unchanged, only the
    // host node is one a user can still add.
    await addComponentFromSidebar(page, "chat input", "add-component-button-chat-input");
    await expect(page.getByTestId("title-Chat Input")).toBeVisible({
      timeout: 30000,
    });

    // Chat Input ships `minimized = True`, so its fields are in the DOM but
    // HIDDEN — the migration's first attempt failed on a `textarea_str_input_value`
    // that resolved to a hidden input. Expanding is therefore part of the setup,
    // not a nicety; the helper is idempotent and handles the #867 deselection
    // defect on the ⋮ menu.
    await page.getByTestId("title-Chat Input").click();
    await expandFocusedNode(page);

    // The blank flow's own id — the same one `afterEach` deletes, and what every
    // re-entry below anchors on.
    await flows!.settle();
    const newIds = flows!.ids().filter((id) => !bootstrapIds.has(id));
    // `failedCreations()` is in the message on purpose: a `POST /api/v1/flows/`
    // 500 (which this instance does emit under load — "An internal error occurred
    // while creating the flow") leaves this list empty, and without naming it the
    // failure reads as a tracker bug instead of a backend one.
    expect(
      newIds,
      `the blank-flow click should have created exactly one flow; failed creations: ${
        JSON.stringify(flows!.failedCreations())
      }`,
    ).toHaveLength(1);
    const [flowId] = newIds;

    // Resolved ONCE, outside the poll below — see `readPersistedInputValue`.
    const bearer = await getAuthToken(request);

    // Take focus off the node before the first edit.
    await page.getByTestId("app-header").first().click();

    for (const value of randomValues) {
      await verifyTextareaValue(page, request, bearer, value, flowId);
    }
  },
);
