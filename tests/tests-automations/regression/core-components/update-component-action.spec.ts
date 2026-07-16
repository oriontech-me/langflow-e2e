import { readFileSync } from "fs";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// A saved flow whose 5 components (Prompt, Chat Input, OpenAI, Chat Output, Chat
// Memory) are pinned to a 1.4.0-era snapshot, old enough that all resolve to
// outdated updates on the current nightly — the deterministic source of the
// outdated state whose update we then apply. Shared with the notification and
// breaking-change specs.
const OUTDATED_FLOW = path.resolve(
  __dirname,
  "../../../assets/flows/outdated_flow.json",
);

// Ids of every flow created by a test — the imported host flow AND the "(Backup)"
// copy the apply creates — deleted id-scoped in afterEach (repo convention,
// #490/#681). Applying the update mutates state and creates the backup, so
// cleaning both is load-bearing.
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // deleteFlow treats a 404 as done (#545), so a double-delete is harmless.
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

async function importOutdatedFlowAndOpen(
  page: Page,
  request: APIRequestContext,
  bearer: string,
  hostName: string,
): Promise<void> {
  // Strip the fixture's own id/endpoint_name (unique keys) so the backend mints
  // a fresh id — parallel-safe, independent of prior cleanup (#689).
  const raw = JSON.parse(readFileSync(OUTDATED_FLOW, "utf-8"));
  delete raw.id;
  delete raw.endpoint_name;
  const flowId = await createFlow(
    request,
    { ...raw, name: hostName },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await expect(
    page.getByText(/\d+ components? needs? updates?/i),
  ).toBeVisible({ timeout: 30000 });
}

// Read the outdated total from the "N components need updates" banner.
async function readOutdatedCount(page: Page): Promise<number> {
  const text = await page
    .getByText(/\d+ components? needs? updates?/i)
    .first()
    .textContent();
  const match = text?.match(/(\d+)\s+components?\s+needs?\s+updates?/i);
  return Number(match?.[1] ?? 0);
}

// Per-node update indicators: a breaking node renders review-button, a standard
// node renders update-button. The total is the count of outdated components on
// the canvas (breaking-agnostic on purpose).
async function countNodeUpdateIndicators(page: Page): Promise<number> {
  return (
    (await page.getByTestId("review-button").count()) +
    (await page.getByTestId("update-button").count())
  );
}

test.describe("update component action", () => {
  test(
    "applying a single component update refreshes it, decrements the outdated count, and creates a backup",
    { tag: ["@stable", "@regression", "@components", "@ui-ux"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      // Unique per-run host name so the "(Backup)" copy this apply creates can be
      // matched exactly — never a stray "(Backup)" from another run/worker, which
      // would let the backup assertion pass without this apply creating one.
      const hostName = `Update Component Action ${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      let countBefore = 0;

      await test.step("Import the outdated fixture and open it", async () => {
        await importOutdatedFlowAndOpen(page, request, bearer, hostName);
      });

      await test.step("Dismiss the one-time assistant onboarding tooltip if present", async () => {
        // The tooltip overlays the canvas and can intercept the review click.
        const dismiss = page.getByLabel("Dismiss assistant onboarding tooltip");
        if (await dismiss.isVisible({ timeout: 3000 }).catch(() => false)) {
          await dismiss.click();
        }
      });

      await test.step("Record the outdated count and open the first review dialog", async () => {
        countBefore = await readOutdatedCount(page);
        expect(
          countBefore,
          "the fixture should present at least one outdated component",
        ).toBeGreaterThan(0);
        // Per-node indicators must match the banner before we apply anything.
        expect(await countNodeUpdateIndicators(page)).toBe(countBefore);

        await page.getByTestId("review-button").first().click();
        await expect(page.getByTestId("backup-flow-checkbox")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("The review dialog defaults to creating a backup", async () => {
        await expect(page.getByTestId("backup-flow-checkbox")).toHaveAttribute(
          "data-state",
          "checked",
        );
      });

      await test.step("Apply the update via Update Component", async () => {
        // The submit has no testid — match it by role/name (exact to avoid the
        // "Update Components" bulk button).
        await page
          .getByRole("button", { name: "Update Component", exact: true })
          .click();
      });

      await test.step("The outdated count and per-node indicators drop by one", async () => {
        // The banner reflects one fewer outdated component after the apply.
        await expect(
          page.getByText(
            new RegExp(`\\b${countBefore - 1}\\b components? needs? updates?`, "i"),
          ),
        ).toBeVisible({ timeout: 15000 });

        // The per-node indicators refresh consistently with the banner. Applying
        // an update can re-diff the remaining nodes (a breaking review-button may
        // become a non-breaking update-button), so the durable invariant is the
        // total (review + update), not a specific button.
        await expect
          .poll(() => countNodeUpdateIndicators(page), { timeout: 15000 })
          .toBe(countBefore - 1);
      });

      await test.step("A backup flow was created before the update", async () => {
        // The default-on backup persists a "<flow> (Backup)" copy — the safety
        // net the apply action provides. Capture its id for id-scoped cleanup.
        const res = await request.get(
          "/api/v1/flows/?remove_example_flows=true&header_flows=true",
          { headers: { Authorization: bearer } },
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as
          | Array<{ id: string; name: string }>
          | { flows?: Array<{ id: string; name: string }> };
        const flows = Array.isArray(body) ? body : (body.flows ?? []);
        const backup = flows.find((f) => f.name === `${hostName} (Backup)`);
        expect(
          backup,
          "applying the update should create a '(Backup)' flow",
        ).toBeTruthy();
        if (backup?.id) createdFlowIds.push(backup.id);
      });
    },
  );
});
