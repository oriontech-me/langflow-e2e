import type { Page } from "@playwright/test";
import { SUPERUSER_PASSWORD, SUPERUSER_USERNAME } from "./credentials";

export const loginLangflow = async (page: Page) => {
  await page.goto("/");
  await page.getByPlaceholder("Username").fill(SUPERUSER_USERNAME);
  await page.getByPlaceholder("Password").fill(SUPERUSER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
};
