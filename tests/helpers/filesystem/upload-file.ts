import type { Page } from "@playwright/test";
import fs from "fs";
import { expect } from "../../fixtures/fixtures";
import { generateRandomFilename } from "./generate-filename";
import { resolveAssetPath } from "./resolve-asset-path";
import { unselectNodes } from "../ui/unselect-nodes";
import { adjustScreenView } from "../ui/adjust-screen-view";

// Function to get the correct mimeType based on file extension
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    csv: "text/csv",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    js: "text/javascript",
    css: "text/css",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    py: "text/x-python",
    md: "text/markdown",
  };

  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}

export async function uploadFile(page: Page, fileName: string) {
  // Kept ahead of `adjustScreenView` (whose own canvas gate is 30 s) so the
  // generous budget this helper has always had for the canvas to mount is not
  // silently cut for the file-upload specs.
  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 100000,
  });

  // Was three hand-rolled lines doing open → fit_view → toggle-closed, which is
  // exactly this call. The toggle was UNCONDITIONAL, so a menu left open by a
  // sibling helper made the first click CLOSE it, `fit_view` vanish, and this
  // helper die on a click timeout (#1053). No zoom-out: the previous code never
  // zoomed either.
  await adjustScreenView(page, { numberOfZoomOut: 0 });

  try {
    await page
      .getByText("File", { exact: true })
      .last()
      .click({ timeout: 5000 });
  } catch (error) {
    // do nothing, means that it's using file management v1
  }

  const fileManagement = await page
    .getByTestId("button_open_file_management")
    .first()
    ?.isVisible();

  if (!fileManagement) {
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("button_upload_file").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(resolveAssetPath(fileName));
    await page.getByText(fileName).isVisible();
    return;
  }
  await page.getByTestId("button_open_file_management").first().click();
  const drag = await page.getByTestId("drag-files-component");
  const sourceFileName = generateRandomFilename();
  const testFilePath = resolveAssetPath(fileName);
  const testFileType = fileName.split(".").pop() || "";
  const fileContent = fs.readFileSync(testFilePath);

  const fileChooserPromise = page.waitForEvent("filechooser");
  await drag.click();

  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([
    {
      name: `${sourceFileName}.${testFileType}`,
      mimeType: getMimeType(testFileType),
      buffer: fileContent,
    },
  ]);

  await page
    .getByText(sourceFileName + `.${testFileType}`)
    .last()
    .waitFor({ state: "visible", timeout: 3000 });

  const checkbox = page.getByTestId(`checkbox-${sourceFileName}`).last();
  await expect(checkbox).toHaveAttribute("data-state", "checked", {
    timeout: 3000,
  });

  await page.getByTestId("select-files-modal-button").click();

  await page
    .getByText(sourceFileName + `.${testFileType}`)
    .first()
    .waitFor({ state: "visible", timeout: 1000 });

  await unselectNodes(page);
}
