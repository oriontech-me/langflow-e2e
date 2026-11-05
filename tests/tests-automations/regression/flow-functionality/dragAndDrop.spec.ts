import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";

// Importing flows by dropping a .json file on the home page's flow list —
// QA-CHECKLIST §10.1 "Upload flow by drag-and-drop to folder".
// Spec doc: docs/flow-functionality/dragAndDrop.md
//
// NOT the sidebar -> canvas component drag of §15.2 (that is
// ui-ux/sidebar-add-component.spec.ts) — the file name has caused that mix-up
// before.
//
// Both tests assert the import through the ids the drop's responses carry, plus
// id-anchored home cards. Anchoring by id matters: the home list sorts by
// `updated_at` DESC, so a positional or free-text match can resolve to a flow
// another parallel worker just touched.
//
// The responses depend on the version under test (#2399): up to 1.13 a drop is one
// `POST /api/v1/flows/` per flow, each answering the created flow; from
// 1.14.0.dev18 (langflow-ai/langflow#16120) it is ONE `POST /api/v1/flows/upload/`
// answering an array of every created flow. The shared tracker reads both, and the
// assertions count FLOWS, never responses — on 1.14 a 15-flow collection is one
// response.

const COLLECTION_FIXTURE = "tests/assets/flows/collection.json";
const SINGLE_FLOW_FIXTURE = "tests/assets/flows/flow_test_drag_and_drop.json";
// The placeholder name inside SINGLE_FLOW_FIXTURE, replaced per run so parallel
// workers never collide on the flow name.
const SINGLE_FLOW_PLACEHOLDER = "LANGFLOW TEST";
// The home dropzone.
const DROPZONE_TESTID = "cards-wrapper";

test.describe("flow import by file drop on the home page", () => {
  let token: string;
  // Every flow this page created -- the bootstrap's AND the drop's. This is the
  // one the cleanup reads, so no assertion ever depends on it. The bootstrap's
  // flows belong here (#1787): measured on 1.13.0.dev7 before they were tracked, a
  // green run left `New Flow` plus a second `Basic Prompting` behind, once per run.
  // A parallel worker's bootstrap creates a DIFFERENT id, so deleting by id can
  // never reach it.
  let flows: FlowTracker | undefined;
  // Only the flows the DROP created: attached after the bootstrap, so the
  // bootstrap's creates stay out of the import count -- the half of #1787's split
  // that was always load-bearing. Its ids are a subset of `flows`'s, so it is
  // disposed, never cleaned up (that would delete each flow twice).
  let imported: FlowTracker | undefined;

  test.beforeEach(async ({ page, request }) => {
    flows = undefined;
    imported = undefined;
    token = await getAuthToken(request);

    // Installed BEFORE the bootstrap so its own creates are captured for cleanup.
    flows = trackCreatedFlows(page);

    // Home page with the flow list rendered. skipModal: the templates modal is
    // not part of this journey, and opening a template would create an extra
    // flow this spec would then have to clean up.
    await awaitBootstrapTest(page, { skipModal: true });
    await expect(page.getByTestId(DROPZONE_TESTID)).toBeVisible({
      timeout: 30000,
    });

    // Bootstrap is over: from here every created flow belongs to the drop.
    imported = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    imported?.dispose();
    // Id-scoped, never a global sweep: under fullyParallel, deleting anything
    // this page did not create would wipe a concurrent worker's flow. `strict`
    // keeps what the hand-rolled loop did before #2399 -- a failed delete fails
    // the teardown -- but only after every captured id has been attempted.
    await flows?.cleanup(request, { strict: true });
  });

  test("dropping a collection file imports every flow it contains",
    { tag: ["@stable", "@release", "@workspace", "@mainpage"] },
    async ({ page, request }) => {
      // Read the expected count from the asset itself, so adding a flow to the
      // fixture updates the expectation instead of reddening the test.
      const collection = JSON.parse(readFileSync(COLLECTION_FIXTURE, "utf-8")) as {
        flows: Array<{ name?: string }>;
      };
      const expectedCount = collection.flows.length;
      expect(expectedCount).toBeGreaterThan(1);

      await test.step("drop the collection file on the flow list", async () => {
        await simulateDragAndDrop(page, COLLECTION_FIXTURE, DROPZONE_TESTID);
      });

      let importedIds: string[] = [];

      await test.step(`${expectedCount} flows are created`, async () => {
        // The number of FLOWS, never of responses: on 1.14 the whole collection is
        // one `POST /api/v1/flows/upload/`, on 1.13 it is 15 `POST /api/v1/flows/`.
        await expect
          .poll(
            async () => {
              await imported!.settle();
              return imported!.ids().length;
            },
            { timeout: 120000, message: "flows the collection drop created" },
          )
          .toBe(expectedCount);
        importedIds = imported!.ids();
      });

      await test.step("every imported flow exists on the server", async () => {
        await assertFlowsExist(request, token, importedIds);
      });

      await test.step("the imported flows show up on the home list", async () => {
        // The list is paginated, so only membership is asserted — at least one
        // of the just-imported ids must render its own card.
        await expect
          .poll(
            async () => {
              const visible = await Promise.all(
                importedIds.map((id) =>
                  page
                    .getByTestId(`flow-name-${id}`)
                    .isVisible()
                    .catch(() => false),
                ),
              );
              return visible.some(Boolean);
            },
            { timeout: 30000 },
          )
          .toBe(true);
      });
    });

  test("dropping a single flow file imports that flow",
    { tag: ["@stable", "@release", "@workspace", "@mainpage"] },
    async ({ page, request }) => {
      const uniqueName = `dnd-flow-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      const payload = readFileSync(SINGLE_FLOW_FIXTURE, "utf-8").replace(
        SINGLE_FLOW_PLACEHOLDER,
        uniqueName,
      );
      expect(payload).toContain(uniqueName);

      await test.step("drop the flow file on the flow list", async () => {
        await simulateDragAndDrop(
          page,
          SINGLE_FLOW_FIXTURE,
          DROPZONE_TESTID,
          payload,
        );
      });

      let importedIds: string[] = [];

      await test.step("exactly one flow is created", async () => {
        await expect
          .poll(
            async () => {
              await imported!.settle();
              return imported!.ids().length;
            },
            { timeout: 120000, message: "flows the single-file drop created" },
          )
          .toBe(1);
        importedIds = imported!.ids();
        await assertFlowsExist(request, token, importedIds);
      });

      await test.step("its card is on the home list under the dropped name", async () => {
        const card = page
          .getByTestId("list-card")
          .filter({ has: page.getByTestId(`flow-name-${importedIds[0]}`) });
        await expect(card).toBeVisible({ timeout: 30000 });
        await expect(card).toContainText(uniqueName);

        // The card text is a substring match, so a suffixed name would slip
        // through it — assert the stored name is EXACTLY the dropped one.
        const res = await request.get(`/api/v1/flows/${importedIds[0]}`, {
          headers: { Authorization: token },
        });
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { name?: string }).name).toBe(uniqueName);
      });
    });
});

/** Fails unless every id is readable through the flows API. */
async function assertFlowsExist(
  request: APIRequestContext,
  token: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    const res = await request.get(`/api/v1/flows/${id}`, {
      headers: { Authorization: token },
    });
    expect(res.status(), `imported flow ${id} is not readable`).toBe(200);
  }
}
