import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";
import { generateRandomFilename } from "../../../../helpers/filesystem/generate-filename";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Unique file content — the output must equal this exact string, so an
// accidental match is impossible.
const SENTINEL = "This is a test file for upload functionality testing.";
const ASSET = "test-file.txt";

// Two persistent artifacts to clean up id-scoped: the flow AND the uploaded
// file (it lands in the user's global /api/v2/files store). Both ids come from
// the create responses (Pattern A) — never page.url() for the flow, which
// returns the stale bootstrap flow id because awaitBootstrapTest creates a
// competing flow before the blank-flow click (#681).
//
// The file cleanup used to sweep every file whose name started with the asset
// stem. That is a cross-worker wipe on the shard's shared account (#465), and it
// papered over the real problem: uploading a FIXED name at all. POST
// /api/v2/files enforces unique names with a prefix query
// (`name LIKE '<stem>%'`), so a single residue row renames the upload to
// "<stem> (1)" and every name-derived testid built from the local asset name
// misses — which is exactly how the daily of 2026-07-30 failed (#1125). The
// upload therefore carries a random per-run stem and the testids are derived
// from the name the SERVER returns.
const createdFlowIds: string[] = [];
const createdFileIds: string[] = [];

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
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
  for (const id of createdFileIds.splice(0)) {
    await request
      .delete(`/api/v2/files/${id}`, { headers: { Authorization: bearer } })
      .catch(() => {});
  }
});

