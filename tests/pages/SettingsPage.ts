import { BasePage } from "./BasePage";

export class SettingsPage extends BasePage {
  async navigate() {
    await this.page.getByTestId("user_menu_button").click();
    await this.page.getByTestId("menu_settings_button").click();
  }
}
