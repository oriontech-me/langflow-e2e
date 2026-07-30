import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * LE-2037 / langflow#14096, fixed by langflow#14312: node parameter fields
 * derived their DOM id from the template type/name alone, so two nodes exposing
 * a field with the same name rendered duplicate ids — a WCAG 4.1.1 violation
 * that also breaks browser autofill. The fix scopes the DOM id by nodeId
 * (`<id>-<nodeId>`) and deliberately leaves `data-testid` unscoped, which is
 * what this suite selects on. Both halves are asserted here.
 *
 * The `data-testid` half is the load-bearing one for this repository. 132 call
 * sites across 45 specs select node fields by `data-testid`; if uniqueness were
 * ever "fixed" by scoping the testid instead, this spec fails first and names
 * the cause, instead of 45 files failing at once for no obvious reason.
 *
 * Sibling specs place two identical nodes but assert only node counts, so none
 * of them covers this: `ui-ux/langflowShortcuts.spec.ts` (duplication via
 * shortcuts, deliberately using a node with no text field) and
 * `flow-functionality/canvas-copy-paste.spec.ts` (paste of a second Prompt
 * Template). `core-components/chat-input-output-component-regression.spec.ts`
 * actually hit this ambiguity and worked around it with a node-scoped filter.
 *
 * NOT serial: the two tests drive independent flows created with unique names
 * and share no state, so parallelism races nothing. Keeping them independent is
 * deliberate — under `mode: "serial"` a failure in the first test SKIPS the
 * second, which would leave the daily with no verdict at all for that case.
 */

// The React Flow canvas root. The duplicate sweep is scoped to it rather than to
// `document` — see `collectDuplicateFormFieldIds`.
const CANVAS_ROOT_ID = "react-flow-id";

// Ids of the flows each test created, deleted id-scoped in afterEach (repo
// convention #490/#681) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively driving (#553).
const createdFlowIds: string[] = [];

test.afterEach(async ({ page, request }) => {
  if (createdFlowIds.length === 0) return;
  // Leave the editor BEFORE deleting, so the mounted flow page stops polling a
  // flow that is about to disappear (a mid-poll delete 404s, which the fixture
  // logs as a backend error — see the run on this spec's own PR).
  //
  // Unconditional, including on failure: with `@playwright/test` 1.58.2 (the
  // pinned version) the `only-on-failure` screenshot is captured BEFORE the
  // afterEach hooks run, not during the page-fixture teardown — measured on
  // #1105, where a `goto` here still left `test-failed-1.png` showing the
  // canvas. Gating the navigation on the test having passed would therefore
  // protect nothing and only reintroduce the teardown 404 that #1023/#1103
  // exist to avoid.
  await page.goto("/").catch(() => {});
  // `page.request` carries only browser cookies and the flows API answers 401 to
  // those, so pass the bearer token explicitly.
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // `deleteFlow` throws on purpose so a failed cleanup stays visible; log it
    // rather than swallowing it, but don't fail an otherwise-green test on a
    // teardown blip.
    await deleteFlow(
      request,
      id,
      bearer ? { headers: { Authorization: bearer } } : undefined,
    ).catch((error: unknown) => {
      console.warn(
        `⚠️  cleanup: flow ${id} was NOT deleted — ${
          (error as Error)?.message?.split("\n")[0] ?? error
        }`,
      );
    });
  }
});

/**
 * Collects duplicated DOM ids among the form controls rendered **inside the
 * canvas**.
 *
 * Two deliberate scope decisions, both of which bound what this can prove:
 *
 * 1. **Canvas-scoped, not document-scoped.** The parameters side panel renders
 *    the same field with the SAME DOM id as the node body — `popover/index.tsx`
 *    applies `getNodeScopedDomId(id, nodeId)` unconditionally, and only the
 *    `data-testid` gets the `-edit` suffix in edit mode. A document-wide sweep
 *    would therefore report a duplicate whenever the panel is open for a
 *    selected node, which is not the LE-2037 defect. Scoping to the canvas also
 *    drops app-chrome and portal noise for free.
 * 2. **Form controls only** (`input` / `textarea` / `select`). That is what the
 *    reported DevTools warning ("Duplicate form field id in the same form")
 *    covers, what breaks autofill, and what upstream's own regression test
 *    sweeps. Icon SVGs legitimately repeat their internal ids (gradients, masks,
 *    filters) whenever the same icon renders twice, and must not fail this test
 *    for the wrong reason. The cost is real and stated in the spec doc: the
 *    renderers whose id lands on a `span`, `div` or Radix `button[role=switch]`
 *    (prompt, mustache-prompt, accordion-prompt, empty-parameter, toggle) are
 *    NOT covered by this sweep. The per-field assertions in each test cover the
 *    two paths this spec claims, regardless of element type.
 *
 * Returns entries like `popover-anchor-input-url_input x2` so a failure names the
 * offending ids instead of reporting a bare count mismatch. Throws if the canvas
 * root is missing, so a selector change surfaces as an error rather than as an
 * empty list that would pass for the wrong reason.
 */
