import type { Page } from "@playwright/test";
import { dismissWelcomeOverlayAndWaitForModal } from "./open-new-flow-templates-modal";
import { waitForPageEntry } from "../other/page-entry-barrier";

export const addFlowToTestOnEmptyLangflow = async (page: Page) => {
  await page.getByTestId("new_project_btn_empty_page").click();

  // The empty-page CTA usually opens the templates modal directly, but on a
  // fresh Langflow 1.10.0 instance it can surface the FlowBuilderWelcome
  // overlay first — reconcile both via the shared helper.
  await dismissWelcomeOverlayAndWaitForModal(page);

  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();
  await page.getByTestId("icon-ChevronLeft").click();
  // Wait for home page to finish loading before awaitBootstrapTest continues.
  // Without this, the subsequent new-project-btn click can fire before navigation
  // completes, leaving tests in an inconsistent state.
  await waitForPageEntry(page, '[data-testid="mainpage_title"]', 15000);
};
