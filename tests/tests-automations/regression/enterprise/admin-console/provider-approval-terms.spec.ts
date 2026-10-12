import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import {
  addProviderDialog,
  approveProviderThroughUi,
  GOVERNANCE,
  openAddProviderDialog,
  providersPanel as panel,
  revokeProviderApproval as revokeApproval,
  submitAddProvider,
} from "../../../../helpers/enterprise/provider-approval-ui";
import { requireRbacInstance } from "../../../../helpers/enterprise/rbac";

/**
 * `/admin/providers` — where one click decides what the installation may use.
 *
 * The third per-tab follow-up to the console shell, and the first that needs NO
 * credential of any kind: this screen is an APPROVAL surface, not a
 * configuration one. That is why it came before `models`, whose screen reads
 * "No model providers available" until something is configured.
 *
 * The pairing this file exists for cannot be made from the API side. The
 * approval states its terms BEFORE it is made, and those displayed terms are the
 * input to the operator's decision. On 1.13 the recommended cards are gone and
 * approval is the `Add provider` dialog (#2259), which displays one term — the
 * credential alias the policy will key on — and writes the scope as a hidden
 * default (#2264). A screen that shows one alias and keys the policy on another is
 * wrong in a way only a browser test sees; the hidden scope is asserted at the API.
 *
 * Full reasoning, the teardown contract and the near-miss that shaped test 3:
 * `docs/enterprise/admin-console/provider-approval-terms.md`.
 */

/** The provider approved here. Recommended on a stock instance, and keyless. */
const PROVIDER = { label: "OpenAI", alias: "openai" } as const;

const POLICY = "/api/v1/model-provider-policy";

interface GovernanceRecord {
  provider_id: string;
  credential_alias: string;
  workspaces: string[];
  status: string;
  approved_by: string;
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

/** The row this provider occupies in the Available Providers table once approved. */
function availableRow(page: Page, alias: string) {
  return panel(page).getByTestId(`provider-row-${alias}`);
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
    "approving writes the alias the dialog displayed, with the default scope, attributed to the approver",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await openAddProviderDialog(page, PROVIDER.label);

      await test.step("the dialog states the alias before the click", async () => {
        // Read from the screen, not assumed: it is the term the operator is
        // agreeing to, and the write is checked against it. An input's value,
        // so `toHaveValue` — `toContainText` does not read inputs.
        await expect(
          addProviderDialog(page).getByRole("textbox", { name: "Credential alias" }),
        ).toHaveValue(PROVIDER.alias);
      });

      await test.step("approving issues one write", async () => {
        expect((await submitAddProvider(page)).status()).toBe(201);
      });

      await test.step("and it carries exactly those terms", async () => {
        const records = await readGovernance(request, auth);
        const record = records.find((entry) => entry.provider_id === PROVIDER.alias);
        expect(record, `no governance record for ${PROVIDER.alias}`).toBeDefined();

        // Keyed on the alias the dialog showed. A screen that displayed one
        // alias and keyed the policy on another would leave an operator's
        // credential attached to nothing.
        expect(record!.credential_alias).toBe(PROVIDER.alias);
        // The dialog does not show the scope; it writes a default. Pinned at the
        // API because a narrower default would silently not apply where an
        // operator approving "globally" expects it to — the Models screen then
        // displays it as All workspaces.
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
      await approveProviderThroughUi(page, PROVIDER.label);

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
        await expect(availableRow(page, PROVIDER.alias)).toContainText(/Pending/i);
      });
    },
  );

  test(
    "dismissing the reminder does not change the approval",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      await approveProviderThroughUi(page, PROVIDER.label);
      await expect(availableRow(page, PROVIDER.alias)).toContainText(/Pending/i);

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
        // `refresh` is the session's own, unrelated to this control.
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
        await expect(availableRow(page, PROVIDER.alias)).toContainText(/Pending/i);
      });
    },
  );
});
