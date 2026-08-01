import { expect, test } from "../../../../fixtures/fixtures";
import { renameFlow } from "../../../../helpers/flows/rename-flow";
import { createFlowFromStarter } from "../../../../helpers/flows/create-flow-from-starter";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { leaveFlowEditor } from "../../../../helpers/flows/leave-flow-editor";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Id of the flow this file creates, so afterEach deletes exactly it — id-scoped,
// never a name or wipe sweep, which would kill flows other parallel workers are
// driving (#553). The shared `trackCreatedFlows` helper is deliberately NOT used
// here: it captures ids from page-level `POST /api/v1/flows` → 201 responses, and
// `createFlowFromStarter` creates through `page.request`, which emits no
// page-level response events at all — that tracker would collect nothing and leak
// the flow (the #1147 lesson).
const createdFlowIds: string[] = [];

// Entry, onboarding suppression and the write-permission gate all live in the
// shared helper (#1214) — this file's local copy was the third, and the three had
// already diverged on the canvas deadline, the overlay handling and the gate.
test.afterEach(async ({ page, request }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the canvas BEFORE deleting. The editor keeps refetching the flow it has
  // open, so deleting it out from under an open editor turns those refetches into
  // `404 GET /api/v1/flows/{id}` on the run's backend-error log — advisory noise
  // that makes the log less trustworthy for everyone reading it (#1084). This is
  // the same reason `trackCreatedFlows.cleanup` navigates first (#1108).
  // Playwright captures the failure screenshot before `afterEach` runs, so this
  // navigation cannot destroy the artefact of a failing test.
  await page.goto("/").catch(() => {});
  // Explicit bearer: under AUTO_LOGIN a bare request context is unauthenticated,
  // so an unheadered DELETE 401s and silently leaks the flow.
  const bearer = await getAuthToken(request);
  for (const id of ids) {
    // Deliberately NOT wrapped in a `.catch()`: `deleteFlow` throws on a failed
    // delete, which fails the teardown — the contract this file had before the
    // migration off `trackCreatedFlows` (whose `cleanup` needed `{ strict: true }`
    // for the same effect). Swallowing it would trade a red for a warning line
    // nothing asserts on, and this spec re-runs a flow it must own exclusively.
    await deleteFlow(request, id, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
  }
});

test(
  "user should be able to edit flow name and see it reflected in the main page listing",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    // Copy the Basic Prompting starter graph into a flow of this worker's own,
    // over the API. The templates-modal path this replaces ("New Flow" → welcome
    // overlay → Browse more → click the shared card) creates a blank placeholder
    // flow first and then navigates to a SECOND one, and nothing downstream waited
    // for that hop — so the rename helper would drive the placeholder, behind the
    // welcome overlay, mid-navigation (#1005). Keeping the real starter graph is
    // deliberate: it is what exposes the mount autosave the #995 clobber rides on.
    const flowId = await createFlowFromStarter(
      page.request,
      "Basic Prompting",
      `edit-flow-name ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    createdFlowIds.push(flowId);
    await openFlowById(page, flowId);

    const names = [
      Math.random().toString(36).substring(2, 15),
      Math.random().toString(36).substring(2, 15),
    ];

    for (const targetName of names) {
      await renameFlow(page, { flowName: targetName });

      const { flowName } = await renameFlow(page);
      expect(flowName).toBe(targetName);

      // Through the helper, never a bare chevron click: with a diverged store the
      // exit trips `useBlocker` and `SaveChangesModal`, which in autosave mode
      // renders no confirm and no cancel and can spin indefinitely — the fourth
      // signature of #1005's burst (2 in 24 runs at `--workers=4`), where it read
      // as an unattributed `home-dropdown-menu` timeout (#1153).
      //
      // `escapeDeadlock` is safe here: the rename's PERSISTENCE is asserted after
      // this line, against the server (the home listing is a `GET /api/v1/flows/`
      // refetch), and the next iteration re-enters by id — so a reload discards
      // nothing this test relies on, and a rename that never landed still fails
      // on the count assertion below rather than being masked.
      await leaveFlowEditor(page, { escapeDeadlock: true });

      // Auto-waits for the renamed flow to appear (home refetch + render).
      // Web-first assertion instead of a fixed 3s waitForSelector, which raced
      // the flow-list API refetch under parallel load (flaky, see issue #410).
      //
      // Scoped to a LISTING CARD, not `getByText(targetName)` over the whole page:
      // the flow header renders the same name, so the unscoped count was satisfied
      // from inside the editor and never proved the claim in this test's title.
      // Measured — commenting the exit out above left the unscoped assertion
      // passing, i.e. the only thing forcing the navigation was the home marker
      // inside `leaveFlowEditor`. A read, never a click: the `/flows` a11y refactor
      // (Langflow #13891) makes the card content `pointer-events-none`, which
      // affects hit-testing, not visibility.
      await expect(
        page.getByTestId("list-card").filter({
          has: page.getByTestId("flow-name-div").filter({ hasText: targetName }),
        }),
      ).toHaveCount(1, { timeout: 30000 });

      // Re-open the SAME flow so the next iteration starts inside the editor,
      // addressed by id rather than by a name-filtered card click (#1005).
      await openFlowById(page, flowId);
    }
  },
);
