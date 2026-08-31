/**
 * Human Input node configuration — branch handles derived from `User Choices`.
 *
 * Covers the configuration surface of the HITL node shipped in Langflow 1.11.0
 * (upstream #13633 / LE-1449): its branch outputs come from the `decisions`
 * field, one handle per choice, and that derivation must hold when the node is
 * added, when a choice is added live, and after a save + reload.
 *
 * Sibling coverage — do not duplicate here:
 * - Running the flow (pause, decision card, exclusive branch routing) belongs to
 *   `core-functionality/playground/human-input-pause-resume.spec.ts` (issue #1189).
 * - Removing/renaming a choice, the duplicate-choice guard and `Enable Fallback`
 *   are listed as out of scope in the spec doc.
 *
 * Two of the four tests are LE-2278 guards. That defect let the on-mount
 * `decisions` refresh response revert a choice the user had just committed —
 * chips back to [Approve, Reject] while the node kept the third branch handle —
 * and it is fixed upstream in langflow-ai/langflow#14741 (first nightly
 * carrying it: 1.12.0.dev39). The live-rebuild test re-reads the chip once the
 * refresh traffic goes quiet, which catches the revert only when the response
 * actually lags; the stale-refresh test holds that response on purpose, so the
 * guard fires on every run and on any machine.
 *
 * Spec doc: `docs/core-components/human-input-node-config.md`. No provider
 * credentials are needed — nothing here runs the flow.
 */

import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  COMPONENT_REFRESH_PATH,
  watchNodeRefresh,
} from "../../../helpers/ui/watch-node-refresh";

// Sidebar search term + add button for the component under test, kept together
// so a testid can't drift from the term that filters it into view.
const HUMAN_INPUT = {
  searchTerm: "Human Input",
  addButton: "add-component-button-human-input",
  title: "title-Human Input",
};

// A deliberately TWO-WORD custom choice: the backend slugifies it into the
// output name (`_action_id`: lowercase, spaces → underscores) while the frontend
// builds the handle testid from the display name. A one-word label would pass
// even if one of the two sides dropped its normalisation.
const CUSTOM_CHOICE = "Request Changes";
const CUSTOM_CHOICE_OUTPUT = "branch_request_changes";

// Branch handles, in the order the node renders them. `CUSTOM_HANDLE` is spelled
// out rather than derived from `CUSTOM_CHOICE.toLowerCase()` on purpose: the
// frontend lowercases the display name to build the testid, and deriving it the
// same way would make the assertion agree with itself no matter what the app did.
const APPROVE_HANDLE = "handle-humaninput-shownode-approve-right";
const REJECT_HANDLE = "handle-humaninput-shownode-reject-right";
const CUSTOM_HANDLE = "handle-humaninput-shownode-request changes-right";

// Output names the persisted flow must carry once the custom choice is added.
const PERSISTED_OUTPUTS = ["branch_approve", "branch_reject", CUSTOM_CHOICE_OUTPUT];

/** The Human Input node on the canvas. */
const humanInputNode = (page: Page): Locator =>
  page.locator('.react-flow__node:has([data-testid="title-Human Input"])');

/**
 * Every branch (output) handle of the Human Input node.
 *
 * `handle-` and not `div-handle-`: each handle renders both, and only the
 * prefixed form is the interactive element. `-right` excludes the node's single
 * input handle (`…-input-left`). Counting these is what makes an unexpected
 * extra or missing branch fail, instead of only asserting the ones we expect.
 */
const branchHandles = (page: Page): Locator =>
  humanInputNode(page).locator(
    '[data-testid^="handle-humaninput-shownode-"][data-testid$="-right"]',
  );

/**
 * Every `User Choices` chip on the node.
 *
 * Counted alongside `branchHandles` because the LE-2278 signature is the two
 * DISAGREEING — two chips against three handles — which neither count alone can
 * see. Asserting only the handles is what let the reverted state look healthy
 * from the canvas.
 */
const choiceChips = (page: Page): Locator =>
  humanInputNode(page).locator('[data-testid^="action-edit-"]');

