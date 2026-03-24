import type { Page } from "@playwright/test";

export class SidebarComponent {
  constructor(private readonly page: Page) {}

  async search(term: string) {
    await this.page
      .getByTestId("sidebar-search-input")
      .waitFor({ state: "visible", timeout: 100000 });
    await this.page.getByTestId("sidebar-search-input").fill(term);
  }

  async addCustomComponent() {
    await this.page
      .getByTestId("sidebar-custom-component-button")
      .waitFor({ state: "visible", timeout: 3000 });
    await this.page.getByTestId("sidebar-custom-component-button").click();
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