async function collectDuplicateFormFieldIds(page: Page): Promise<string[]> {
  return page.evaluate((canvasRootId) => {
    const root = document.getElementById(canvasRootId);
    if (!root) {
      throw new Error(
        `canvas root #${canvasRootId} not found — the duplicate sweep would be vacuous`,
      );
    }
    const counts = new Map<string, number>();
    for (const element of Array.from(
      root.querySelectorAll("input[id], textarea[id], select[id]"),
    )) {
      counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([id, count]) => `${id} x${count}`)
      .sort();
  }, CANVAS_ROOT_ID);
}

/**
 * Asserts the field contract for one testid on a two-node canvas:
 * the testid resolves to both nodes, each element carries a DOM id, and the two
 * ids differ.
 *
 * The middle assertion is what keeps this test from passing vacuously.
 * `getNodeScopedDomId` returns `undefined` for an empty base id and React then
 * omits the attribute — so a refactor that stopped threading `id` into a
 * renderer would drop both elements out of the `[id]` sweep and leave it
 * reporting no duplicates, i.e. green for the wrong reason.
 */
async function expectFieldIdsUniquePerNode(
  page: Page,
  fieldTestId: string,
): Promise<void> {
  const ids = await page
    .getByTestId(fieldTestId)
    .evaluateAll((elements) => elements.map((element) => element.id));

  // `data-testid` stayed unscoped — the contract 132 call sites in this suite
  // depend on. Scoping it by node instead of the id would make this 1, not 2.
  expect(ids, `expected ${fieldTestId} on both nodes, got ${ids.length}`).toHaveLength(2);
  // Each field actually has an id to be unique about.
  expect(
    ids.filter(Boolean),
    `both ${fieldTestId} elements must carry a DOM id, got ${JSON.stringify(ids)}`,
  ).toHaveLength(2);
  // The defect itself: two nodes, two distinct ids.
  expect(
    new Set(ids).size,
    `the two ${fieldTestId} elements share a DOM id: ${JSON.stringify(ids)}`,
  ).toBe(2);
}

test.describe("Node parameter DOM ids — uniqueness across sibling nodes", () => {
  test("two API Request nodes expose the same field without duplicating its DOM id",
    { tag: ["@regression", "@components"] },
    async ({ page }) => {
      await test.step("Open a blank flow and add two API Request nodes", async () => {
        createdFlowIds.push(await setupBlankFlow(page));

        await addComponentFromSidebar(
          page,
          "API Request",
          "add-component-button-api-request",
        );
        // Gate on the first node rendering before adding the second: the sidebar
        // click is fire-and-forget, and asserting the count straight away can
        // observe 1 while the second is still mounting.
        await expect(page.getByTestId("title-API Request")).toBeVisible({
          timeout: 15000,
        });

        await addComponentFromSidebar(
          page,
          "API Request",
          "add-component-button-api-request",
        );
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 15000,
        });
      });

      await test.step("Both URL fields carry distinct DOM ids under one testid", async () => {
        await expectFieldIdsUniquePerNode(
          page,
          "popover-anchor-input-url_input",
        );
      });

      await test.step("No form control on the canvas shares a DOM id", async () => {
        const duplicates = await collectDuplicateFormFieldIds(page);
        expect(
          duplicates,
          `duplicate form field ids on a two-node API Request canvas: ${duplicates.join(", ")}`,
        ).toEqual([]);
      });
    },
  );

  test("two Agent nodes expose the same field without duplicating its DOM id",
    { tag: ["@regression", "@components", "@agents"] },
    async ({ page }) => {
      await test.step("Open a blank flow and drag two Agent nodes onto the canvas", async () => {
        createdFlowIds.push(await setupBlankFlow(page));

        // The Agent has no `add-component-button-agent` testid, so the drag from
        // the sidebar disclosure is the proven path (mirrors
        // `agent-component-regression.spec.ts`).
        await page.getByTestId("disclosure-models & agents").click();
        await page.getByTestId("models_and_agentsAgent").waitFor({
          state: "visible",
          timeout: 15000,
        });

        // Distinct drop positions so the two nodes do not stack. Irrelevant to
        // the DOM assertions — React Flow does not cull off-screen nodes
        // (`onlyRenderVisibleElements` is not used), so the fields are in the DOM
        // either way — but it keeps a failure trace readable.
        for (const targetPosition of [
          { x: 250, y: 200 },
          { x: 650, y: 200 },
        ]) {
          await page
            .getByTestId("models_and_agentsAgent")
            .dragTo(page.locator(`//*[@id="${CANVAS_ROOT_ID}"]`), {
              targetPosition,
            });
        }
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 15000,
        });
      });

      await test.step("Both Agent Instructions fields carry distinct DOM ids under one testid", async () => {
        await expectFieldIdsUniquePerNode(page, "textarea_str_system_prompt");
      });

      await test.step("No form control on the canvas shares a DOM id", async () => {
        const duplicates = await collectDuplicateFormFieldIds(page);
        expect(
          duplicates,
          `duplicate form field ids on a two-Agent canvas: ${duplicates.join(", ")}`,
        ).toEqual([]);
      });
    },
  );
});
