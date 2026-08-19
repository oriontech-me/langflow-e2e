import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { requireEnvironmentPolicy } from "../../../../helpers/enterprise/policy-gate";

/**
 * The browser-facing half of environment-declared catalog policy.
 *
 * `/admin-ee/catalog` is the screen an operator uses to decide what the
 * platform's users may place. When the policy belongs to the deployment rather
 * than to this screen, the screen has to say so and stop offering to edit it —
 * otherwise the operator is invited to make a change that either does nothing
 * or quietly overrides what the deployment declared.
 *
 * The frontend implements that state and gates all of it on one API field,
 * `managed_externally`. Three surfaces change with it, and they are not equally
 * important: a banner is a statement, a provenance row is a label, and the
 * disabled edit button is the thing that actually prevents the edit. A build
 * that kept the banner while re-enabling the button would look right in a
 * screenshot and be wrong in every way that matters.
 *
 * The two tests here differ ONLY in whether that field is intercepted, and the
 * pair is diagnostic where neither is alone:
 *
 *   mocked pass + live fail  -> the UI is correct, the API misreports the field
 *                               (the state on current builds)
 *   mocked fail              -> the UI dropped the contract; fixing the API
 *                               would not fix the screen
 *   both pass                -> correct end to end
 *
 * The mocked one exists because on current builds the read-only path is
 * unreachable from a real instance, so without it a refactor that dropped the
 * field would be invisible — the dead-gate failure this repo has been bitten by.
 * The live one is EXPECTED TO FAIL, for the product finding its API sibling
 * `environment-policy-authority` records, tracked outside this repository. Do
 * not relax it to make the lane green.
 */
const BLOCKED_COMPONENT = "CombineText";

/** The reads the admin screen gates its read-only state on. */
const POLICY_READS = [
  "**/api/v1/policy-bundle",
  "**/api/v1/catalog-policy/components",
];

const BANNER = /Managed by deployment configuration/i;
const MANAGED_EXTERNALLY_ROW = /External policy source/i;
const MANAGED_HERE_ROW = /Admin\s*›\s*Catalog/i;
const EDIT_BUTTON = /Edit Catalog Policy/i;

/** Force `managed_externally: true` on the policy reads, leaving writes alone. */
async function forceManagedExternally(page: Page): Promise<void> {
  for (const pattern of POLICY_READS) {
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.managed_externally = true;
      await route.fulfill({ response, json: body });
    });
  }
}

/**
 * Open the catalog tab and expand the first bundle, returning its panel.
 *
 * Waits on the bundle rows rather than on the route: a screen that has not
 * loaded satisfies every "absent" assertion in this file while proving nothing.
 */
async function openFirstBundle(page: Page) {
  await page.goto("/admin-ee/catalog");

  const rows = page.locator('button[aria-controls^="catalog-bundle-"]');
  await expect(
    rows.first(),
    "the admin catalog never rendered a bundle row — the assertions below would " +
      "pass against an empty screen",
  ).toBeVisible({ timeout: 30_000 });

  const header = rows.first();
  await header.click();
  const panelId = await header.getAttribute("aria-controls");
  const panel = page.locator(`#${panelId}`);
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("Enterprise — the admin UI renders the read-only policy state", () => {
  test(
    "the screen honours managed_externally: banner, provenance and a disabled edit control",
    { tag: ["@enterprise", "@regression", "@governance"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });
      await seedEnterpriseUiSession(page, request);
      await forceManagedExternally(page);

      const panel = await openFirstBundle(page);

      await test.step("the screen says the policy is not its own", async () => {
        await expect(page.getByRole("note").filter({ hasText: BANNER })).toBeVisible();
      });

      await test.step("the bundle names the external source as where it is managed", async () => {
        await expect(panel).toContainText(MANAGED_EXTERNALLY_ROW);
      });

      await test.step("and the edit control is disabled", async () => {
        // The assertion that matters. The two above are statements; this is the
        // one that prevents the edit.
        await expect(
          panel.getByRole("button", { name: EDIT_BUTTON }),
        ).toBeDisabled();
      });
    },
  );

  test(
    "an operator viewing a deployment-declared policy is not offered an editable screen",
    { tag: ["@enterprise", "@regression", "@governance"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });
      await seedEnterpriseUiSession(page, request);

      // No interception: this is what an operator actually sees on an instance
      // whose policy was declared in its deployment.
      const panel = await openFirstBundle(page);

      await test.step("the read-only banner is shown", async () => {
        await expect(page.getByRole("note").filter({ hasText: BANNER })).toBeVisible();
      });

      await test.step("the bundle does not claim this screen owns the policy", async () => {
        await expect(panel).not.toContainText(MANAGED_HERE_ROW);
      });

      await test.step("and the edit control is disabled", async () => {
        await expect(
          panel.getByRole("button", { name: EDIT_BUTTON }),
        ).toBeDisabled();
      });
    },
  );
});
