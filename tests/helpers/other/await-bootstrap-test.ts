import type { Page } from "@playwright/test";
import { addFlowToTestOnEmptyLangflow } from "../flows/add-flow-to-test-on-empty-langflow";
import { openNewFlowTemplatesModal } from "../flows/open-new-flow-templates-modal";
import { waitForPageEntry } from "./page-entry-barrier";

export const awaitBootstrapTest = async (
  page: Page,
  options?: {
    skipGoto?: boolean;
    skipModal?: boolean;
  },
) => {
  if (!options?.skipGoto) {
    await page.goto("/");
  }

  // Attributed barrier, not a bare waitForSelector: a backend that is down or
  // restarting produces the identical timeout as a UI regression here, and that
  // ambiguity mis-triaged #1262. See helpers/other/page-entry-barrier.ts.
  await waitForPageEntry(page, '[data-testid="mainpage_title"]', 30000);

  const countEmptyButton = await page
    .getByTestId("new_project_btn_empty_page")
    .count();
  if (countEmptyButton > 0) {
    await addFlowToTestOnEmptyLangflow(page);
  }

  await waitForPageEntry(page, '[id="new-project-btn"]', 30000);

  if (!options?.skipModal) {
    let modalCount = 0;
    try {
      const modalTitleElement = await page?.getByTestId("modal-title");
      if (modalTitleElement) {
        modalCount = await modalTitleElement.count();
      }
    } catch (_error) {
      modalCount = 0;
    }

    let attempts = 0;
    const maxAttempts = 5;

    while (modalCount === 0 && attempts < maxAttempts) {
      attempts++;
      try {
        await openNewFlowTemplatesModal(page);
        modalCount = await page.getByTestId("modal-title")?.count();
      } catch (error) {
        if (attempts >= maxAttempts) {
          throw new Error(
            `Failed to open modal after ${maxAttempts} attempts: ${error}`,
          );
        }
        // openNewFlowTemplatesModal clicks "New Flow", which on 1.10.0
        // navigates to a freshly-created flow. Return home before retrying so
        // new-project-btn is present again — otherwise the retry clicks into
        // the canvas and times out.
        await page.goto("/");
        await waitForPageEntry(page, '[id="new-project-btn"]', 30000);
        await page.waitForTimeout(1000);
      }
    }

    if (modalCount === 0) {
      throw new Error(`Modal did not appear after ${maxAttempts} attempts`);
    }
  }
};
