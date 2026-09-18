import type { Locator } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";

// Regression guard for upstream langflow-ai/langflow#6989: icons that could not be
// shown got stuck on a loading indicator instead of degrading to a fallback. See
// docs/ui-ux/general-bugs-icons-fallback.md.
//
// Every component icon renders through `ForwardedIconComponent`, which loads each
// lucide icon lazily as its own asset (`/assets/<icon>-<hash>.js`), shows a skeleton
// while it loads, and falls back to an empty `icon-placeholder` div when the load
// fails. The test makes Split Text's icon genuinely not found by refusing that
// asset, then checks both places the icon renders — the sidebar entry and the node.
//
// The inherited version counted `loading-icon` — the `Loading` spinner, which the
// 1.13 icon pipeline never renders — so it passed by construction (#1908).
const MISSING_ICON = "scissors-line-dashed";
const MISSING_ICON_ASSET = new RegExp(
  `/assets/${MISSING_ICON}-[^/]+\\.js(\\?.*)?$`,
);

// The one flow each test creates, deleted id-scoped in afterEach. The inherited
// version went through `awaitBootstrapTest` + `blank-flow` and deleted nothing:
// 3 flows leaked per run on an empty project (#1908).
let createdFlow: { id: string; bearer: string } | undefined;

test.afterEach(async ({ page, request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit this binding.
  const flow = createdFlow;
  createdFlow = undefined;
  if (!flow) return;
  // Leave the editor first: an editor mounted over a deleted flow keeps polling
  // `GET /flows/{id}/events` and 404s into the backend-error log (#1288).
  await unmountEditorForCleanup(page);
  await deleteFlow(request, flow.id, {
    headers: { Authorization: flow.bearer },
  }).catch((error: unknown) => {
    console.warn(
      `general-bugs-icons-fallback: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

/** An icon that loaded: an `svg` carrying `icon-<name>`, and no fallback beside it. */
async function expectLoadedIcon(entry: Locator): Promise<void> {
  await expect(entry.locator('svg[data-testid^="icon-"]').first()).toBeVisible({
    timeout: 15000,
  });
  await expect(entry.getByTestId("icon-placeholder")).toHaveCount(0);
}

test(
  "user must be able to see icons fallback if the icon is not found",
  { tag: ["@stable", "@release", "@regression", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const refused: string[] = [];

    await test.step(`Refuse the browser Split Text's icon asset (${MISSING_ICON})`, async () => {
      // Registered before the editor loads, so the icon's first request is refused.
      await page.route(MISSING_ICON_ASSET, async (route) => {
        refused.push(route.request().url());
        await route.abort();
      });
    });

    await test.step("Open a blank flow created over the API", async () => {
      const bearer = await getAuthToken(request);
      const id = await createFlow(
        request,
        {
          name: `Icons Fallback ${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 7)}`,
          description: "",
          data: { nodes: [], edges: [] },
          is_component: false,
        },
        { headers: { Authorization: bearer } },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
    });

    const splitTextEntry = page.getByTestId("processingSplit Text");
    const parserEntry = page.getByTestId("processingParser");
    const apiRequestEntry = page.getByTestId("data_sourceAPI Request");

    await test.step("Expand the data sources and processing categories", async () => {
      await page.getByTestId("disclosure-data sources").click();
      await page.getByTestId("disclosure-processing").click();
      await expect(splitTextEntry).toBeVisible({ timeout: 15000 });
      await expect(parserEntry).toBeVisible();
      await expect(apiRequestEntry).toBeVisible();
    });

    await test.step("Premise: the icon is its own asset, and it was requested and refused", async () => {
      await expect
        .poll(() => refused.length, {
          message: `no request matched ${MISSING_ICON_ASSET} — Split Text's icon is no longer loaded as its own asset (or no longer ${MISSING_ICON}); re-point the route`,
          timeout: 15000,
        })
        .toBeGreaterThan(0);
    });

    await test.step("The sidebar entry keeps its name and settles on the fallback", async () => {
      await expect(splitTextEntry.getByTestId("display-name")).toHaveText(
        "Split Text",
      );
      // A skeleton that never resolves never becomes the placeholder — #6989.
      await expect(splitTextEntry.getByTestId("icon-placeholder")).toBeVisible({
        timeout: 15000,
      });
      await expect(splitTextEntry.getByTestId(`icon-${MISSING_ICON}`)).toHaveCount(0);
    });

    await test.step("The failure is contained — the other entries keep their icons", async () => {
      await expectLoadedIcon(parserEntry);
      await expectLoadedIcon(apiRequestEntry);
    });

    await test.step("Split Text is still usable, and its node shows the same fallback", async () => {
      await addComponentFromSidebar(
        page,
        "split text",
        "add-component-button-split-text",
      );
      const node = page
        .locator(".react-flow__node")
        .filter({ has: page.getByTestId("title-Split Text") });
      await expect(page.getByTestId("title-Split Text")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await expect(node.getByTestId("icon-placeholder")).toBeVisible({
        timeout: 15000,
      });
      await expect(node.getByTestId(`icon-${MISSING_ICON}`)).toHaveCount(0);
    });
  },
);
