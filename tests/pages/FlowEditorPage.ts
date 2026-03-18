import type { Page } from "@playwright/test";
import { BasePage } from "../BasePage";
import { SidebarComponent } from "../SidebarComponent";

export class FlowEditorPage extends BasePage {
  readonly sidebar: SidebarComponent;

  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);
  }

  async waitForCanvas() {
    await this.page.waitForSelector(
      '[data-testid="canvas_controls_dropdown"]',
      { timeout: 30000 },
    );
  }

  // Canvas controls
  async fitView() {
    await this.waitForCanvas();

    const fitViewBtn = this.page.getByTestId("fit_view");
    if ((await fitViewBtn.count()) === 0) {
      await this.page.getByTestId("canvas_controls_dropdown").click();
    }
    await fitViewBtn.click();
    await this.page.waitForTimeout(500);
  }

  async zoomOut(times = 1) {
    for (let i = 0; i < times; i++) {
      const zoomOutBtn = this.page.getByTestId("zoom_out");
      if (await zoomOutBtn.isDisabled({ timeout: 1000 })) break;
      await zoomOutBtn.click({ timeout: 1000 });
    }
  }

  async adjustView(numberOfZoomOut = 1) {
    await this.fitView();
    await this.zoomOut(numberOfZoomOut);
    // Close controls dropdown if it was opened
    const dropdown = this.page.getByTestId("canvas_controls_dropdown");
    if ((await dropdown.count()) > 0) {
      await dropdown.click({ force: true, timeout: 1000 });
    }
  }

  // Flow execution
  async runFlow() {
    await this.page.getByTestId("button_run_flow").click();
  }

  async stopFlow() {
    await this.page.getByTestId("stop-building-button").click();
  }

  // Node interactions
  async clickNode(nodeTestId: string) {
    await this.page.getByTestId(nodeTestId).click();
  }

  async openNodeAdvancedOptions(nodeTestId: string) {
    await this.page.getByTestId(nodeTestId).hover();
    await this.page.getByTestId("more-options-modal").click();
  }

  // Flow settings
  async openFlowSettings() {
    await this.page.getByTestId("flow_settings_btn").click();
  }

  async lockFlow() {
    await this.page.getByTestId("lock_unlock_button").click();
  }

  // Right-click context menu
  async rightClickCanvas() {
    await this.page.getByTestId("rf__wrapper").click({ button: "right" });
  }

  // Save flow name
  async renameFlow(newName: string) {
    await this.page.getByTestId("flow-name").dblclick();
    await this.page.getByTestId("flow-name-input").clear();
    await this.page.getByTestId("flow-name-input").fill(newName);
    await this.page.keyboard.press("Enter");
  }
}
