import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
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
// Both tests assert the import through the `POST /api/v1/flows/` 201 responses
// the drop fires (one per imported flow, which is also how the imported ids are
// collected for cleanup) plus id-anchored home cards. Anchoring by id matters:
// the home list sorts by `updated_at` DESC, so a positional or free-text match
// can resolve to a flow another parallel worker just touched.

const COLLECTION_FIXTURE = "tests/assets/flows/collection.json";
const SINGLE_FLOW_FIXTURE = "tests/assets/flows/flow_test_drag_and_drop.json";
// The placeholder name inside SINGLE_FLOW_FIXTURE, replaced per run so parallel
// workers never collide on the flow name.
const SINGLE_FLOW_PLACEHOLDER = "LANGFLOW TEST";
// The home dropzone.
const DROPZONE_TESTID = "cards-wrapper";

test.describe("flow import by file drop on the home page", () => {
  let token: string;
  // Every flow the drop created, collected from the create responses.
  let importedIds: string[];

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    importedIds = [];

    // Home page with the flow list rendered. skipModal: the templates modal is
    // not part of this journey, and opening a template would create an extra
    // flow this spec would then have to clean up.
    await awaitBootstrapTest(page, { skipModal: true });
    await expect(page.getByTestId(DROPZONE_TESTID)).toBeVisible({
      timeout: 30000,
    });

    // Listener installed only AFTER the bootstrap: on a freshly empty instance
    // awaitBootstrapTest itself creates a flow (shared bootstrap state, not ours
    // to delete), and counting those 201s would both break the expected import
    // count and make the cleanup delete another test's precondition.
    page.on("response", (res) => {
      if (
        res.request().method() === "POST" &&
        res.url().includes("/api/v1/flows/") &&
        res.status() === 201
      ) {
        res
          .json()
          .then((body: { id?: string }) => {
            if (body?.id) importedIds.push(body.id);
          })
          .catch(() => {
            /* a non-JSON 201 cannot carry an id to clean up */
          });
      }
    });
  });

  test.afterEach(async ({ request }) => {
    for (const id of importedIds) {
      await deleteFlow(request, id, { headers: { Authorization: token } });
    }
  });

  test("dropping a collection file imports every flow it contains",
    { tag: ["@release", "@workspace", "@mainpage"] },
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

      await test.step(`${expectedCount} flows are created`, async () => {
        await expect
          .poll(() => importedIds.length, { timeout: 120000 })
          .toBe(expectedCount);
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
    { tag: ["@release", "@workspace", "@mainpage"] },
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

      await test.step("exactly one flow is created", async () => {
        await expect.poll(() => importedIds.length, { timeout: 120000 }).toBe(1);
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
