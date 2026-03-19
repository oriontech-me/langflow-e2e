import type { Page } from "@playwright/test";
import { BasePage } from "../BasePage";

export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async login(username: string = "langflow", password: string = "langflow") {
    await this.page.goto("/");
    await this.page.getByPlaceholder("Username").fill(username);
    await this.page.getByPlaceholder("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign In" }).click();
  }

  async isLoginPageVisible() {
    return this.page.getByPlaceholder("Username").isVisible();
  }
}
