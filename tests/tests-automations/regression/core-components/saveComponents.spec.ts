import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";

// Ids of every flow created by a test — the blank host flow AND the saved
// component (itself an is_component flow) — deleted id-scoped in afterEach (repo
// convention, #490/#681). The saved component lives in a global, per-user
// namespace, so leaving it behind would pollute the instance; cleaning it is
// load-bearing.
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // deleteFlow treats a 404 as done (#545), so a double-delete is harmless.
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// The component to save and the display name Langflow gives its saved copy.
const COMPONENT_SEARCH = "chat input";
const COMPONENT_TITLE = "Chat Input";

// List the saved components (is_component flows).
async function listSavedComponents(
  request: APIRequestContext,
  bearer: string,
): Promise<Array<{ id: string; name: string; is_component: boolean }>> {
  const res = await request.get(
    "/api/v1/flows/?remove_example_flows=true&header_flows=true&components_only=true",
    { headers: { Authorization: bearer } },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as
    | Array<{ id: string; name: string; is_component: boolean }>
    | { flows?: Array<{ id: string; name: string; is_component: boolean }> };
  return Array.isArray(body) ? body : (body.flows ?? []);
}

// Pre-clean any saved "Chat Input"/"Chat Input (N)" left by a previous failed
// run. Saving a component whose name already exists does NOT replace it — the
// backend suffixes the name and opens a modal — which would break the clean
// diff-and-assert below. This spec is the only place that saves a "Chat Input"
// component (and it is a single, non-self-parallel test), so id-scoped deletion
// of that name family is a safe, deterministic precondition, not a global wipe.
async function cleanupSavedChatInputs(
  request: APIRequestContext,
  bearer: string,
): Promise<void> {
  const stale = (await listSavedComponents(request, bearer)).filter((f) =>
    f.name?.startsWith(COMPONENT_TITLE),
  );
  for (const f of stale) {
    await deleteFlow(request, f.id, { headers: { Authorization: bearer } });
  }
}

test.describe("save component tests", () => {
  test(
    "saving a canvas component as a template makes it reusable from the sidebar",
    { tag: ["@stable", "@regression", "@components", "@ui-ux"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      let savedBefore = new Set<string>();

      await test.step("Open a blank flow created via the API", async () => {
        // Deterministic precondition: remove any saved Chat Input left by a
        // previous failed run so this save creates a clean, unsuffixed one.
        await cleanupSavedChatInputs(request, bearer);

        const flowId = await createFlow(
          request,
          {
            name: `Save Component Host ${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            description: "",
            data: { nodes: [], edges: [] },
            is_component: false,
          },
          { headers: { Authorization: bearer } },
        );
        createdFlowIds.push(flowId);
        await page.goto(`/flow/${flowId}`);
        await page
          .getByTestId("sidebar-search-input")
          .waitFor({ state: "visible", timeout: 60000 });
      });

      await test.step("Add a Chat Input component to the canvas", async () => {
        // Baseline the saved-component set before we create ours, so the new one
        // can be identified by id-diff regardless of the (possibly suffixed) name.
        savedBefore = new Set(
          (await listSavedComponents(request, bearer)).map((f) => f.id),
        );

        await page.getByTestId("sidebar-search-input").fill("chat input");
        // Scope the add button to the official Input & Output entry: when a
        // saved component named "Chat Input" already exists (a prior/parallel
        // run), a homonymous `add-component-button-chat-input` also renders under
        // `saved_componentsChat Input`, so the bare testid is ambiguous. The
        // `input_outputChat Input` container disambiguates to the built-in one.
        await page
          .getByTestId("input_outputChat Input")
          .getByTestId("add-component-button-chat-input")
          .click();
        await adjustScreenView(page);
        await expect(page.getByTestId("title-Chat Input")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Save the selected component as a template", async () => {
        // Select the node, open its more-options menu, and Save (SaveAll).
        await page.getByTestId("title-Chat Input").click();
        await page.getByTestId("more-options-modal").click();
        await page.getByTestId("icon-SaveAll").first().click();
      });

      let savedComponent: { id: string; name: string; is_component: boolean };

      await test.step("The save persists a new is_component flow (the reusable template)", async () => {
        // Identify the flow this save created by id-diff against the baseline —
        // exactly one new saved component must appear. Capture its id for
        // id-scoped cleanup FIRST (before UI assertions) so a later failure still
        // tears it down. The durable backend signal is is_component=true.
        const created = (await listSavedComponents(request, bearer)).filter(
          (f) => !savedBefore.has(f.id),
        );
        expect(
          created.length,
          "exactly one new saved component should be created by the save",
        ).toBe(1);
        savedComponent = created[0];
        createdFlowIds.push(savedComponent.id);
        expect(savedComponent.is_component).toBe(true);
      });

      await test.step("The saved component appears in the sidebar Saved section", async () => {
        // The Saved disclosure plus the draggable saved item are the user-facing
        // reuse affordance. The draggable testid is derived from the saved
        // component's ACTUAL name (which may be suffixed), lowercased — matching
        // the `saved_components_<name>_draggable` shape confirmed live.
        await expect(page.getByTestId("disclosure-saved")).toBeVisible({
          timeout: 15000,
        });
        await expect(
          page.getByTestId(
            `saved_components_${savedComponent.name.toLowerCase()}_draggable`,
          ),
        ).toBeVisible({ timeout: 15000 });
      });
    },
  );
});
