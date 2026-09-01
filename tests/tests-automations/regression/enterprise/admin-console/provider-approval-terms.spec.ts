import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { requireRbacInstance } from "../../../../helpers/enterprise/rbac";

/**
 * `/admin-ee/providers` — where one click decides what the installation may use.
 *
 * The third per-tab follow-up to the console shell, and the first that needs NO
 * credential of any kind: this screen is an APPROVAL surface, not a
 * configuration one. That is why it came before `models`, whose screen reads
 * "No model providers available" until something is configured.
 *
 * The pairing this file exists for cannot be made from the API side. Each
 * recommended card states the terms of the approval BEFORE it is made — the
 * scope it will apply, and the credential alias it will key on — and those
 * displayed terms are the input to the operator's decision. A screen that shows
 * `All workspaces` and writes something narrower, or shows one alias and keys
 * the policy on another, is wrong in a way only a browser test sees.
 *
 * Full reasoning, the teardown contract and the near-miss that shaped test 3:
 * `docs/enterprise/admin-console/provider-approval-terms.md`.
 */

/** The provider approved here. Recommended on a stock instance, and keyless. */
const PROVIDER = { label: "OpenAI", alias: "openai" } as const;

const GOVERNANCE = "/api/v1/model-provider-governance";
const POLICY = "/api/v1/model-provider-policy";
const BUNDLE = "/api/v1/policy-bundle";

interface GovernanceRecord {
  provider_id: string;
  credential_alias: string;
  workspaces: string[];
  status: string;
  approved_by: string;
}

function panel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-providers");
}

async function readGovernance(
  request: APIRequestContext,
  auth: string,
): Promise<GovernanceRecord[]> {
  const response = await request.get(GOVERNANCE, { headers: { Authorization: auth } });
  expect(response.status()).toBe(200);
  return (await response.json()) as GovernanceRecord[];
}

