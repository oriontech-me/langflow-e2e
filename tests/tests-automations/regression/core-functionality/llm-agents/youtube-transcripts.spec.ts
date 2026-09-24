import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { clearOutdatedComponents } from "../../../../helpers/ui/clear-outdated-components";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import {
  probeProviderComponent,
  undecidedProbeMessage,
} from "../../../../helpers/provider-setup/probe-component-available";

// PARKED — #1912 (Wave 9 T2). YouTube Transcripts is not shipped by the image this
// suite tests. Measured on the nightly `1.13.0.dev22`: `GET /api/v1/all` returns 32
// categories / 200 component types with ZERO `youtube` hits, and a sidebar search for
// `youtube` renders "No components found." — so `getByTestId("youtubeYouTube
// Transcripts")` can never resolve, which is the recorded `locator.hover: Timeout
// 20000ms exceeded`. `src/lfx/src/lfx/components/youtube/__init__.py` is an
// `lfx-bundles-shim` and `import lfx_bundles` raises ModuleNotFoundError in the
// container, which makes this packaging (#1039/#1040,
// docs/component-distribution-policy.md) rather than drift.
//
// GATE AND SKIP, replacing the bare `test.skip` this file was imported with. The
// standing policy answers a distribution the tested image does not install with "Gate
// and skip, with an attributed reason. Do not delete the spec, do not leave it
// failing" — the groq/mistral/composio treatment. The bare modifier was inert,
// unattributed and indistinguishable from a test somebody meant to come back to; the
// gate below opens by itself the day the image installs `lfx-bundles`.
//
// The park's OWNER is an open issue rather than a declaration in
// scripts/lib/stable-orphan-exemptions.json: #1746's reconciler reports a declaration
// whose test NEVER carried `@stable` as expired, and this one never did.
// See docs/core-functionality/llm-agents/youtube-transcripts.md.
test.describe("YouTube Transcripts component", () => {
  let flows: ReturnType<typeof trackCreatedFlows>;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    await flows.cleanup(request);
  });

  test(
    "user should be able to use youtube transcripts component",
    { tag: ["@release", "@components", "@agents"] },
    async ({ page, request }) => {
      // Runs BEFORE the first UI step: when the component cannot be placed at all,
      // a 20 s hover timeout names nothing (#1039's whole point). Three states, and
      // only `absent` may claim packaging (#1930) — a wedged or erroring backend
      // also skips, but says so rather than asserting a distribution it never read.
      const componentProbe = await probeProviderComponent(request, "youtube");
      test.skip(
        componentProbe.state !== "present",
        componentProbe.state === "undecided"
          ? undecidedProbeMessage("youtube", componentProbe)
          : "YouTube components not exposed by this Langflow build — the `lfx-bundles` distribution that ships them is not installed (#1039, #1912)",
      );

      await awaitBootstrapTest(page);

      await page.getByTestId("blank-flow").click();
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("youtube");

      await page.getByTestId("youtubeYouTube Transcripts").hover();
      await page.getByTestId("add-component-button-youtube-transcripts").click();
      await adjustScreenView(page);

      await clearOutdatedComponents(page);

      await page
        .getByTestId("textarea_str_url")
        .fill("https://www.youtube.com/watch?v=VqhCQZaH4Vs");

      await adjustScreenView(page);

      await page.getByTestId("button_run_youtube transcripts").click();

      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page
        .getByTestId("output-inspection-transcript-youtube-transcripts")
        .first()
        .click();
      await page.waitForSelector("text=Component Output", { timeout: 30000 });
      await page.getByRole("gridcell").first().click();
      const value = await page.getByPlaceholder("Empty").inputValue();
      expect(value.length).toBeGreaterThan(10);
    },
  );
});