/** Add the Human Input node via the sidebar and confirm it landed. */
async function addHumanInputNode(page: Page) {
  await addComponentFromSidebar(
    page,
    HUMAN_INPUT.searchTerm,
    HUMAN_INPUT.addButton,
  );
  await expect(page.getByTestId(HUMAN_INPUT.title)).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
}

/**
 * Add a custom entry to `User Choices`.
 *
 * The `+` reveals an inline input that commits on `Enter` (or blur) — see
 * `actionPickerComponent`. The input is asserted visible first: typing into the
 * canvas without confirmed focus lands as a hotkey.
 */
async function addCustomChoice(page: Page, label: string) {
  await page.getByTestId("actionpicker-add-decisions").click();
  const input = page.getByTestId("action-add-input");
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(label);
  await input.press("Enter");
}

/**
 * Poll the flows API until the persisted Human Input node carries `expected` as
 * its output names.
 *
 * Server truth rather than `waitForFlowSaveSettled`: that helper resolves on
 * network silence, which also happens when the debounced PATCH has not fired yet
 * (#518). Returns nothing — the assertion IS the poll.
 */
async function expectPersistedOutputs(
  page: Page,
  flowId: string,
  expected: string[],
) {
  // `getAuthToken` resolves to "" on an environment without auth (it throws only
  // when the backend never answers), and an empty `Authorization` header is not
  // the same as no header — it would override the browser context's own auth and
  // turn this poll into a 401 loop that reports as "the outputs never persisted".
  // Same guard the repo's own helpers use (`setup-blank-flow.ts`).
  const authToken = await getAuthToken(page.request);
  const authOptions = authToken
    ? { headers: { Authorization: authToken } }
    : undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/v1/flows/${flowId}`,
          authOptions,
        );
        if (!res.ok()) return `GET /api/v1/flows/${flowId} → ${res.status()}`;
        const body = await res.json();
        const node = (body?.data?.nodes ?? []).find(
          (n: { data?: { type?: string } }) => n?.data?.type === "HumanInput",
        );
        if (!node) return "no HumanInput node in the persisted flow";
        return (node.data?.node?.outputs ?? []).map(
          (o: { name: string }) => o.name,
        );
      },
      { timeout: 30000, intervals: [500, 1000, 2000] },
    )
    .toEqual(expected);
}

test.describe("Human Input node configuration (HITL branch handles)", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // Creates the flow via API (avoids the UI-creation 500 race) and returns its
    // id so afterEach can delete exactly that one.
    createdFlowId = await setupBlankFlow(page);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Leave the editor first: an editor left mounted over a deleted flow 404s
      // its `GET /flows/{id}/events` poll, which the fixture logs as a backend
      // error.
      //
      // Warned about and carried on from, never rethrown and never swallowed — the
      // helper owns that decision and its message (#1288). Rethrowing here would
      // abort this hook before the delete below and leak the flow, which is worse
      // than the noise the navigation prevents.
      await unmountEditorForCleanup(page, "/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("Human Input renders the default Approve and Reject branch handles when added to the canvas",
    { tag: ["@stable", "@components", "@ui-ux"] },
    async ({ page }) => {
      await test.step("Add a Human Input node to the canvas", async () => {
        await addHumanInputNode(page);
      });

      await test.step("The default User Choices are Approve and Reject", async () => {
        await expect(page.getByTestId("action-edit-Approve")).toBeVisible();
        await expect(page.getByTestId("action-edit-Reject")).toBeVisible();
      });

      await test.step("Each default choice renders its own branch handle, and there are no others", async () => {
        await expect(page.getByTestId(APPROVE_HANDLE)).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId(REJECT_HANDLE)).toBeVisible();
        // Exactly two: `group_outputs` gives every branch its own handle, so a
        // third one here would mean the node derived a branch we never asked for.
        await expect(branchHandles(page)).toHaveCount(2);
      });
    },
  );

  // `@regression` was added here with the quarantine lift (#1547): this test
  // caught LE-2278, so it now guards a previously fixed bug. The quarantine it
  // carried (daily #1544 — `action-edit-<name>` never entering the DOM, same
  // signature on the 2026-08-13 and 08-21 dailies) was the defect, not the wait.
  test("adding a custom User Action creates its branch handle without a reload",
    { tag: ["@stable", "@regression", "@components", "@ui-ux"] },
    async ({ page }) => {
      // Attached BEFORE the node lands, so the on-mount refresh for `decisions`
      // is inside the watched window — that is the request whose late response
      // reverted the commit under LE-2278, and a watcher started afterwards
      // cannot see it (`watchNodeRefresh`'s own rationale).
      const refresh = watchNodeRefresh(page);
      try {
        await test.step("Add a Human Input node with its two default branches", async () => {
          await addHumanInputNode(page);
          await expect(branchHandles(page)).toHaveCount(2);
        });

        await test.step(`Add "${CUSTOM_CHOICE}" to User Choices`, async () => {
          await addCustomChoice(page, CUSTOM_CHOICE);
          await expect(
            page.getByTestId(`action-edit-${CUSTOM_CHOICE}`),
          ).toBeVisible({ timeout: 15000 });
        });

        await test.step("Its branch handle appears on the same page, with the defaults intact", async () => {
          // No reload and no navigation between the commit above and this
          // assertion: the node rebuilds its outputs live, through the
          // `real_time_refresh` round trip on `decisions`.
          await expect(page.getByTestId(CUSTOM_HANDLE)).toBeVisible({
            timeout: 15000,
          });
          await expect(page.getByTestId(APPROVE_HANDLE)).toBeVisible();
          await expect(page.getByTestId(REJECT_HANDLE)).toBeVisible();
          await expect(branchHandles(page)).toHaveCount(3);
        });

        await test.step("The choice is still there once the refresh traffic goes quiet", async () => {
          // The assertions above are point-in-time, and under LE-2278 the chip
          // rendered from local state before a late on-mount response removed
          // it — so they are satisfied by a value that is about to be reverted.
          // Re-reading after the refresh has settled is what sees the revert;
          // the revert is permanent, so one clean read is enough. The re-read is
          // the assertion — `untilQuiet()` alone would only be a wait.
          await refresh.untilQuiet();
          await expect(
            page.getByTestId(`action-edit-${CUSTOM_CHOICE}`),
          ).toBeVisible();
          await expect(choiceChips(page)).toHaveCount(3);
          await expect(branchHandles(page)).toHaveCount(3);
        });
      } finally {
        // No-op after `untilQuiet()` settled; it matters on the abort path, where
        // the listeners would otherwise outlive the test.
        refresh.dispose();
      }
    },
  );

  // QUARANTINED for #1644 — the stale-response park never engages, so this guard asserts on an unmeasured run
  // (daily 2026-08-31, run 33410643882; guard tripped, so the workflow removed nothing).
  test.fixme("a stale refresh response does not revert a committed User Action",
    { tag: ["@regression", "@components", "@ui-ux"] },
    async ({ page }) => {
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let claimed = false;
      let parked = false;

      try {
        await test.step("Hold the on-mount `decisions` refresh response", async () => {
          // Claims the FIRST refresh carrying a two-entry `decisions` value —
          // the on-mount one, measured on 1.12.0.dev39 as firing ~230 ms after
          // the node lands with `["Approve", "Reject"]`. Discriminating on the
          // VALUE and not on arrival order means a build that fires an extra
          // refresh cannot silently shift which response is held.
          //
          // `route.fetch()` runs BEFORE the park, not at release time: parking
          // the route and fetching on release makes the response arrive after
          // the window has already closed, which degrades this test into the
          // aborted-response control where the add always sticks (measured —
          // the first version of this released nothing and still passed).
          await page.route(`**${COMPONENT_REFRESH_PATH}`, async (route: Route) => {
            const body = route.request().postDataJSON();
            const isOnMount =
              !claimed &&
              body?.field === "decisions" &&
              Array.isArray(body?.field_value) &&
              body.field_value.length === 2;
            if (!isOnMount) {
              await route.continue();
              return;
            }
            claimed = true;
            const response = await route.fetch();
            parked = true;
            await gate;
            await route.fulfill({ response });
          });
        });

        await test.step("Add the node and confirm its on-mount refresh is parked", async () => {
          await addHumanInputNode(page);
          await expect(branchHandles(page)).toHaveCount(2);
          await expect
            .poll(() => parked, { timeout: 20000, intervals: [100] })
            .toBe(true);
        });

        await test.step(`Commit "${CUSTOM_CHOICE}", then release the stale response into the window`, async () => {
          await addCustomChoice(page, CUSTOM_CHOICE);
          // 150 ms is measured, not guessed: the commit's own refresh leaves
          // ~300 ms after the Enter (debounce), and its response applies later
          // still, so releasing here lands the stale response strictly BETWEEN
          // the commit and that response — the one delivery of the four that
          // reverts. A slower box widens that window rather than narrowing it.
          await page.waitForTimeout(150);
          openGate();
        });

        await test.step("The committed choice survived, and chips agree with handles", async () => {
          await expect(
            page.getByTestId(`action-edit-${CUSTOM_CHOICE}`),
          ).toBeVisible({ timeout: 15000 });
          // Under LE-2278 this read `2` chips against `3` handles — the mixed
          // state the daily screenshotted. Both counts are asserted because
          // either one alone reads as healthy.
          await expect(choiceChips(page)).toHaveCount(3);
          await expect(branchHandles(page)).toHaveCount(3);
        });
      } finally {
        // Opening the gate unconditionally keeps a failure before the release
        // from leaving a route handler awaiting a promise nobody resolves, and
        // the unroute keeps a refresh fired during the cleanup navigation from
        // being held by it.
        openGate();
        await page.unroute(`**${COMPONENT_REFRESH_PATH}`);
      }
    },
  );

  test("the configured branch handles persist after save and reload",
    { tag: ["@stable", "@components", "@database", "@ui-ux"] },
    async ({ page }) => {
      const flowId = createdFlowId as string;

      await test.step(`Add a Human Input node and a "${CUSTOM_CHOICE}" choice`, async () => {
        await addHumanInputNode(page);
        await addCustomChoice(page, CUSTOM_CHOICE);
        await expect(page.getByTestId(CUSTOM_HANDLE)).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("The persisted flow carries one branch output per choice", async () => {
        // Also the assertion that the label survived the round trip as a slug:
        // "Request Changes" → `branch_request_changes`.
        await expectPersistedOutputs(page, flowId, PERSISTED_OUTPUTS);
      });

      await test.step("A full page reload rebuilds all three choices and handles", async () => {
        // No `page.on("dialog")` handler anywhere in this spec, on purpose:
        // `FlowPage` installs a `beforeunload` that `preventDefault()`s while the
        // store is dirty, and Playwright ACCEPTS a beforeunload dialog only while
        // no handler is registered — one here would cancel this reload
        // (see `helpers/flows/leave-flow-editor.ts`).
        //
        // The sentinel is what makes the reload load-bearing rather than
        // decorative: every assertion below is ALSO satisfied by the pre-reload
        // DOM, so a navigation that silently did not happen would pass all of
        // them (reproduced in review by dismissing that dialog). A `window`
        // property cannot survive a document load, so its absence is proof the
        // page really reloaded — without it this step asserts nothing about
        // rehydration.
        await page.evaluate(() => {
          (window as Window & { __reloadSentinel?: true }).__reloadSentinel =
            true;
        });

        await page.reload();

        expect(
          await page.evaluate(
            () =>
              (window as Window & { __reloadSentinel?: true }).__reloadSentinel,
          ),
        ).toBeUndefined();

        await expect(page.getByTestId(HUMAN_INPUT.title)).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByTestId("action-edit-Approve")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("action-edit-Reject")).toBeVisible();
        await expect(
          page.getByTestId(`action-edit-${CUSTOM_CHOICE}`),
        ).toBeVisible();

        await expect(page.getByTestId(APPROVE_HANDLE)).toBeVisible();
        await expect(page.getByTestId(REJECT_HANDLE)).toBeVisible();
        await expect(page.getByTestId(CUSTOM_HANDLE)).toBeVisible();
        await expect(branchHandles(page)).toHaveCount(3);
      });
    },
  );
});
