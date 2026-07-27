import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Component sidebar search + category filtering — QA-CHECKLIST §15.1
// "Search component by name" and "Filter components by category".
// Spec doc: docs/ui-ux/sidebar-search-and-filter.md
//
// Replaces ui-ux/sidebar-category-filter.spec.ts,
// ui-ux/sidebar-filter-by-category.spec.ts and
// ui-ux/sidebar-provider-count.spec.ts (12 tests that asserted only "the match
// is visible", hid their one real assertion behind an `if (data-state !== null)`
// guard that never fires on 1.12, or promised a provider count nothing in the
// product renders). Every test here carries the NEGATIVE half — the component
// that must disappear — because a search box that filters nothing passes a
// visibility-only check.
//
// Two §15.1 bullets have no product surface on 1.12.0.dev6 and are deliberately
// NOT covered here (recorded as `[~]` in QA-CHECKLIST with this evidence):
// hovering a card renders no tooltip/preview at all (only the `+` button, whose
// hover reveal is already @stable in core-components/componentHoverAdd.spec.ts),
// and the sidebar renders no provider count anywhere — grouping by provider
// bundle, which test 3 covers, is what exists instead.

// A component that matches the "chat input" query, and one that must NOT.
const MATCHING_CARD = "input_outputChat Input";
const NON_MATCHING_CARD = "models_and_agentsPrompt Template";
// The always-present base category, and one component card inside it.
const BASE_DISCLOSURE = "disclosure-input & output";
const BASE_DISCLOSURE_CHILD = "input_output_chat input_draggable";
// Provider search targets.
const PROVIDER_QUERY = "openai";
const PROVIDER_CARD = "openaiOpenAI";
const PROVIDER_BUNDLE = "disclosure-bundles-openai";
// A query no component can match.
const NO_MATCH_QUERY = "zzz_no_such_component";
const EMPTY_STATE_TEXT = "No components found.";

test.describe("ui-ux — component sidebar search and category filter", () => {
  let token: string;
  let flowId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    flowId = await createFlow(
      request,
      {
        name: `sidebar-search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        description: "Empty canvas for the §15.1 sidebar search/filter tests",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: { Authorization: token } },
    );

    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("shad-sidebar")).toBeVisible();
  });

  test.afterEach(async ({ page, request }) => {
    // Unmount the editor before deleting: it polls GET /flows/{id}/events.
    await page.goto("/").catch(() => {});
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test("searching by name lists the matching component and hides the others",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const search = page.getByTestId("sidebar-search-input");

      await test.step("a lowercase query filters the tree", async () => {
        await search.fill("chat input");

        await expect(page.getByTestId(MATCHING_CARD)).toBeVisible({
          timeout: 15000,
        });
        // The half that gives the test teeth: a search box that filters nothing
        // would leave this component listed.
        await expect(page.getByTestId(NON_MATCHING_CARD)).toBeHidden();
      });

      await test.step("the same query in uppercase filters identically", async () => {
        await search.fill("CHAT INPUT");

        await expect(page.getByTestId(MATCHING_CARD)).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId(NON_MATCHING_CARD)).toBeHidden();
      });
    });

  test("a query with no match shows the empty state and clearing restores the tree",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const search = page.getByTestId("sidebar-search-input");
      const sidebar = page.getByTestId("shad-sidebar");

      await test.step("the sidebar reports that nothing was found", async () => {
        await search.fill(NO_MATCH_QUERY);

        await expect(sidebar.getByText(EMPTY_STATE_TEXT)).toBeVisible({
          timeout: 15000,
        });
        // Nothing is listed at all — neither cards nor category sections.
        await expect(
          sidebar.locator('[data-testid$="_draggable"]'),
        ).toHaveCount(0);
        await expect(
          sidebar.locator('[data-testid^="disclosure-"]'),
        ).toHaveCount(0);
      });

      await test.step("clearing the field restores the category sections", async () => {
        await search.fill("");

        await expect(search).toHaveValue("");
        await expect(page.getByTestId(BASE_DISCLOSURE)).toBeVisible({
          timeout: 15000,
        });
        await expect(sidebar.getByText(EMPTY_STATE_TEXT)).toBeHidden();
      });
    });

  test("a provider query groups its components under the provider bundle",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      // This is the surface that exists in place of the "provider count" the
      // §15.1 bullet asks for (the sidebar renders no count on 1.12).
      await page.getByTestId("sidebar-search-input").fill(PROVIDER_QUERY);

      await expect(page.getByTestId(PROVIDER_BUNDLE)).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId(PROVIDER_CARD)).toBeVisible();
      // The non-matching base category is filtered out entirely.
      await expect(page.getByTestId(BASE_DISCLOSURE)).toBeHidden();
    });

  test("category disclosures collapse and expand their component list",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const disclosure = page.getByTestId(BASE_DISCLOSURE);
      const child = page.getByTestId(BASE_DISCLOSURE_CHILD);

      await test.step("sections start collapsed", async () => {
        await expect(disclosure).toBeVisible();
        // Asserted through the children, not `data-state`: the disclosure has no
        // data-state attribute on 1.12, which is why the inherited test's only
        // real assertion never ran.
        await expect(child).toBeHidden();
      });

      await test.step("clicking the header reveals the section's components", async () => {
        await disclosure.click();

        await expect(child).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId(MATCHING_CARD)).toBeVisible();
      });

      await test.step("clicking it again hides them", async () => {
        await disclosure.click();

        await expect(child).toBeHidden({ timeout: 15000 });
        await expect(page.getByTestId(MATCHING_CARD)).toBeHidden();
      });
    });
});
