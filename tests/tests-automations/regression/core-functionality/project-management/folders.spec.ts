import { readFileSync } from "fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { MainPage } from "../../../../pages";

test(
  "CRUD folders",
  { tag: ["@release", "@api", "@project-management"] },
  async ({ page }) => {
    const mainPage = new MainPage(page);

    await mainPage.waitForLoad();
    await mainPage.sidebar.selectTemplate("Basic Prompting");
    await mainPage.sidebar.goBack();

    await expect(page.getByPlaceholder("Search flows").first()).toBeVisible();

    await mainPage.addProject();
    await mainPage.renameProject("New Project", "new project test name");
    await mainPage.deleteProject("new project test name");

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 3000,
    });
  },
);

test("add a flow into a folder by drag and drop", async ({ page }) => {
  const mainPage = new MainPage(page);

  await mainPage.waitForNewFlowVisible();

  const jsonContent = readFileSync("tests/assets/flows/collection.json", "utf-8");
  await mainPage.uploadFlowByDragDrop("Starter Project", jsonContent);

  await mainPage.clickProject("Starter Project");
  await page.waitForSelector("text=Getting Started:", { timeout: 100000 });

  await expect(page.locator("text=Getting Started:").last()).toBeVisible();
  await expect(page.locator("text=Inquisitive Pike").last()).toBeVisible();
  await expect(page.locator("text=Dreamy Bassi").last()).toBeVisible();
  await expect(page.locator("text=Furious Faraday").last()).toBeVisible();
});

test("change flow folder", async ({ page }) => {
  const mainPage = new MainPage(page);

  await mainPage.waitForLoad();
  await mainPage.sidebar.selectTemplate("Basic Prompting");
  await mainPage.sidebar.goBack();

  await expect(page.getByPlaceholder("Search flows").first()).toBeVisible();

  await mainPage.addProject();
  await mainPage.renameProject("New Project", "new project test name");

  await page.getByText("Starter Project").last().click();
  await mainPage.moveFlowToProject("Basic Prompting", "test");

  await expect(page.getByText("Basic Prompting").first()).toBeVisible({ timeout: 10000 });
});
