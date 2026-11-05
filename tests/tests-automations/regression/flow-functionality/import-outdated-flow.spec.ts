import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

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

// Every flow the PAGE creates, tracked from before the bootstrap and deleted
// id-scoped in afterEach (#490/#681) — never a global cleanAllFlows that would
// wipe a concurrent worker's flow, and a parallel worker's bootstrap creates
// different ids. The bootstrap's flows are part of it on purpose:
// `awaitBootstrapTest` creates `New Flow` plus a `Basic Prompting` when the
// project is empty, and capturing only the upload response left those two behind
// on every run -- green path as well as red (#1787, measured on 1.13.0.dev8).
let flows: FlowTracker | undefined;

test.afterEach(async ({ request }) => {
  const tracker = flows;
  flows = undefined;
  // Default (non-strict) mode: a failed delete is logged and returned, never
  // fails the test — the same best-effort sweep the hand-rolled loop had.
  await tracker?.cleanup(request);
});

test(
  "importing an outdated flow via the UI upload button surfaces the outdated notification on open",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    let importedFlowId: string | undefined;
    // Only the flows the UPLOAD created: attached after the bootstrap, so the
    // bootstrap's creates cannot be mistaken for the import. Its ids are a subset
    // of `flows`'s, so it is disposed, never cleaned up.
    let imported: FlowTracker | undefined;

    await test.step("Bootstrap the flows page", async () => {
      flows = trackCreatedFlows(page);
      await awaitBootstrapTest(page, { skipModal: true });
      await expect(page.getByTestId("mainpage_title")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("Import the outdated fixture through the upload button", async () => {
      await expect(page.getByTestId("upload-project-button").last()).toBeVisible(
        { timeout: 10000 },
      );

      // Capture the created flow's id from the import's response. The UI upload
      // mints a FRESH id (verified live it does not reuse the fixture's frozen
      // id), so this is parallel-safe and lets us open THIS run's flow by id
      // rather than by the fixture's frozen "Memory Chatbot" card name.
      //
      // Which response that is depends on the version under test (#2399): one
      // `POST /api/v1/flows/` answering the flow (≤ 1.13), or one
      // `POST /api/v1/flows/upload/` answering an ARRAY of flows (≥ 1.14.0.dev18,
      // langflow-ai/langflow#16120). The tracker reads both.
      imported = trackCreatedFlows(page);

      const fileChooserPromise = page.waitForEvent("filechooser", {
        timeout: 10000,
      });
      await page.getByTestId("upload-project-button").last().click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(OUTDATED_FLOW);

      // A single-flow file imports exactly ONE flow; zero or two is a defect,
      // not an id to pick from.
      await expect
        .poll(
          async () => {
            await imported!.settle();
            return imported!.ids().length;
          },
          { timeout: 30000, message: "flows the upload created" },
        )
        .toBe(1);
      importedFlowId = imported.ids()[0];
    });

    await test.step("The outdated payload is ingested without error", async () => {
      // The import mechanism accepts the outdated content — an old flow is still
      // a valid, importable flow.
      await expect(page.getByText("uploaded successfully")).toBeVisible({
        timeout: 60000,
      });
      // The toast is the importer's end: re-read so a second flow created after
      // the first one landed still fails "exactly one".
      await imported!.settle();
      expect(imported!.ids(), "the upload created exactly one flow").toEqual([
        importedFlowId,
      ]);
      imported!.dispose();
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
