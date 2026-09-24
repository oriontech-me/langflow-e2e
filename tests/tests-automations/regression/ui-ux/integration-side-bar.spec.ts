import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";

// Promoted out of the Wave 9 T2 inherited backlog (#1912). It was measured `0/3 green`
// for one reason: it asserted `getByText("Notion")` and `getByText("AssemblyAI")`, and
// neither bundle is on the tested image. Both are `lfx-bundles-shim` families and
// `import lfx_bundles` raises ModuleNotFoundError in the container, so the catalog
// carries zero of either and the Bundles view renders 17 other disclosures instead.
// The navigation itself — the part this spec exists for — has always worked.
//
// The replacement names are lane-guaranteed rather than arbitrary: `openai`,
// `anthropic` and `google` ship as their own installed distributions and the daily
// rotates its provider across exactly these three (#1185), so a packaging change that
// removed one would break far more than this file. That this is still a name assert is
// stated in the spec doc rather than glossed; deriving the expectation from
// `GET /api/v1/all` was rejected there because it would assert the catalog against
// itself.
//
// See docs/ui-ux/integration-side-bar.md.

const LANE_GUARANTEED_BUNDLES = [
  "disclosure-bundles-openai",
  "disclosure-bundles-anthropic",
  "disclosure-bundles-google",
];

test.describe("Sidebar bundles view", () => {
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
  });

  test(
    "user should be able to see integrations in the sidebar when bundles is selected",
    { tag: ["@stable", "@release", "@api", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await test.step("open a blank flow and wait for the sidebar", async () => {
        await awaitBootstrapTest(page);
        await page.getByTestId("blank-flow").click();
        await page.waitForSelector('[data-testid="shad-sidebar"]', {
          timeout: 30000,
        });
      });

      const groupLabel = (name: string) =>
        page.locator('[data-sidebar="group-label"]', { hasText: name });

      await test.step("switch to the Bundles view", async () => {
        await expect(groupLabel("Components")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("sidebar-nav-bundles").click();
        await expect(groupLabel("Bundles")).toBeVisible({ timeout: 30000 });
      });

      await test.step("the installed vendor bundles each render a disclosure", async () => {
        for (const bundle of LANE_GUARANTEED_BUNDLES) {
          await expect(page.getByTestId(bundle)).toBeVisible({
            timeout: 15000,
          });
        }
      });

      await test.step("the Components tree is replaced, not appended to", async () => {
        // Without this the test would pass on a build that rendered both trees at
        // once — i.e. it would assert that Bundles renders, never that the nav
        // navigated.
        await expect(groupLabel("Components")).toBeHidden();
      });
    },
  );
});
