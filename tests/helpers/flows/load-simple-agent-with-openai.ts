import type { Page } from "@playwright/test";
import { SimpleAgentTemplatePage } from "../../pages";

export async function loadSimpleAgentWithOpenAI(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  const simpleAgentPage = new SimpleAgentTemplatePage(page);
  await simpleAgentPage.load({ provider: "openai", model: modelTestId });
}
