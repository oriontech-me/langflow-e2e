import type { Page } from "@playwright/test";
import { CUSTOM_COMPONENT_BUTTON_TESTID } from "../helpers/flows/add-component-from-sidebar";
import { addCustomComponent } from "../helpers/flows/add-custom-component";

export class SidebarComponent {
  constructor(private readonly page: Page) {}

  async search(term: string) {
    await this.page
      .getByTestId("sidebar-search-input")
      .waitFor({ state: "visible", timeout: 100000 });
    await this.page.getByTestId("sidebar-search-input").fill(term);
  }

  // Delegates to the shared helper rather than clicking the button itself:
  // Langflow drops this click and only an identical second one repairs it
  // (#1301 — 14 of 16 swallowed, 14 of 14 repaired, nightly 1.12.0.dev23). A
  // bare click here would reintroduce the defect for the first caller that
  // reaches for the POM instead of the helper.
  async addCustomComponent() {
    await this.page
      .getByTestId(CUSTOM_COMPONENT_BUTTON_TESTID)
      .waitFor({ state: "visible", timeout: 3000 });
    await addCustomComponent(this.page);
  }

  async selectTemplate(name: string) {
    await this.page.getByTestId("side_nav_options_all-templates").click();
    await this.page.getByRole("heading", { name }).click();
    await this.page
      .getByTestId("sidebar-search-input")
      .waitFor({ state: "visible", timeout: 100000 });
  }

  async goBack() {
    await this.page.getByTestId("icon-ChevronLeft").first().click();
  }
}
