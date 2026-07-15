import { readFileSync } from "fs";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// A saved flow whose 5 components (Prompt, Chat Input, OpenAI, Chat Output, Chat
// Memory) are pinned to a 1.4.0-era snapshot, old enough that all resolve to
// outdated updates on the current nightly. A freshly-added component is never
// outdated on a current nightly, so importing this pinned fixture is the only
// deterministic way to produce the outdated-component notification. Shared with
// the sibling component-breaking-change-alert.spec.ts.
const OUTDATED_FLOW = path.resolve(
  __dirname,
  "../../../assets/flows/outdated_flow.json",
);

// Ids of flows created via the API so afterEach deletes them id-scoped (repo
// convention, #490/#681) — never a global cleanAllFlows that would wipe a
// concurrent worker's flow (#465/#515).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // deleteFlow throws on a failed delete (repo convention #545) so a leak
    // surfaces loudly. Cleanup is load-bearing here — every test creates a real
    // flow — so the throw is intentionally NOT swallowed.
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Import the fixture via the REST API (deterministic — unlike a UI drag-and-drop,
// which on a fresh empty instance races with the empty-page bootstrap that
// auto-seeds and opens a starter flow) and open it by navigating straight to
// /flow/<id>. The outdated diff is computed on open regardless of how the flow
// was imported, so this is a faithful, isolated setup for the notification. The
// flow is renamed with a unique per-run suffix so cleanup and any name-based
// lookup target THIS run's flow.
async function importOutdatedFlowAndOpen(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const bearer = await getAuthToken(request);
  // Drop the fixture's own `id` and `endpoint_name`: both are unique keys, so
  // POSTing them verbatim reuses the frozen id (03bae731…) and endpoint, which
  // collides with any concurrent worker or a leaked flow and 500s. Stripping
  // them lets the backend mint a fresh id per create — parallel-safe and
  // independent of prior cleanup.
  const raw = JSON.parse(readFileSync(OUTDATED_FLOW, "utf-8"));
  delete raw.id;
  delete raw.endpoint_name;
  const flowName = `Outdated Notification ${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const flowId = await createFlow(
    request,
    { ...raw, name: flowName },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);

  // The count banner is the frontend's signal that the outdated diff finished
  // computing on open. Gate on the count-agnostic regex (not a pinned literal)
  // so a benign version bump does not re-pin the deliberately-relaxed component
  // count — matches both the _one ("component needs updates") and _other
  // ("components need updates") i18n plurals.
  await expect(
    page.getByText(/\d+ components? needs? updates?/i),
  ).toBeVisible({ timeout: 30000 });
}

test(
  "importing a flow with outdated components raises the flow-level outdated notification",
  { tag: ["@stable", "@regression", "@components", "@observability"] },
  async ({ page, request }) => {
    await test.step("Import the outdated fixture and open it", async () => {
      await importOutdatedFlowAndOpen(page, request);
    });

    await test.step("The canvas shows the aggregate outdated count banner", async () => {
      // The flow-level notification: "N components need updates". Count-agnostic
      // (see the frozen-fixture caveat in the spec doc) — the fixture's outdated
      // total is emergent from diffing its 1.4.0 snapshot against the nightly.
      await expect(
        page.getByText(/\d+ components? needs? updates?/i),
      ).toBeVisible();
    });

    await test.step("The toolbar offers a bulk update-all action", async () => {
      // The toolbar CTA that accompanies the notification. Its label is
      // "Review All" when a breaking update is present and "Update All"
      // otherwise; assert either so a benign breaking↔non-breaking flip does not
      // false-fail this notification test (the breaking-vs-not distinction is the
      // sibling breaking-change spec's concern).
      const updateAll = page.getByTestId("update-all-button");
      await expect(updateAll).toBeVisible();
      await expect(updateAll).toHaveText(/Review All|Update All/);
    });
  },
);

test(
  "the outdated-notification count matches the per-node update indicators",
  { tag: ["@stable", "@regression", "@components", "@observability"] },
  async ({ page, request }) => {
    await test.step("Import the outdated fixture and open it", async () => {
      await importOutdatedFlowAndOpen(page, request);
    });

    await test.step("The banner total equals the number of per-node update indicators", async () => {
      // Parse N from the banner ("N components need updates").
      const bannerText = await page
        .getByText(/\d+ components? needs? updates?/i)
        .first()
        .textContent();
      const match = bannerText?.match(/(\d+)\s+components?\s+needs?\s+updates?/i);
      const bannerCount = Number(match?.[1] ?? 0);

      // Per-node update indicators: a breaking node renders review-button, a
      // standard node renders update-button. Every outdated node renders exactly
      // one, so their sum is the count of outdated components on the canvas.
      // Breaking-agnostic on purpose — this test asserts the notification is
      // internally consistent, not which update type each node has.
      const reviewCount = await page.getByTestId("review-button").count();
      const updateCount = await page.getByTestId("update-button").count();
      const nodeIndicatorCount = reviewCount + updateCount;

      // At least one component must be outdated for the notification to exist —
      // if this fails, the fixture is no longer behind the nightly (refresh it,
      // see the frozen-fixture caveat), not a product regression.
      expect(
        bannerCount,
        "banner should report at least one outdated component",
      ).toBeGreaterThan(0);

      // The notification-integrity invariant: the aggregate the user reads in
      // the banner must match the per-node indicators exactly — no phantom count
      // and no un-notified outdated node.
      expect(
        nodeIndicatorCount,
        "per-node update indicators (review-button + update-button) must match the banner count",
      ).toBe(bannerCount);
    });
  },
);
