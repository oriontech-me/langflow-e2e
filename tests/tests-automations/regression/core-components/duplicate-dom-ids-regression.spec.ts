import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";

/**
 * LE-2037 / langflow#14096, fixed by langflow#14312: node parameter fields
 * derived their DOM id from the template type/name alone, so two nodes exposing
 * a field with the same name rendered duplicate ids — a WCAG 4.1.1 violation
 * that also breaks browser autofill. The fix scopes the DOM id by nodeId
 * (`<id>-<nodeId>`) and deliberately leaves `data-testid` unscoped, which is
 * what this suite selects on. Both halves are asserted here: uniqueness of the
 * `id`, and stability of the `data-testid`.
 *
 * The second half is the load-bearing one for this repository. 132 call sites
 * across 45 specs select node fields by `data-testid`; if uniqueness were ever
 * "fixed" by scoping the testid instead, this spec fails first and names the
 * cause, instead of 45 files failing at once for no obvious reason.
 *
 * Sibling specs place two identical nodes but assert only node counts, so none
 * of them covers this: `ui-ux/langflowShortcuts.spec.ts` (duplication via
 * shortcuts, deliberately using a node with no text field) and
 * `flow-functionality/canvas-copy-paste.spec.ts` (paste of a second Prompt
 * Template). `core-components/chat-input-output-component-regression.spec.ts`
 * actually hit this ambiguity and worked around it with a node-scoped filter.
 */

// Each test creates a flow that autosaves to the backend. Serial mode prevents
// parallel autosave races within this file.
test.describe.configure({ mode: "serial" });

// Ids of the flows each test created, deleted id-scoped in afterEach (repo
// convention #490/#681) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively driving (#553).
const createdFlowIds: string[] = [];

test.afterEach(async ({ page, request }, testInfo) => {
  if (createdFlowIds.length === 0) return;
  // Leave the editor so the unmounted flow page stops polling a flow we are
  // about to delete (a mid-poll delete 404s, which the fixture logs).
  //
  // On success only: Playwright captures the on-failure screenshot while tearing
  // down the page fixture, which runs AFTER this hook, so navigating away on a
  // failing test would archive a picture of the home page instead of the canvas
  // whose ids collided.
  if (testInfo.status === testInfo.expectedStatus) {
    await page.goto("/").catch(() => {});
  }
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
 * Collects duplicated DOM ids among form controls only.
 *
 * Scoped to `input` / `textarea` / `select` on purpose: that is what the reported
 * DevTools warning ("Duplicate form field id in the same form") covers and what
 * breaks autofill. Icon SVGs legitimately repeat their own internal ids
 * (gradients, masks, filters) whenever the same icon renders twice — a separate
 * concern that must not fail this test for the wrong reason.
 *
 * Returns entries like `popover-anchor-input-url_input x2` so a failure names the
 * offending ids instead of reporting a bare count mismatch.
 */
async function collectDuplicateFormFieldIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const counts = new Map<string, number>();
    for (const element of Array.from(
      document.querySelectorAll("input[id], textarea[id], select[id]"),
    )) {
      counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([id, count]) => `${id} x${count}`)
      .sort();
  });
}

test.describe("Node parameter DOM ids — uniqueness across sibling nodes", () => {
  test("two API Request nodes expose the same field without duplicating its DOM id",
    { tag: ["@stable", "@release", "@regression", "@components"] },
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
        await adjustScreenView(page, { numberOfZoomOut: 2 });
      });

      await test.step("Both URL fields are mounted, proving data-testid stayed unscoped", async () => {
        // Two purposes. It gates the sweep below — a half-mounted canvas would
        // pass it vacuously — and it is itself the test-id stability assertion:
        // count 2 is only possible while `data-testid` is NOT node-scoped, which
        // is the contract 132 call sites in this suite depend on.
        await expect(
          page.getByTestId("popover-anchor-input-url_input"),
        ).toHaveCount(2, { timeout: 15000 });
      });

      await test.step("No form control shares a DOM id", async () => {
        const duplicates = await collectDuplicateFormFieldIds(page);
        expect(
          duplicates,
          `duplicate form field ids on a two-node API Request canvas: ${duplicates.join(", ")}`,
        ).toEqual([]);
      });
    },
  );

  test("two Agent nodes expose the same field without duplicating its DOM id",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
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
        // the DOM assertion — the sweep reads the DOM, not layout — but it keeps
        // a failure trace readable.
        for (const targetPosition of [
          { x: 250, y: 200 },
          { x: 650, y: 200 },
        ]) {
          await page
            .getByTestId("models_and_agentsAgent")
            .dragTo(page.locator('//*[@id="react-flow-id"]'), {
              targetPosition,
            });
        }
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 15000,
        });
        await adjustScreenView(page, { numberOfZoomOut: 2 });
      });

      await test.step("Both Agent Instructions fields are mounted, proving data-testid stayed unscoped", async () => {
        await expect(
          page.getByTestId("textarea_str_system_prompt"),
        ).toHaveCount(2, { timeout: 15000 });
      });

      await test.step("No form control shares a DOM id", async () => {
        const duplicates = await collectDuplicateFormFieldIds(page);
        expect(
          duplicates,
          `duplicate form field ids on a two-Agent canvas: ${duplicates.join(", ")}`,
        ).toEqual([]);
      });
    },
  );
});
