import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { clearApiKeyBadges } from "../../../../helpers/ui/clear-api-key-badges";
import {
  probeProviderComponent,
  undecidedProbeMessage,
} from "../../../../helpers/provider-setup/probe-component-available";

// PARKED — #1916. ComposIO is not shipped by the image this suite tests, and the
// surface is already out of scope for this team (QA-CHECKLIST.md § 6.2, 2026-08-06).
// Measured on the nightly `1.13.0.dev15`: `GET /api/v1/all` returns 29 categories /
// 183 component types with ZERO `composio` hits, so `getByTestId("composioGmail")` can
// never resolve; `src/lfx/src/lfx/components/composio/__init__.py` is an
// `lfx-bundles-shim` and `import lfx_bundles` raises ModuleNotFoundError in the
// container, which makes this packaging (#1039/#1040,
// docs/component-distribution-policy.md) rather than drift.
//
// GATE AND SKIP, not `test.fixme`, and the distinction is the standing policy's rather
// than a preference: docs/component-distribution-policy.md's decision table answers a
// distribution the tested image does not install with "Gate and skip, with an attributed
// reason. Do not delete the spec, do not leave it failing" — the groq/mistral treatment.
// A `test.fixme` is inert forever; the availability gate below opens by itself the day
// the image installs `lfx-bundles`.
//
// The park's OWNER is an open issue rather than a declaration in
// scripts/lib/stable-orphan-exemptions.json: #1746's reconciler reports a declaration
// whose test NEVER carried `@stable` as expired, and this one never did.
// See docs/core-functionality/llm-agents/composio.md.
test(
  "user should be able to interact with composio component",
  { tag: ["@release", "@workspace", "@api", "@components"] },
  async ({ page, context, request }) => {
    // Runs BEFORE the credential gate and before the first UI step: when the
    // component cannot be placed at all, "which key is missing" is the wrong
    // attribution, and `getByTestId("composioGmail")` would otherwise hard-fail on a
    // 20 s hover timeout that names nothing (#1039's whole point).
    // Three states, and only `absent` may claim packaging (#1930): a wedged or
    // erroring backend also skips this spec, but it says so rather than
    // asserting a distribution it never managed to read.
    const componentProbe = await probeProviderComponent(request, "composio");
    test.skip(
      componentProbe.state !== "present",
      componentProbe.state === "undecided"
        ? undecidedProbeMessage("composio", componentProbe)
        : "ComposIO components not exposed by this Langflow build — the `lfx-bundles` distribution that ships them is not installed (#1039, #1916)",
    );

    // Env-var presence is the CORRECT gate here (#1029 audit): Composio is a tool
    // provider, not an LLM provider — `collect-models` never probes it, so
    // providers.json holds no health record to consume. The test also drives no
    // completion; it only configures the Gmail component's credential surface, so
    // a dead key cannot produce the hung request that wedges a shard.
    //
    // It is also why the #1784 measurement reads `skipped in 3/3 run(s)`:
    // COMPOSIO_API_KEY is not a repository secret and appears in no workflow, so this
    // gate has never opened in any lane. That is a credential fact, not a verdict
    // about Langflow.
    test.skip(
      !process?.env?.COMPOSIO_API_KEY,
      "COMPOSIO_API_KEY required to run this test",
    );

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 5000,
    });

    await page.getByTestId("blank-flow").click();
    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 5000,
    });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("gmail");

    await page
      .getByTestId("composioGmail")
      .hover()
      .then(async (): Promise<void> => {
        await page.getByTestId("add-component-button-gmail").click();
      });

    await clearApiKeyBadges(page);

    await page
      .getByTestId("popover-anchor-input-api_key")
      .fill(process.env.COMPOSIO_API_KEY!);

    await page.waitForSelector('[data-testid="button_connected_gmail"]', {
      timeout: 20000,
    });

    await page.waitForSelector("text=OAUTH2", { timeout: 20000 });

    await expect(
      page.getByTestId(
        "button_open_list_selection_sortablelist_sortablelist_action_button",
      ),
    ).toBeVisible({ timeout: 5000 });
    await page
      .getByTestId(
        "button_open_list_selection_sortablelist_sortablelist_action_button",
      )
      .click();

    await page.getByTestId(`list_item_fetch_emails`).click();

    await expect(page.getByTestId("button_run_gmail")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("button_run_gmail").click();

    await page.waitForSelector("text=built successfully", {
      timeout: 30000,
    });

    await page
      .getByTestId("output-inspection-dataframe-composiogmailapicomponent")
      .click();

    const colNumber: number = await page.getByRole("gridcell").count();
    expect(colNumber).toBeGreaterThan(1);
  },
);
