import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach. awaitBootstrapTest runs
// first, so a bare page.url() capture races the bootstrap flow's stale id
// (#490/#681); the response ids are authoritative and worker-safe.
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
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

// Quarantined at triage (daily #1517): recurrent flake — `input_outputChat Input`
// never becomes visible after sidebar-search-input.fill("chat input"). Same
// signature on the 2026-08-19 and 08-20 dailies. Lifting the quarantine (remove
// test.fixme + restore @stable) is a deliverable of #1518.
test.fixme(
  "user should not be able to upload a file larger than the limit",
  { tag: ["@release", "@api", "@files"] },
  async ({ page }) => {
    // A tiny upload ceiling (0.001 MB ≈ 1.02 KB) so any real asset is rejected.
    const maxFileSizeUpload = 0.001;
    await page.route("**/api/v1/config", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          max_file_size_upload: maxFileSizeUpload,
        }),
        headers: {
          "content-type": "application/json",
          ...route.request().headers(),
        },
      });
    });

    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await test.step("open a blank flow and add a Chat Input", async () => {
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("sidebar-search-input").fill("chat input");
      await expect(
        page.getByTestId("input_outputChat Input"),
      ).toBeVisible({ timeout: 30000 });

      // The Chat Input row briefly toggles pointer-events-none; hover its
      // draggable wrapper (which always takes pointer events) and add via the
      // button (chained so the hover holds).
      await page
        .getByTestId("input_output_chat input_draggable")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-chat-input").click();
        });
    });

    await test.step("open the playground", async () => {
      await page.getByTestId("playground-btn-flow-io").click();
      await expect(page.getByTestId("input-chat-playground")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("an oversized file is rejected with the computed ceiling", async () => {
      // The file-size guard is client-side (driven by the mocked config), so no
      // flow run — and no provider — is needed. chain.png (~32 KB) is well over
      // the 1.02 KB ceiling.
      await page
        .locator('input[type="file"]')
        .setInputFiles(resolveAssetPath("chain.png"));

      const ceilingKb = (maxFileSizeUpload * 1024).toFixed(2);
      await expect(
        page.getByText(
          `The file size is too large. Please select a file smaller than ${ceilingKb} KB`,
        ),
      ).toBeVisible({ timeout: 10000 });
    });
  },
);
