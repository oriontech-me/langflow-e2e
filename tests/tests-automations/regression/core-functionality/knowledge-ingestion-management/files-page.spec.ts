import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { generateRandomFilename } from "../../../../helpers/filesystem/generate-filename";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Two classes of persistent artifact to clean up id-scoped: every uploaded
// file lands in the user's global /api/v2/files store, and — only on a truly
// empty first-run instance — awaitBootstrapTest creates a Basic Prompting flow.
// Ids come from the create responses (Pattern A), never page.url() (#681).
// Scoped deletion keeps these specs safe under parallel workers (#465).
const createdFileIds: string[] = [];
const createdFlowIds: string[] = [];

function trackCreatedArtifacts(page: Page): void {
  page.on("response", (resp) => {
    const method = resp.request().method();
    const url = resp.url();
    if (
      url.includes("/api/v1/flows") &&
      method === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
    if (
      url.includes("/api/v2/files") &&
      method === "POST" &&
      resp.status() < 300
    ) {
      resp
        .json()
        .then((body: unknown) => {
          const items = Array.isArray(body) ? body : [body];
          for (const item of items) {
            const id = (item as { id?: string })?.id;
            if (id) createdFileIds.push(id);
          }
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

// Gate an upload on the server accepting it: the POST /api/v2/files response is
// the proof the bytes landed, before we assert on the rendered row.
function waitForUpload(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.url().includes("/api/v2/files") &&
      r.request().method() === "POST" &&
      r.status() < 300,
    { timeout: 30000 },
  );
}

async function openMyFiles(page: Page) {
  await awaitBootstrapTest(page, { skipModal: true });
  await expect(page.getByTestId("mainpage_title")).toBeVisible({
    timeout: 30000,
  });
  // The "My Files" sidebar entry carries no testid — click it by text.
  await page.getByText("My Files").first().click();
  await expect(page.getByTestId("mainpage_title")).toContainText("Files", {
    timeout: 30000,
  });
}

test(
  "should navigate to Files page and expose upload affordances",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);

    await openMyFiles(page);

    // Deterministic page chrome — present regardless of how many files the
    // (shared) account holds. The literal "No files" empty-state message is
    // intentionally NOT asserted: it only renders on a zero-file account,
    // which the parallel daily run cannot guarantee.
    await expect(page.getByTestId("upload-file-btn")).toBeVisible();
    await expect(page.getByTestId("search-store-input")).toBeVisible();
    await expect(page.getByTestId("drag-wrap-component")).toBeVisible();
  },
);

test(
  "should upload file using upload button",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);
    const fileName = generateRandomFilename();
    const fileContent = fs.readFileSync(resolveAssetPath("test-file.txt"));

    await openMyFiles(page);

    const uploadDone = waitForUpload(page);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("upload-file-btn").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles([
      { name: `${fileName}.txt`, mimeType: "text/plain", buffer: fileContent },
    ]);
    await uploadDone;

    await expect(page.getByText("File uploaded successfully")).toBeVisible({
      timeout: 15000,
    });
    // Retrying visibility — a one-shot .isVisible() raced the row render and
    // was the pre-promotion flake.
    await expect(page.getByText(`${fileName}.txt`).first()).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "should upload file using drag and drop",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);
    const fileName = generateRandomFilename();

    await openMyFiles(page);

    const uploadDone = waitForUpload(page);
    // Create DataTransfer object and file
    const dataTransfer = await page.evaluateHandle((fileName) => {
      const data = new DataTransfer();
      const file = new File(["test content"], `${fileName}.txt`, {
        type: "text/plain",
      });
      data.items.add(file);
      return data;
    }, fileName);

    await page.dispatchEvent(
      '[data-testid="drag-wrap-component"]',
      "dragover",
      { dataTransfer },
    );
    await page.dispatchEvent('[data-testid="drag-wrap-component"]', "drop", {
      dataTransfer,
    });
    await uploadDone;

    await expect(page.getByText("File uploaded successfully")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(`${fileName}.txt`).last()).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "should upload multiple files with different types",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);
    const fileNames = {
      txt: generateRandomFilename(),
      json: generateRandomFilename(),
      py: generateRandomFilename(),
    };
    const fileContents = [
      resolveAssetPath("test-file.txt"),
      resolveAssetPath("test-file.json"),
      resolveAssetPath("test-file.py"),
    ].map((file) => fs.readFileSync(file));

    await openMyFiles(page);

    const uploadDone = waitForUpload(page);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("upload-file-btn").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles([
      {
        name: `${fileNames.txt}.txt`,
        mimeType: "text/plain",
        buffer: fileContents[0],
      },
      {
        name: `${fileNames.json}.json`,
        mimeType: "application/json",
        buffer: fileContents[1],
      },
      {
        name: `${fileNames.py}.py`,
        mimeType: "text/x-python",
        buffer: fileContents[2],
      },
    ]);
    await uploadDone;

    await expect(page.getByText("Files uploaded successfully")).toBeVisible({
      timeout: 15000,
    });
    // Verify all files appear in the list
    for (const name of Object.values(fileNames)) {
      await expect(page.getByText(name).last()).toBeVisible({ timeout: 15000 });
    }
  },
);

