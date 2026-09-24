import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";
import {
  probeProviderComponent,
  undecidedProbeMessage,
} from "../../../helpers/provider-setup/probe-component-available";

// PARKED — #1912 (Wave 9 T2). ComposIO is not shipped by the image this suite tests.
// Measured on the nightly `1.13.0.dev22`: `GET /api/v1/all` returns 32 categories /
// 200 component types with ZERO `composio` component entries — the four raw substring
// hits in the body are the `replacement = ["composio.ComposioGmailAPIComponent"]`
// attribute of Google's own legacy Gmail loader, pointing at a class the image does
// not ship — and a sidebar search for `composio` renders "No components found.". So
// `waitForSelector('[data-testid="composioComposio Tools"]')` can never resolve, which
// is the recorded `page.waitForSelector: Timeout 3000ms exceeded`.
// `src/lfx/src/lfx/components/composio/__init__.py` is an `lfx-bundles-shim` and
// `import lfx_bundles` raises ModuleNotFoundError in the container, which makes this
// packaging (#1039/#1040, docs/component-distribution-policy.md) rather than drift.
//
// GATE AND SKIP, not `test.fixme`: the standing policy answers a distribution the
// tested image does not install with "Gate and skip, with an attributed reason. Do not
// delete the spec, do not leave it failing". That gate self-heals the day the image
// installs `lfx-bundles`; a `test.fixme` is inert until a human edits it.
// `core-functionality/llm-agents/composio.spec.ts` carries the same absence from the
// other side (#1916).
//
// THIS FILE USED TO HOLD A SECOND TEST, "user should be able to use connect tools",
// deleted under the T2 design's DELETE outcome. It was never a ComposIO test: it waited
// for `[data-testid="searchapiSearchApi"]` at 1000 ms. `SearchAPI` IS in the catalog
// (`tools::SearchAPI`, from core `lfx.components.tools.search_api`), but all ten
// components of the `tools` category are `legacy: true` and legacy components are not
// offered in the sidebar — searching `search api` and `searchapi` both render "No
// components found.". Its subject and failure condition are covered, strictly more
// strongly, by `core-components/tool-mode.spec.ts` → "User should be able to use
// components as tool", which connects `handle-urlcomponent-shownode-toolset-right` to
// `handle-agent-shownode-tools-left`, asserts the edge, and then also asserts the
// toolset's `tool_name` / `tool_description` / `tool_tags` output contract.
//
// See docs/flow-functionality/generalBugs-shard-11.md.
test.describe("ComposIO Tools on the canvas", () => {
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
  });

  test(
    "user should be able to use ComposIO without getting api_key error",
    { tag: ["@release", "@components", "@workspace"] },
    async ({ page, request }) => {
      // Runs BEFORE the first UI step: when the component cannot be placed at all, a
      // 3 s selector timeout names nothing (#1039's whole point). Three states, and
      // only `absent` may claim packaging (#1930) — a wedged or erroring backend also
      // skips, but says so rather than asserting a distribution it never read.
      const componentProbe = await probeProviderComponent(request, "composio");
      test.skip(
        componentProbe.state !== "present",
        componentProbe.state === "undecided"
          ? undecidedProbeMessage("composio", componentProbe)
          : "ComposIO components not exposed by this Langflow build — the `lfx-bundles` distribution that ships them is not installed (#1039, #1912)",
      );

      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("composio");

      await page.waitForSelector('[data-testid="composioComposio Tools"]', {
        timeout: 30000,
      });

      const modelElement = page.getByTestId("composioComposio Tools");
      const targetElement = page.locator('//*[@id="react-flow-id"]');
      await modelElement.dragTo(targetElement);

      await page.mouse.up();
      await page.mouse.down();
      await adjustScreenView(page);

      await zoomOut(page, 2);

      await expect(page.getByText("api_key")).toBeHidden({ timeout: 3000 });
    },
  );
});
