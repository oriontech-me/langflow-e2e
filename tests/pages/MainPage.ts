import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { SidebarComponent } from "./SidebarComponent";
import { addFlowToTestOnEmptyLangflow } from "../helpers/flows/add-flow-to-test-on-empty-langflow";

export class MainPage extends BasePage {
  readonly sidebar: SidebarComponent;

  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);
  }

  async waitForLoad({ skipModal = false }: { skipModal?: boolean } = {}) {
    await this.page.goto("/");
    await this.page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    const emptyPageBtn = this.page.getByTestId("new_project_btn_empty_page");
    if ((await emptyPageBtn.count()) > 0) {
      await addFlowToTestOnEmptyLangflow(this.page);
    }

    await this.page.waitForSelector('[id="new-project-btn"]', {
      timeout: 30000,
    });

    if (!skipModal) {
      await this.openNewProjectModal();
    }
  }

  async waitForNewFlowVisible() {
    await this.page.goto("/");
    await this.page.waitForSelector("text=New Flow", { timeout: 50000 });
  }

  async openNewProjectModal() {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.page.getByTestId("new-project-btn").click();
      try {
        await this.page.waitForSelector('[data-testid="modal-title"]', {
          timeout: 5000,
        });
        return;
      } catch {
        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to open new project modal after ${maxAttempts} attempts`,
          );
        }
        await this.page.waitForTimeout(1000);
      }
    }
  }

  async searchFlows(term: string) {
    await this.page.getByPlaceholder("Search flows").first().fill(term);
  }

  async openFlowDropdownMenu(index = 0) {
    await this.page.getByTestId("home-dropdown-menu").nth(index).click();
  }

  async deleteFlow(index = 0) {
    await this.openFlowDropdownMenu(index);
    await this.page.waitForSelector('[data-testid="icon-Trash2"]', {
      timeout: 1000,
    });
    await this.page.getByText("Delete").last().click();
    await this.page.getByText("Delete").last().click();
  }

  async cleanAllFlows() {
    const emptyPageDescription = this.page.getByTestId(
      "empty_page_description",
    );
    while ((await emptyPageDescription.count()) === 0) {
      await this.page.getByTestId("home-dropdown-menu").first().click();
      await this.page.getByTestId("btn_delete_dropdown_menu").first().click();
      await this.page
        .getByTestId("btn_delete_delete_confirmation_modal")
        .first()
        .click();
      await this.page.waitForTimeout(1000);
    }
  }

  // Folders / Projects
  async addProject() {
    await this.page.getByTestId("add-project-button").click();
  }

  async renameProject(currentName: string, newName: string) {
    await this.page
      .locator("[data-testid='project-sidebar']")
      .getByText(currentName)
      .last()
      .dblclick();
    await this.page.getByTestId("input-project").fill(newName);
    await this.page.keyboard.press("Enter");
    await this.page.getByText(newName).last().waitFor({
      state: "visible",
      timeout: 30000,
    });
  }

  async deleteProject(name: string) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    await this.page.getByTestId(`sidebar-nav-${name}`).last().hover();
    await this.page.getByTestId(`more-options-button_${slug}`).click();
    await this.page.getByTestId("btn-delete-project").click();
    await this.page.getByText("Delete").last().click();
  }

  async uploadFlowByDragDrop(projectName: string, jsonContent: string) {
    await this.page.waitForSelector(
      `[data-testid="sidebar-nav-${projectName}"]`,
      { timeout: 100000 },
    );
    const dataTransfer = await this.page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      const file = new File([data], "flowtest.json", {
        type: "application/json",
      });
      dt.items.add(file);
      return dt;
    }, jsonContent);

    await this.page
      .getByTestId(`sidebar-nav-${projectName}`)
      .dispatchEvent("drop", { dataTransfer });
    await this.page.waitForTimeout(1000);
  }

  async moveFlowToProject(flowName: string, targetProjectName: string) {
    await this.page.getByText(flowName).first().hover();
    await this.page.mouse.down();
    await this.page.getByText(targetProjectName).first().hover();
    await this.page.mouse.up();
  }

  async clickProject(name: string) {
    await this.page.getByTestId(`sidebar-nav-${name}`).click();
  }
}
