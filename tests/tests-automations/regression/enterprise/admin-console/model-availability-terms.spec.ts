import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { requireRbacInstance } from "../../../../helpers/enterprise/rbac";

/**
 * `/admin-ee/models` — approved is not available, and three surfaces must agree.
 *
 * The last per-tab follow-up to the console shell, scheduled last on an
 * assumption that turned out to be wrong: that this screen needs a provider
 * credential. Approving a provider — itself keyless — populates it with 44
 * models and no key anywhere.
 *
 * With a provider approved and nothing configured, the row reads `Pending` and
 * `Hidden`, every model reads `Disabled`, and the policy's `enabled_model_keys`
 * is empty. A build where any one of those drifted would tell an operator the
 * platform is offering models it cannot call.
 *
 * The write half — entering edit mode, enabling a model, saving — was excluded on
 * the strength of #1659, which reported `Edit models` as a control that opened
 * nothing. That report was three measurement errors and is closed invalid: it is
 * a TOGGLE, and each of the 44 rows swaps its state text for a
 * `role="switch"` named after the model. #1669 covers the round trip.
 */

const PROVIDER = { label: "OpenAI", alias: "openai" } as const;

const GOVERNANCE = "/api/v1/model-provider-governance";
const AVAILABILITY = "/api/v1/model-availability-policy";
const BUNDLE = "/api/v1/policy-bundle";

function modelsPanel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-models");
}

function providersPanel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-providers");
}

/** The provider's row in the Available Models table. */
function providerRow(page: Page, label: string) {
  return modelsPanel(page).getByRole("row").filter({ hasText: label }).first();
}

