import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";
import { generateRandomFilename } from "../../../../helpers/filesystem/generate-filename";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// §5.1 — Upload files of DIFFERENT types (txt, pdf, json, py, wav) through the
// My Files page. The canvas Read File component enforces a VALID_EXTENSIONS
// allow-list that excludes wav, so binary/audio type coverage can only live on
// the Files page, whose POST /api/v2/files enforces no extension allow-list.
// One test() per type keeps each type independently falsifiable.
const FILE_TYPES = [
  { ext: "txt", asset: "test-file.txt", mime: "text/plain" },
  { ext: "pdf", asset: "test-file.pdf", mime: "application/pdf" },
  { ext: "json", asset: "test-file.json", mime: "application/json" },
  { ext: "py", asset: "test-file.py", mime: "text/x-python" },
  { ext: "wav", asset: "test_audio_file.wav", mime: "audio/wav" },
] as const;

// Two persistent artifacts to clean up id-scoped: the uploaded file (it lands
// in the user's global /api/v2/files store) and — only on a truly empty
// first-run instance — the Basic Prompting flow that awaitBootstrapTest
// creates. Flow ids come from POST /api/v1/flows 201 responses (Pattern A),
// never page.url() (#681).
const createdFileIds: string[] = [];
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
  const bearer = await getAuthToken(request);
  for (const id of createdFileIds.splice(0)) {
    await request
      .delete(`/api/v2/files/${id}`, { headers: { Authorization: bearer } })
      .catch(() => {});
  }
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(
      () => {},
    );
  }
});

for (const { ext, asset, mime } of FILE_TYPES) {
  test(
    `upload a ${ext} file through the Files page`,
    { tag: ["@stable", "@release", "@files"] },
    async ({ page }) => {
      trackCreatedFlows(page);
      // Unique stem so an accidental match with a pre-existing file is
      // impossible and parallel workers never collide.
      const stem = generateRandomFilename();
      const buffer = fs.readFileSync(resolveAssetPath(asset));

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open the My Files page", async () => {
        await expect(page.getByTestId("mainpage_title")).toBeVisible({
          timeout: 30000,
        });
        // The "My Files" sidebar entry carries no testid — click it by text.
        await page.getByText("My Files").first().click();
        await expect(page.getByTestId("mainpage_title")).toContainText(
          "Files",
          { timeout: 30000 },
        );
      });

      let uploaded: { id?: string; name?: string; path?: string } = {};
      await test.step(`upload the ${ext} file via the Upload button`, async () => {
        // Gate on the upload completing server-side: the response body is the
        // proof the type was accepted and its extension preserved.
        const uploadDone = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v2/files") &&
            r.request().method() === "POST" &&
            r.status() < 300,
          { timeout: 30000 },
        );
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          page.getByTestId("upload-file-btn").click(),
        ]);
        await chooser.setFiles({
          name: `${stem}.${ext}`,
          mimeType: mime,
          buffer,
        });
        const resp = await uploadDone;
        uploaded = await resp.json();
        if (uploaded?.id) createdFileIds.push(uploaded.id);
      });

      await test.step("the stored record preserves the file type/extension", async () => {
        // Langflow strips the extension from `name` and keeps the full
        // filename (with extension) in `path` — the distinctive, type-specific
        // observable.
        expect(uploaded.name).toBe(stem);
        expect(uploaded.path ?? "").toMatch(new RegExp(`\\.${ext}$`));
      });

      await test.step("the uploaded file appears in the Files list", async () => {
        await expect(
          page.getByText(`${stem}.${ext}`).first(),
        ).toBeVisible({ timeout: 15000 });
      });
    },
  );
}