test(
  "upload a file through the Read File component and read its content",
  { tag: ["@stable", "@release", "@files", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    // The asset's bytes under a per-run unique name: the name is what the
    // server's uniqueness check (and every testid below) keys on.
    const stem = generateRandomFilename();
    const buffer = fs.readFileSync(resolveAssetPath(ASSET));
    // Filled from the upload response — the server is the authority on the
    // stored name, so the testids are built from it and not from `stem`.
    let uploadedName = "";

    // In-flight `GET /api/v2/files` requests. The list is the only input to the
    // node chip, so "no list request pending" is the observable that the cache
    // the chip reads from will not be overwritten under the confirm (#1430).
    let inFlightFileLists = 0;
    const isFileList = (method: string, url: string): boolean =>
      `${method} ${new URL(url).pathname}` === "GET /api/v2/files";
    page.on("request", (req) => {
      inFlightFileLists += Number(isFileList(req.method(), req.url()));
    });
    const settle = (req: { method(): string; url(): string }): void => {
      inFlightFileLists -= Number(isFileList(req.method(), req.url()));
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);

    await awaitBootstrapTest(page);

    await test.step("open a blank flow", async () => {
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();
      await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
    });

    await test.step("add the Read File component to the canvas", async () => {
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("Read File");
      await expect(
        page.getByTestId("add-component-button-read-file"),
      ).toBeVisible({ timeout: 15000 });
      await page.getByTestId("add-component-button-read-file").click();
      await expect(page.getByTestId("title-Read File")).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("upload the local file through the file-management modal", async () => {
      await page.getByTestId("button_open_file_management").click();
      await expect(page.getByTestId("drag-files-component")).toBeVisible({
        timeout: 15000,
      });
      // Clicking the dropzone opens a native file chooser.
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByTestId("drag-files-component").click(),
      ]);
      // Gate on the upload actually completing server-side: clicking
      // "select" before the POST /api/v2/files response lands leaves the file
      // not-yet-selectable and the confirm is a no-op, so the modal never
      // closes.
      const uploadDone = page.waitForResponse(
        (r) =>
          r.url().includes("/api/v2/files") &&
          r.request().method() === "POST" &&
          r.status() < 300,
        { timeout: 30000 },
      );
      await chooser.setFiles([
        { name: `${stem}.txt`, mimeType: "text/plain", buffer },
      ]);
      const uploaded: { id?: string; name?: string } = await (
        await uploadDone
      ).json();
      // Both fields are load-bearing, so neither is treated as optional: `id`
      // is the only handle the afterEach cleanup has — dropping it silently
      // leaks the upload into the shard's shared account, which is the very
      // residue that broke this spec (#1125) — and `name` is what every testid
      // below is built from. Register the id before asserting anything else, so
      // a later failure still cleans up.
      expect(
        uploaded.id,
        "the upload response must carry the file id",
      ).toBeTruthy();
      createdFileIds.push(uploaded.id as string);
      // Equality, not just presence: the stem is random, so the server's
      // uniqueness branch must not have fired. Asserting it keeps the
      // unique-name guard falsifiable — the testids below are still built from
      // the response (the server is the authority on the stored name), and
      // without this the spec would silently follow a rename instead of
      // reporting that the account already holds a colliding row. Same
      // assertion as file-types-upload.spec.ts.
      expect(
        uploaded.name,
        "the upload must keep its per-run unique stem — a rename means the shared account already holds a colliding row (#1125)",
      ).toBe(stem);
      uploadedName = uploaded.name as string;

      // The uploaded file appears in My Files, pre-selected. The visible row is
      // NOT enough: the optimistic cache entry renders the same testid while it
      // is still `pointer-events-none`, and the row is keyed on the file name
      // while the modal's selection is keyed on the file PATH. A checked box is
      // the only proof that the two agree — i.e. that confirming attaches THIS
      // file (#1125).
      await expect(page.getByTestId(`file-item-${uploadedName}`)).toBeVisible({
        timeout: 15000,
      });
      await expect(
        page.getByTestId(`checkbox-${uploadedName}`),
      ).toHaveAttribute("data-state", "checked", { timeout: 15000 });

      // Confirm only once the file list has settled. The node chip is a
      // projection of the `useGetFilesV2` cache — `files.filter(f =>
      // selectedFiles.includes(f.path))` — and a reconcile effect rewrites the
      // node's value/file_path from that same cache. Until langflow#14541 ONE
      // list response that landed without this file wiped the attachment
      // outright (#1430 / LE-2208, measured 5/5 by stripping a single response).
      // The upload's invalidation refetch is still in flight ~20 ms after the
      // POST here, and confirming into that window is exposure the test creates,
      // not exposure it is testing — which is why the gate stays now that the
      // product no longer wipes.
      //
      // What is NO LONGER true, and was the reason to re-read this comment: a
      // list response arriving after the confirm does not wipe the attach any
      // more. The reconcile now forces a fresh read before dropping a path it
      // cannot find, so a lagging response costs one extra GET and nothing else.
      // Measured with `docs/upstream-bugs/scripts/repro-2208-stale-file-list.spec.ts`
      // — one stripped list response destroys the attachment on 1.12.0.dev25
      // (2/2) and leaves it intact on dev26 and dev30.
      await expect
        .poll(() => inFlightFileLists, {
          timeout: 15000,
          message:
            "a GET /api/v2/files was still in flight when the selection was confirmed (#1430)",
        })
        .toBe(0);
      await expect(
        page.getByTestId(`checkbox-${uploadedName}`),
        "the settled file list must still hold the uploaded file — a list response that drops it wipes the attachment (#1430)",
      ).toHaveAttribute("data-state", "checked");

      await page.getByTestId("select-files-modal-button").click();
    });

    await test.step("the file is attached to the component", async () => {
      // Wait for the file-management modal to close (its confirm button is
      // modal-only, so its disappearance is the close signal — unlike
      // drag-files-component, which also exists on the node) before asserting
      // the node chip. The chip is client state, not the tail of a request:
      // measured at 43–241 ms after the close over 13 clean cycles, and it
      // still renders with `custom_component/update` stalled 25 s or aborted
      // (#1430). So an absent chip here is a dropped attachment, never a slow
      // one — do not answer it with a longer timeout. The remove button is
      // hover-revealed, so the persistent chip is the stable signal.
      //
      // This assertion is what the LE-2208 wipe fired on, and it stays the
      // guard for a re-regression of it: on 1.12.0.dev25 the chip renders and
      // then disappears, which is a failure here and not a timeout.
      await expect(
        page.getByTestId("select-files-modal-button"),
      ).toBeHidden({ timeout: 15000 });
      await expect(page.getByTestId(`file-item-${uploadedName}`)).toBeVisible({
        timeout: 15000,
      });
    });

    await test.step("running the component reads back the file's exact content", async () => {
      await page.getByTestId("button_run_read file").click();
      // Successful build badge — the deterministic completion signal.
      await expect(page.getByTestId("node_duration_read file")).toBeVisible({
        timeout: 60000,
      });

      await page.getByTestId("output-inspection-raw content-file").click();
      // The output is the file's raw content, rendered in the inspector's
      // textarea. It must equal the unique sentinel exactly.
      await expect(page.locator("textarea").first()).toHaveValue(SENTINEL, {
        timeout: 15000,
      });
    });
  },
);
