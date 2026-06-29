import { type Page } from "@playwright/test";

/**
 * Adds a component to the canvas via the sidebar: types the search term to
 * filter the list, then clicks the component's "+" button.
 *
 * Deliberately a "dumb" primitive — it performs the mechanism only and asserts
 * nothing. The intent (why the component is being added, and what should be
 * true afterwards) belongs to the calling spec, which is free to wrap this and
 * add its own assertions (node count, title visibility, etc.).
 *
 * @param searchTerm        text typed into `sidebar-search-input` to filter the sidebar
 * @param addButtonTestId   testid of the component's "+" button, e.g. `add-component-button-chat-input`
 */
export const addComponentFromSidebar = async (
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) => {
  await page.getByTestId("sidebar-search-input").fill(searchTerm);
  await page.getByTestId(addButtonTestId).click();
}; 
