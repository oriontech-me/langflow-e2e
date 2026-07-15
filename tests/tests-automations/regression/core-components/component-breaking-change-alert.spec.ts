import { readFileSync } from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// A saved flow whose 5 components (Prompt, Chat Input, OpenAI, Chat Output, Chat
// Memory) are pinned behind the current backend version in a *breaking* way, so
// every component resolves to a "Review"-gated breaking update on import. This is
// the deterministic way to produce the outdated+breaking state the §2.3 bullet
// ("Update with breaking change — should alert user") is about — a freshly-added
// component is never outdated on a current nightly.
const OUTDATED_FLOW = path.resolve(
  __dirname,
  "../../../assets/flows/outdated_flow.json",
);

// Track flows created by the drop-import so afterEach deletes them id-scoped
// (repo convention, #490/#681) — never a global cleanAllFlows that would wipe a
// concurrent worker's flow (#465/#515).
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // deleteFlow throws on a failed delete (repo convention #545) so a leak
    // surfaces loudly instead of quietly accumulating. Cleanup is load-bearing
    // here — unlike the rejected-import case, every test creates a real flow —
    // so the throw is intentionally NOT swallowed.
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Drop the fixture onto the flows-page drop zone (cards-wrapper) via a synthetic
// DataTransfer — the same event an OS drag-and-drop fires, and the same import
// mechanism the @stable import-invalid-json spec uses. The flow is renamed with a
// unique per-run suffix so we wait for THIS dropped card, not a bootstrap-seeded
// or sibling-test card.
async function importOutdatedFlowAndOpen(page: Page): Promise<void> {
  await awaitBootstrapTest(page, { skipModal: true });
  await expect(page.getByTestId("mainpage_title")).toBeVisible({
    timeout: 30000,
  });

  const raw = readFileSync(OUTDATED_FLOW, "utf-8");
  const flowName = `Breaking Change Alert ${Date.now()}`;
  const content = JSON.stringify({ ...JSON.parse(raw), name: flowName });

  const dataTransfer = await page.evaluateHandle((d: string) => {
    const dt = new DataTransfer();
    dt.items.add(new File([d], "outdated_flow.json", { type: "application/json" }));
    return dt;
  }, content);
  await page.getByTestId("cards-wrapper").dispatchEvent("drop", { dataTransfer });

  const card = page.getByTestId("list-card").filter({ hasText: flowName });
  await card.waitFor({ state: "visible", timeout: 30000 });
  await card.click();

  // The outdated banner is the frontend's signal that the diff finished
  // computing. Gate on the count-agnostic regex (not a pinned literal) so the
  // shared helper does not silently re-pin the component count the tests
  // deliberately relaxed — matches both the _one ("component needs updates")
  // and _other ("components need updates") i18n plurals.
  await expect(
    page.getByText(/\d+ components? needs? updates?/i),
  ).toBeVisible({ timeout: 30000 });
}

test(
  "breaking-change outdated components alert with a Review action, not a silent Update",
  { tag: ["@stable", "@components", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await test.step("Import the outdated fixture and open it", async () => {
      await importOutdatedFlowAndOpen(page);
    });

    await test.step("At least one outdated component is a breaking change surfaced for Review", async () => {
      // The fixture is a frozen 1.4.0 snapshot with no per-node version; the
      // exact count of outdated/breaking components is emergent from diffing it
      // against the running nightly. So we assert the DURABLE invariant — a
      // breaking update is surfaced via Review, never a one-click silent Update —
      // rather than a pinned count that would false-fail on any benign version
      // bump. `review-button` (vs `update-button`) is the breaking affordance.
      await expect(page.getByTestId("review-button").first()).toBeVisible({
        timeout: 15000,
      });
      const breakingCount = await page.getByTestId("review-button").count();
      expect(breakingCount).toBeGreaterThan(0);

      // The banner reports the outdated total to the user.
      await expect(
        page.getByText(/\d+ components? needs? updates?/i),
      ).toBeVisible();
    });

    await test.step('The toolbar action reads "Review All" (a breaking update is present), not "Update All"', async () => {
      // "Review All" renders iff breakingChanges.length > 0, so it is the
      // toolbar-level signal that the user is being alerted to a breaking update.
      await expect(page.getByTestId("update-all-button")).toHaveText(
        "Review All",
      );
    });
  },
);

test(
  "reviewing a single breaking change warns about disconnection and defaults to a backup",
  { tag: ["@stable", "@components", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await test.step("Import the outdated fixture and open it", async () => {
      await importOutdatedFlowAndOpen(page);
    });

    await test.step("Open the review dialog for a single breaking component", async () => {
      await page.getByTestId("review-button").first().click();
      await expect(page.getByTestId("backup-flow-checkbox")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("The dialog warns the update may disconnect the component", async () => {
      await expect(
        page.getByText(
          /disconnect this component from your flow, requiring you to review or reconnect/i,
        ),
      ).toBeVisible();
    });

    await test.step("Creating a backup is offered and checked by default", async () => {
      await expect(page.getByTestId("backup-flow-checkbox")).toBeVisible();
      await expect(page.getByTestId("backup-flow-checkbox")).toBeChecked();
    });

    // Cancel without applying — this spec asserts the alert, never mutates the flow.
    await page.keyboard.press("Escape");
  },
);

test(
  "Review All flags every outdated component as breaking and pre-selects none",
  { tag: ["@stable", "@components", "@regression", "@ui-ux"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    let breakingCount = 0;
    let nonBreakingCount = 0;

    await test.step("Import the outdated fixture and open it", async () => {
      await importOutdatedFlowAndOpen(page);
      // Breaking components on the canvas = Review buttons; non-breaking =
      // Update buttons. Capture both (emergent from the frozen fixture vs the
      // nightly) so the dialog assertions track them instead of a pinned literal.
      breakingCount = await page.getByTestId("review-button").count();
      nonBreakingCount = await page.getByTestId("update-button").count();
      expect(breakingCount).toBeGreaterThan(0);
    });

    await test.step("Open the Review All dialog", async () => {
      await page.getByTestId("update-all-button").click();
      await expect(page.getByTestId("backup-flow-checkbox")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("Every breaking component is tagged Breaking and a backup is default-on", async () => {
      // One "Breaking" update-type tag per breaking component. `exact: true` is
      // load-bearing: the dialog's warning paragraph contains lowercase
      // "breaking" inside a sentence, which a non-exact match would also catch.
      await expect(page.getByText("Breaking", { exact: true })).toHaveCount(
        breakingCount,
      );
      await expect(page.getByTestId("backup-flow-checkbox")).toBeChecked();
    });

    await test.step("A breaking component is never pre-selected — the user must opt in", async () => {
      // The dialog seeds its selection with the NON-breaking components only
      // (updateComponentModal seeds `components.filter(c => !c.breakingChange)`),
      // so the submit is disabled *exactly when* nothing is pre-selected — the
      // all-breaking case, which forces an explicit opt-in for every update.
      //
      // This assertion is the one place the spec relies on the fixture being
      // ALL breaking; we make that precondition explicit rather than silent, so
      // a future drift to a mixed fixture fails HERE with a clear signal (refresh
      // the fixture — see the frozen-fixture caveat) instead of confusingly at
      // the disabled check.
      expect(nonBreakingCount).toBe(0);
      await expect(
        page.getByRole("button", { name: "Update Components" }),
      ).toBeDisabled();
    });

    // Cancel without applying — no flow state is mutated.
    await page.keyboard.press("Escape");
  },
);
