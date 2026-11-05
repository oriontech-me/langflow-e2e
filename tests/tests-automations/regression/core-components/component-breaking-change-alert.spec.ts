import { readFileSync } from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

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

// Every flow the page creates — the bootstrap's and the drop-import's — tracked
// from before the bootstrap so afterEach deletes them id-scoped (repo convention,
// #490/#681) — never a global cleanAllFlows that would wipe a concurrent worker's
// flow (#465/#515).
let flows: FlowTracker | undefined;

test.afterEach(async ({ request }) => {
  const tracker = flows;
  flows = undefined;
  // `strict`: a failed delete fails the teardown (repo convention #545) so a leak
  // surfaces loudly instead of quietly accumulating. Cleanup is load-bearing
  // here — unlike the rejected-import case, every test creates a real flow — so
  // the throw is intentionally NOT swallowed. It comes after the whole sweep.
  await tracker?.cleanup(request, { strict: true });
});

// Drop the fixture onto the flows-page drop zone (cards-wrapper) via a synthetic
// DataTransfer — the same event an OS drag-and-drop fires, and the same import
// mechanism the @stable import-invalid-json spec uses. The flow is renamed with a
// unique per-run suffix so we wait for THIS dropped card, not a bootstrap-seeded
// or sibling-test card.
// The outdated/breaking diff is computed against the frontend's component
// registry, fetched once at app bootstrap. Arm the wait BEFORE the app boots —
// the response can land while the flows page is still rendering, and a waiter
// attached afterwards would miss it and then block for its whole timeout.
const REGISTRY_RE = /\/api\/v1\/all\b/;
// The registry rebuild is the environment's cost, not the product's: the daily
// pins the backend to one worker while two Playwright workers share it, so this
// bound is deliberately generous. The assertion on the banner stays tight.
const REGISTRY_TIMEOUT = 120000;

async function importOutdatedFlowAndOpen(page: Page): Promise<void> {
  const registryLoaded = page
    .waitForResponse((r) => REGISTRY_RE.test(r.url()) && r.ok(), {
      timeout: REGISTRY_TIMEOUT,
    })
    .catch(() => null);

  await awaitBootstrapTest(page, { skipModal: true });
  await expect(page.getByTestId("mainpage_title")).toBeVisible({
    timeout: 30000,
  });

  const raw = readFileSync(OUTDATED_FLOW, "utf-8");
  // Random suffix as well as the clock: the three tests run on two workers, and two
  // imports landing in the same millisecond under the same name are refused by
  // `POST /api/v1/flows/upload/` with an unmapped 500 (measured on 1.13.1 and
  // 1.14.0.dev18, #2399) that the frontend then retries — a detour, not a failure,
  // but noise in the backend-error log this spec should never cause.
  const flowName = `Breaking Change Alert ${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const content = JSON.stringify({ ...JSON.parse(raw), name: flowName });

  const dataTransfer = await page.evaluateHandle((d: string) => {
    const dt = new DataTransfer();
    dt.items.add(new File([d], "outdated_flow.json", { type: "application/json" }));
    return dt;
  }, content);

  // Armed AFTER bootstrap on purpose: on an empty instance the bootstrap helper
  // creates a "Basic Prompting" flow of its own, and that flow would otherwise
  // be the one read here. Its ids are a subset of the file-level tracker's, so it
  // is disposed, never cleaned up.
  //
  // Which response carries the id depends on the version under test (#2399): one
  // `POST /api/v1/flows/` answering the flow (≤ 1.13), or one
  // `POST /api/v1/flows/upload/` answering an ARRAY (≥ 1.14.0.dev18,
  // langflow-ai/langflow#16120). Waiting for the first contract alone is what
  // timed all three tests out on 2026-11-05 with the card on screen.
  const imported = trackCreatedFlows(page);
  let flowId: string;
  try {
    await page.getByTestId("cards-wrapper").dispatchEvent("drop", { dataTransfer });
    // A single-flow file imports exactly ONE flow — the shared import gate.
    await expect
      .poll(
        async () => {
          await imported.settle();
          return imported.ids().length;
        },
        { timeout: 60000, message: "flows the drop created" },
      )
      .toBe(1);
    [flowId] = imported.ids();
  } finally {
    imported.dispose();
  }

  // Navigate by id instead of clicking the imported card. Clicking made the
  // test depend on the flows LIST — its length, its order, and whatever the
  // bootstrap helper is doing to it — and that dependency is what broke on
  // 2026-07-27 and 07-29: on an empty instance the bootstrap creates a "Basic
  // Prompting" flow from a template and bounces through it, and the click then
  // opened THAT flow instead of the import. A flow with no outdated components
  // shows no banner, so the wait expired with "element(s) not found" and the
  // retry passed because the instance was no longer empty (#1061; the three
  // failing error-contexts all show the Basic Prompting editor).
  await page.goto(`/flow/${flowId}`);

  // Opening the flow is what triggers the registry fetch — the editor mounting,
  // not the app booting, asks for /api/v1/all. Wait on that DEPENDENCY rather
  // than on the derived banner: the banner appears ≈ registry duration + 1 s
  // (measured: an 8 s stall renders it at 8.9 s, a 20 s stall at 21.0 s), so a
  // fixed window on the banner alone is a bet on how loaded the backend is.
  if ((await registryLoaded) === null) {
    throw new Error(
      `the component registry (GET /api/v1/all) did not respond within ${REGISTRY_TIMEOUT}ms — the backend is the blocker, not the breaking-change alert`,
    );
  }

  // The outdated banner is the frontend's signal that the diff finished
  // computing. Gate on the count-agnostic regex (not a pinned literal) so the
  // shared helper does not silently re-pin the component count the tests
  // deliberately relaxed — matches both the _one ("component needs updates")
  // and _other ("components need updates") i18n plurals.
  //
  // 15 s, tighter than the 30 s it replaces: with the registry already in the
  // store the banner is ~1 s away, so a missing banner is a real defect and
  // should fail fast instead of hiding behind a long wait.
  await expect(
    page.getByText(/\d+ components? needs? updates?/i),
  ).toBeVisible({ timeout: 15000 });
}

test(
  "breaking-change outdated components alert with a Review action, not a silent Update",
  { tag: ["@stable", "@components", "@regression", "@ui-ux"] },
  async ({ page }) => {
    flows = trackCreatedFlows(page);

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
    flows = trackCreatedFlows(page);

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
    flows = trackCreatedFlows(page);

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
