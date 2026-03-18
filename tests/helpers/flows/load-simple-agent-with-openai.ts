import type { Page } from "@playwright/test";
import { SimpleAgentPage } from "../../pages";

export async function loadSimpleAgentWithOpenAI(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  const simpleAgentPage = new SimpleAgentPage(page);
  await simpleAgentPage.load({ provider: "openai", model: modelTestId });
}
