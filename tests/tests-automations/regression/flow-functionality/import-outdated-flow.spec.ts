import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Frozen fixture: a flow whose 5 components (Prompt, Chat Input, OpenAI, Chat
// Output, Chat Memory) are pinned to a 1.4.0-era snapshot, old enough to resolve
// to outdated updates on the current nightly. Shared with
// core-components/outdated-component-notification.spec.ts — the outdated total is
// emergent from diffing this snapshot against the nightly, so this spec asserts
// the notification count-agnostically (the count integrity is that spec's job).
const OUTDATED_FLOW = path.join(
  __dirname,
  "../../../assets/flows/outdated_flow.json",
);

// Ids of flows created by THIS page's own UI upload, captured from the
// POST /api/v1/flows response and deleted id-scoped in afterEach (#490/#681) —
// never a global cleanAllFlows that would wipe a concurrent worker's flow.
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const headers = { Authorization: await getAuthToken(request) };
  for (const id of createdFlowIds.splice(0)) {
    // Best-effort per-flow so one failure does not abort the sweep.
    await deleteFlow(request, id, { headers }).catch(() => {});
  }
});

test(
  "importing an outdated flow via the UI upload button surfaces the outdated notification on open",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    let importedFlowId: string | undefined;

    await test.step("Bootstrap the flows page", async () => {
      await awaitBootstrapTest(page, { skipModal: true });
      await expect(page.getByTestId("mainpage_title")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Import the outdated fixture through the upload button", async () => {
      await expect(page.getByTestId("upload-project-button").last()).toBeVisible(
        { timeout: 10000 },
      );

      // Capture the created flow's id from the upload's POST response. The UI
      // upload mints a FRESH id (verified live it does not reuse the fixture's
      // frozen id), so this is parallel-safe and lets us open THIS run's flow by
      // id rather than by the fixture's frozen "Memory Chatbot" card name.
      const flowCreationPromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/v1/flows") &&
          resp.request().method() === "POST" &&
          resp.ok(),
        { timeout: 30000 },
      );

      const fileChooserPromise = page.waitForEvent("filechooser", {
        timeout: 10000,
      });
      await page.getByTestId("upload-project-button").last().click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(OUTDATED_FLOW);

      const created = (await flowCreationPromise.then((r) => r.json())) as {
        id?: string;
      };
      importedFlowId = created.id;
      expect(
        importedFlowId,
        "upload POST /api/v1/flows must return the created flow id",
      ).toBeTruthy();
      createdFlowIds.push(importedFlowId as string);
    });

    await test.step("The outdated payload is ingested without error", async () => {
      // The import mechanism accepts the outdated content — an old flow is still
      // a valid, importable flow.
      await expect(page.getByText("uploaded successfully")).toBeVisible({
        timeout: 60000,
      });
    });

    await test.step("Opening the imported flow raises the outdated notification", async () => {
      // Open by captured id (deterministic; the card name is frozen and would be
      // ambiguous under parallelism). The outdated diff computes on open.
      await page.goto(`/flow/${importedFlowId}`);

      // Flow-level banner. Count-agnostic (the fixture's outdated total is
      // emergent from diffing its 1.4.0 snapshot against the nightly) — matches
      // both the _one and _other i18n plurals.
      await expect(
        page.getByText(/\d+ components? needs? updates?/i),
      ).toBeVisible({ timeout: 30000 });

      // The toolbar bulk CTA that accompanies the notification. Its label is
      // "Review All" when a breaking update is present and "Update All"
      // otherwise; assert either so a benign breaking↔non-breaking flip does not
      // false-fail (the breaking-vs-not distinction is a sibling spec's concern).
      const updateAll = page.getByTestId("update-all-button");
      await expect(updateAll).toBeVisible();
      await expect(updateAll).toHaveText(/Review All|Update All/);
    });
  },
);