async function enabledModelKeys(
  request: APIRequestContext,
  auth: string,
): Promise<string[]> {
  const response = await request.get(AVAILABILITY, { headers: { Authorization: auth } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { enabled_model_keys: string[] }).enabled_model_keys;
}

/**
 * Remove the approval the way the product does.
 *
 * NOT `PUT /api/v1/model-provider-policy` with an empty list: that clears the
 * policy while leaving the governance record `active`, so the two surfaces
 * disagree afterwards. Established in `provider-approval-terms`.
 */
async function revokeApproval(
  request: APIRequestContext,
  auth: string,
  providerId: string,
): Promise<void> {
  const headers = { Authorization: auth };
  const bundle = await request.get(BUNDLE, { headers });
  if (!bundle.ok()) return;
  const { revision } = (await bundle.json()) as { revision: number };
  await request
    .delete(`${GOVERNANCE}/${providerId}`, { headers, data: { expected_revision: revision } })
    .catch(() => undefined);
}

/** Approve through the screen that owns approving, then come back. */
async function approveThroughUi(page: Page, label: string): Promise<void> {
  await page.goto("/admin-ee/providers");
  await expect(providersPanel(page)).toBeVisible({ timeout: 30_000 });
  const written = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === GOVERNANCE &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await providersPanel(page)
    .getByRole("listitem")
    .filter({ hasText: label })
    .first()
    .getByRole("button", { name: "Approve" })
    .click();
  expect((await written).status()).toBe(201);
}

/** Open a provider's row and turn on the inline model editor. */
async function enterEditMode(page: Page, label: string): Promise<void> {
  await providerRow(page, label)
    .getByRole("button", { name: /Review/i })
    .click();
  const toggle = modelsPanel(page).getByRole("button", { name: /^Edit models$/i });
  await toggle.click();
  // `aria-pressed`, not a dialog: the control is a toggle, and reading it any
  // other way is what made #1659 look like a defect.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/** The model a per-model switch is about, from its accessible name. */
function modelNameFrom(accessibleName: string | null): string {
  const match = /^Show (.+) in model pickers$/.exec(accessibleName ?? "");
  expect(match, `unexpected switch name: ${accessibleName}`).not.toBeNull();
  return match![1];
}

async function openModelsScreen(page: Page) {
  await page.goto("/admin-ee/models");
  await expect(modelsPanel(page)).toBeVisible({ timeout: 30_000 });
}

test.describe("Enterprise — the models screen reports availability the policy actually holds", () => {
  let auth: string;

  test.beforeEach(async ({ page, request }) => {
    auth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, auth);
    await seedEnterpriseUiSession(page, request);
    // Start from "nothing approved" rather than assuming it: a previous run that
    // died between its approval and its teardown would make the empty-state test
    // read the wrong way round.
    await revokeApproval(request, auth, PROVIDER.alias);
  });

  test.afterEach(async ({ request }) => {
    await revokeApproval(request, auth, PROVIDER.alias);
  });

  test(
    "with no provider approved, the screen names what is missing and links the fix",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      await openModelsScreen(page);

      // The state a fresh instance is in, and the only guidance an operator
      // gets — so it is asserted rather than assumed to be a blank table.
      await expect(modelsPanel(page)).toContainText(/No model providers available/i);
      await expect(
        modelsPanel(page).getByRole("link", { name: /add a provider/i }),
      ).toHaveAttribute("href", "/admin-ee/providers");
    },
  );

  test(
    "approving a provider populates the catalog with no credential",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);

      // The measurement that made this whole spec possible: the catalog is a
      // consequence of APPROVAL, not of configuration.
      await expect(providerRow(page, PROVIDER.label)).toContainText(/\d+ models/);
    },
  );

  test(
    "approved is not available: the row and the policy agree that nothing is enabled",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);

      const row = providerRow(page, PROVIDER.label);

      await test.step("the row reports pending credentials and hidden from builders", async () => {
        await expect(row).toContainText(/Pending/i);
        await expect(row).toContainText(/Hidden/i);
      });

      await test.step("and the policy holds nothing enabled", async () => {
        // The pairing. A row reading `Visible` over an empty policy — or the
        // reverse — would tell an operator the platform offers models it cannot
        // call, and neither surface alone can catch it.
        expect(await enabledModelKeys(request, auth)).toEqual([]);
      });
    },
  );

  test(
    "entering edit mode offers one control per model and writes nothing yet",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);
      await enterEditMode(page, PROVIDER.label);

      const switches = modelsPanel(page).getByRole("switch");

      await test.step("one switch per model, each naming its model", async () => {
        // Named, not positional: the switch's accessible name is what lets the
        // next test assert on the model it chose rather than on an index.
        const count = await switches.count();
        expect(count, "edit mode revealed no per-model control").toBeGreaterThan(0);
        await expect(switches.first()).toHaveAccessibleName(/in model pickers$/);
      });

      await test.step("and the policy is untouched", async () => {
        // A screen that wrote on ENTERING an edit mode would be surprising in
        // the worst way, and nothing else here would notice.
        expect(await enabledModelKeys(request, auth)).toEqual([]);
      });
    },
  );

  test(
    "enabling a model and saving lands exactly that model in the policy",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);
      await enterEditMode(page, PROVIDER.label);

      const target = modelsPanel(page).getByRole("switch").first();
      const model = modelNameFrom(await target.getAttribute("aria-label"));

      const writes: string[] = [];
      page.on("request", (issued) => {
        const { pathname } = new URL(issued.url());
        if (pathname === AVAILABILITY && issued.method() !== "GET") writes.push(pathname);
      });

      await target.click();

      await test.step("flipping the switch stages the change without writing", async () => {
        // Measured: the toggle issues nothing. The save bar is what commits, and
        // asserting on the request is the only way to tell staged from written
        // without racing the write.
        expect(writes).toEqual([]);
      });

      await test.step("saving writes it, keyed on the model the switch named", async () => {
        const written = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === AVAILABILITY &&
            response.request().method() === "PUT",
          { timeout: 30_000 },
        );
        await modelsPanel(page)
          .getByRole("button", { name: /^Save models$/i })
          .click();
        expect((await written).status()).toBe(200);

        await expect
          .poll(() => enabledModelKeys(request, auth), { timeout: 15_000 })
          .toEqual([expect.stringContaining(model)]);
      });
    },
  );

  test(
    "enabling a model does not make it visible while the provider has no credentials",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);
      await enterEditMode(page, PROVIDER.label);

      await modelsPanel(page).getByRole("switch").first().click();
      await modelsPanel(page)
        .getByRole("button", { name: /^Save models$/i })
        .click();
      await expect
        .poll(() => enabledModelKeys(request, auth), { timeout: 15_000 })
        .not.toEqual([]);

      // Availability and builder visibility are DIFFERENT AXES, and the screen
      // does not conflate them: one enabled model on a provider that still has
      // no credentials is not something a builder can pick. A row flipping to
      // `Visible` here would tell an operator their builders can choose a model
      // nothing can authenticate to — which is the same lie #1660's read tests
      // exist to catch, arriving from the other direction.
      await expect(providerRow(page, PROVIDER.label)).toContainText(/Hidden/i);
      await expect(providerRow(page, PROVIDER.label)).toContainText(/Pending/i);
    },
  );

  test(
    "cancelling an edit discards it",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);
      await enterEditMode(page, PROVIDER.label);

      const writes: string[] = [];
      page.on("request", (issued) => {
        const { pathname } = new URL(issued.url());
        if (pathname === AVAILABILITY && issued.method() !== "GET") writes.push(pathname);
      });

      await modelsPanel(page).getByRole("switch").first().click();
      await modelsPanel(page).getByRole("button", { name: /^Cancel$/i }).click();

      await test.step("no write leaves the browser", async () => {
        // Asserted on the request rather than by reading the policy afterwards:
        // a state read taken immediately after races the write it is meant to
        // detect, which this suite has already had to correct twice.
        expect(writes, "cancelling an edit issued a write").toEqual([]);
      });

      await test.step("and the policy is as it was", async () => {
        expect(await enabledModelKeys(request, auth)).toEqual([]);
      });
    },
  );

  test(
    "the expanded row states the governance terms it inherited, and lists its models disabled",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      await approveThroughUi(page, PROVIDER.label);
      await openModelsScreen(page);

      await providerRow(page, PROVIDER.label)
        .getByRole("button", { name: /Review/i })
        .click();

      await test.step("the terms match the approval that created it", async () => {
        // Set on the providers screen, read here: the two screens describe one
        // decision, and a drift between them is invisible from either alone.
        await expect(modelsPanel(page)).toContainText(/All workspaces/i);
        await expect(modelsPanel(page)).toContainText(/All environments/i);
      });

      await test.step("and every model it offers is disabled", async () => {
        const models = modelsPanel(page).getByRole("list", { name: "Models" });
        await expect(models).toBeVisible();
        const entries = await models.getByRole("listitem").allInnerTexts();
        expect(entries.length, "the expanded row listed no models").toBeGreaterThan(0);
        for (const entry of entries) {
          expect(entry, "a model is offered while the policy enables none").toMatch(/Disabled/i);
        }
      });
    },
  );
});
