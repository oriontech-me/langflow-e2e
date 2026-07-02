import type { Page } from "@playwright/test";
import {
  SUPERUSER_PASSWORD,
  SUPERUSER_USERNAME,
} from "../helpers/auth/credentials";
import { BasePage } from "./BasePage";

export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async login(
    username: string = SUPERUSER_USERNAME,
    password: string = SUPERUSER_PASSWORD,
  ) {
    await this.page.goto("/");
    await this.page.getByPlaceholder("Username").fill(username);
    await this.page.getByPlaceholder("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign In" }).click();
  }

  async isLoginPageVisible() {
    return this.page.getByPlaceholder("Username").isVisible();
  }
}
