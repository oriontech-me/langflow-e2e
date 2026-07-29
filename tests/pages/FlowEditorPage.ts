import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { SidebarComponent } from "./SidebarComponent";

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

  // Canvas view: use `helpers/ui/adjust-screen-view.ts` (fit view + zoom out +
  // the menu-closed postcondition) and `helpers/ui/zoom-out.ts`. Both are
  // unit-tested against a simulated widget and read the trigger's real
  // `data-state`.
  //
  // This class used to carry its own `fitView()` / `zoomOut()` / `adjustView()`.
  // They had no callers anywhere and had drifted into strictly worse copies: a
  // `waitForTimeout(500)` where the helper polls the viewport transform, and an
  // `adjustView()` that closed the menu by toggling a trigger whose count is 1
  // whenever the canvas is up — an always-true guard, i.e. the #997 defect with
  // no condition left at all. Deleted rather than repaired (#1053); a POM copy of
  // a mechanism this delicate is a defect waiting for its first caller.

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
