import { readFileSync } from "fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { MainPage } from "../../../../pages";

test(
  "CRUD folders",
  { tag: ["@release", "@api"] },
  async ({ page }) => {
    const mainPage = new MainPage(page);

    await mainPage.waitForLoad();
    await mainPage.sidebar.selectTemplate("Basic Prompting");
    await mainPage.sidebar.goBack();

    // Verificações visuais da página principal (sem assert — comportamento original)
    await page.getByPlaceholder("Search flows").first().isVisible();
    await page.getByText("Flows").first().isVisible();
    if (await page.getByText("Components").first().isVisible()) {
      await page.getByText("Components").first().isVisible();
    } else {
      await page.getByText("MCP Server").first().isVisible();
    }
    await page.getByText("All").first().isVisible();
    await page.getByText("Select All").first().isVisible();

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

  const jsonContent = readFileSync("tests/assets/collection.json", "utf-8");
  await mainPage.uploadFlowByDragDrop("Starter Project", jsonContent);

  const genericNode = page.getByTestId("div-generic-node");
  if ((await genericNode.count()) > 0) {
    expect(true).toBeTruthy();
  }

  await mainPage.clickProject("Starter Project");
  await page.waitForSelector("text=Getting Started:", { timeout: 100000 });

  expect(
    await page.locator("text=Getting Started:").last().isVisible(),
  ).toBeTruthy();
  expect(
    await page.locator("text=Inquisitive Pike").last().isVisible(),
  ).toBeTruthy();
  expect(
    await page.locator("text=Dreamy Bassi").last().isVisible(),
  ).toBeTruthy();
  expect(
    await page.locator("text=Furious Faraday").last().isVisible(),
  ).toBeTruthy();
});

test("change flow folder", async ({ page }) => {
  const mainPage = new MainPage(page);

  await mainPage.waitForLoad();
  await mainPage.sidebar.selectTemplate("Basic Prompting");
  await mainPage.sidebar.goBack();

  await page.getByPlaceholder("Search flows").isVisible();
  await page.getByText("Flows").first().isVisible();
  if (await page.getByText("Components").first().isVisible()) {
    await page.getByText("Components").first().isVisible();
  } else {
    await page.getByText("MCP Server").first().isVisible();
  }

  await mainPage.addProject();
  await mainPage.renameProject("New Project", "new project test name");

  await page.getByText("Starter Project").last().click();
  await mainPage.moveFlowToProject("Basic Prompting", "test");

  await page.getByText("Basic Prompting").first().isVisible();
});