test(
  "should search uploaded files",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);
    const fileNames = {
      txt: generateRandomFilename(),
      json: generateRandomFilename(),
      py: generateRandomFilename(),
    };
    const fileContents = [
      resolveAssetPath("test-file.txt"),
      resolveAssetPath("test-file.json"),
      resolveAssetPath("test-file.py"),
    ].map((file) => fs.readFileSync(file));

    await openMyFiles(page);

    const uploadDone = waitForUpload(page);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("upload-file-btn").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles([
      {
        name: `${fileNames.txt}.txt`,
        mimeType: "text/plain",
        buffer: fileContents[0],
      },
      {
        name: `${fileNames.json}.json`,
        mimeType: "application/json",
        buffer: fileContents[1],
      },
      {
        name: `${fileNames.py}.py`,
        mimeType: "text/x-python",
        buffer: fileContents[2],
      },
    ]);
    await uploadDone;

    await expect(page.getByText("Files uploaded successfully")).toBeVisible({
      timeout: 15000,
    });
    for (const name of Object.values(fileNames)) {
      await expect(page.getByText(name).last()).toBeVisible({ timeout: 15000 });
    }

    const searchInput = page.getByTestId("search-store-input");

    // Search by (unique) name — only the JSON row survives the filter.
    await searchInput.fill(fileNames.json);
    await expect(page.getByText(`${fileNames.json}.json`)).toBeVisible();
    await expect(page.getByText(`${fileNames.txt}.txt`)).toHaveCount(0);
    await expect(page.getByText(`${fileNames.py}.py`)).toHaveCount(0);

    // Search by the Python file's unique stem.
    await searchInput.fill(fileNames.py);
    await expect(page.getByText(`${fileNames.py}.py`)).toBeVisible();
    await expect(page.getByText(`${fileNames.json}.json`)).toHaveCount(0);
    await expect(page.getByText(`${fileNames.txt}.txt`)).toHaveCount(0);

    // Clear search and verify all files are visible again.
    await searchInput.fill("");
    for (const name of Object.values(fileNames)) {
      await expect(page.getByText(name).last()).toBeVisible({ timeout: 15000 });
    }
  },
);

test(
  "should handle bulk actions for multiple files",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    trackCreatedArtifacts(page);
    const fileNames = {
      txt: generateRandomFilename(),
      json: generateRandomFilename(),
      py: generateRandomFilename(),
    };
    const fileContents = [
      resolveAssetPath("test-file.txt"),
      resolveAssetPath("test-file.json"),
      resolveAssetPath("test-file.py"),
    ].map((file) => fs.readFileSync(file));

    await openMyFiles(page);

    const uploadDone = waitForUpload(page);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("upload-file-btn").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles([
      {
        name: `${fileNames.txt}.txt`,
        mimeType: "text/plain",
        buffer: fileContents[0],
      },
      {
        name: `${fileNames.json}.json`,
        mimeType: "application/json",
        buffer: fileContents[1],
      },
      {
        name: `${fileNames.py}.py`,
        mimeType: "text/x-python",
        buffer: fileContents[2],
      },
    ]);
    await uploadDone;

    await expect(page.getByText("Files uploaded successfully")).toBeVisible({
      timeout: 15000,
    });
    for (const name of Object.values(fileNames)) {
      await expect(page.getByText(name).last()).toBeVisible({ timeout: 15000 });
    }

    // Select the three files by their row checkboxes.
    const rowCheckbox = (stem: string) =>
      page
        .locator(".ag-row")
        .filter({ hasText: stem })
        .locator('input[data-ref="eInput"]');

    await rowCheckbox(fileNames.txt).click();
    await rowCheckbox(fileNames.json).click();
    await rowCheckbox(fileNames.py).click();

    await expect(rowCheckbox(fileNames.txt)).toBeChecked();
    await expect(rowCheckbox(fileNames.json)).toBeChecked();
    await expect(rowCheckbox(fileNames.py)).toBeChecked();

    // Bulk toolbar appears once a row is selected.
    const deleteButton = page.getByTestId("bulk-delete-btn");
    await expect(deleteButton).toBeVisible();

    // Deselect the Python file — it must survive the bulk delete.
    await rowCheckbox(fileNames.py).click();
    await expect(rowCheckbox(fileNames.py)).not.toBeChecked();
    await expect(deleteButton).toBeVisible();

    await deleteButton.click();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Files deleted successfully")).toBeVisible({
      timeout: 15000,
    });

    // The two selected files are gone; the deselected Python file remains.
    await expect(page.getByText(`${fileNames.txt}.txt`)).toHaveCount(0);
    await expect(page.getByText(`${fileNames.json}.json`)).toHaveCount(0);
    await expect(page.getByText(`${fileNames.py}.py`).last()).toBeVisible();
  },
);