async function readApproved(
  request: APIRequestContext,
  auth: string,
): Promise<string[]> {
  const response = await request.get(POLICY, { headers: { Authorization: auth } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { approved_provider_ids: string[] }).approved_provider_ids;
}

/**
 * Remove an approval the way the product does.
 *
 * `expected_revision` is optimistic concurrency over the whole policy bundle:
 * the removal refuses to act on a bundle that moved under it.
 *
 * Deliberately NOT `PUT /api/v1/model-provider-policy` with an empty list.
 * Measured: that answers `200` and clears the policy while the governance record
 * stays `active`, so the two surfaces then disagree about whether the provider
 * is approved — the exact state a careless cleanup hands to the next spec.
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

/** The recommended card for one provider, before it is approved. */
function recommendedCard(page: Page, label: string) {
  return panel(page).getByRole("listitem").filter({ hasText: label }).first();
}

/** The row this provider occupies in the Available Providers table once approved. */
function availableRow(page: Page, label: string) {
  return panel(page).getByRole("row").filter({ hasText: label }).first();
}

async function openProvidersScreen(page: Page) {
  await page.goto("/admin-ee/providers");
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
}

test.describe("Enterprise — approving a provider writes the terms the screen displayed", () => {
  let auth: string;

  test.beforeEach(async ({ page, request }) => {
    auth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, auth);
    await seedEnterpriseUiSession(page, request);

    // Approval is instance-global. Start from a state where this provider is
    // not approved, rather than assuming it — a previous run that died between
    // its approval and its teardown would otherwise make every assertion here
    // read the wrong way round.
    await revokeApproval(request, auth, PROVIDER.alias);
    expect(
      await readApproved(request, auth),
      `${PROVIDER.alias} is approved before this test approved it`,
    ).not.toContain(PROVIDER.alias);
  });

  test.afterEach(async ({ request }) => {
    await revokeApproval(request, auth, PROVIDER.alias);
  });

  test(
    "approving writes the alias and scope the card displayed, attributed to the approver",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await openProvidersScreen(page);
      const card = recommendedCard(page, PROVIDER.label);

      await test.step("the card states the terms before the click", async () => {
        // Read from the screen, not assumed: these are the terms the operator
        // is agreeing to, and the assertions below check the write against
        // them rather than against a constant this file made up.
        await expect(card).toContainText(PROVIDER.alias);
        await expect(card).toContainText(/All workspaces/i);
      });

      await test.step("approving issues one write", async () => {
        const written = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === GOVERNANCE &&
            response.request().method() === "POST",
          { timeout: 30_000 },
        );
        await card.getByRole("button", { name: "Approve" }).click();
        expect((await written).status()).toBe(201);
      });

      await test.step("and it carries exactly those terms", async () => {
        const records = await readGovernance(request, auth);
        const record = records.find((entry) => entry.provider_id === PROVIDER.alias);
        expect(record, `no governance record for ${PROVIDER.alias}`).toBeDefined();

        // Keyed on the alias the card showed. A screen that displayed one alias
        // and keyed the policy on another would leave an operator's credential
        // attached to nothing.
        expect(record!.credential_alias).toBe(PROVIDER.alias);
        // Scoped as the card said. `All workspaces` is a promise about blast
        // radius; a narrower write would silently not apply where the operator
        // was told it would.
        expect(record!.workspaces).toEqual(["all"]);
        expect(record!.status).toBe("active");
        expect(record!.approved_by, "the approval is not attributed").toBeTruthy();
      });

      await test.step("and the policy gains exactly that provider", async () => {
        expect(await readApproved(request, auth)).toEqual([PROVIDER.alias]);
      });
    },
  );

  test(
    "an approved provider is reported pending credentials, not ready",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      await openProvidersScreen(page);
      await recommendedCard(page, PROVIDER.label)
        .getByRole("button", { name: "Approve" })
        .click();

      // Approval is a POLICY act: it does not make one model callable. A screen
      // reporting "approved / ready" here would tell an operator their platform
      // can use this provider while nothing can authenticate to it.
      await test.step("it says what is still missing", async () => {
        const attention = panel(page).getByRole("region", { name: /Needs attention/i });
        await expect(attention).toContainText(PROVIDER.label);
        await expect(attention).toContainText(/Pending/i);
        await expect(attention).toContainText(/[Cc]onfigure credentials/);
      });

      await test.step("and it is listed as pending among the available providers", async () => {
        await expect(availableRow(page, PROVIDER.label)).toContainText(/Pending/i);
      });
    },
  );

  test(
    "dismissing the reminder does not change the approval",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await openProvidersScreen(page);
      await recommendedCard(page, PROVIDER.label)
        .getByRole("button", { name: "Approve" })
        .click();
      await expect(availableRow(page, PROVIDER.label)).toContainText(/Pending/i);

      // Armed before the click: "nothing was written" is a claim about a
      // request, and reading the policy afterwards races the write it is meant
      // to detect — the correction this suite already had to make once.
      const writes: string[] = [];
      page.on("request", (issued) => {
        const { pathname } = new URL(issued.url());
        if (pathname.startsWith("/api/") && issued.method() !== "GET") {
          writes.push(`${issued.method()} ${pathname}`);
        }
      });

      await panel(page)
        .getByRole("button", { name: `Dismiss ${PROVIDER.label}` })
        .click();

      await test.step("it issues no write", async () => {
        // `refresh` is the session's own, unrelated to this control: the page
        // is seeded with an access token and deliberately no refresh token.
        expect(writes.filter((write) => !write.includes("/refresh"))).toEqual([]);
      });

      await test.step("the approval stands", async () => {
        expect(await readApproved(request, auth)).toEqual([PROVIDER.alias]);
      });

      await test.step("and the provider is still listed", async () => {
        // The half that keeps this honest in the other direction. Dismiss
        // removes the REMINDER; a build that also dropped this row would hide
        // an approved provider from the only screen that lists it — which is
        // what a partial read of this screen made it look like at first.
        await expect(availableRow(page, PROVIDER.label)).toContainText(/Pending/i);
      });
    },
  );
});
