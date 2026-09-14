import { type Locator, type Page, expect } from "@playwright/test";
import { BasePage } from "./BasePage";

/**
 * The three terminal states of the Langflow Assistant panel, in the order upstream's
 * `assistant-panel.tsx` branches on them:
 *
 *   !agenticExperienceEnabled                        → "disabled"
 *   isCatalogReady && !hasEnabledModels && !messages → "no-models"
 *   otherwise                                        → the composer
 *
 * The composer is only terminal once its textarea is ENABLED: it renders while the
 * model catalog is still loading, with `disabled={!isCatalogReady || !hasEnabledModels}`,
 * so "textarea visible" alone would report a composer that cannot yet be used.
 */
export type AssistantPanelState = "composer" | "no-models" | "disabled";

/** Model names the selector lists, keyed by the provider label they sit under. */
export type AssistantModelMenu = Record<string, string[]>;

/**
 * The Langflow Assistant canvas panel (1.13). Testids measured live on 1.13.0.dev12;
 * the model menu's items carry no testid and are read by role.
 */
export class AssistantPanel extends BasePage {
  readonly trigger: Locator;
  readonly panel: Locator;
  readonly textarea: Locator;
  readonly sendButton: Locator;
  readonly modelSelector: Locator;
  readonly weakHint: Locator;
  readonly noModelsCta: Locator;
  readonly disabledState: Locator;

  constructor(page: Page) {
    super(page);
    this.trigger = page.getByTestId("assistant-button");
    this.panel = page.getByTestId("assistant-panel");
    this.textarea = this.panel.getByTestId("assistant-input-textarea");
    this.sendButton = this.panel.getByTestId("assistant-send-button");
    this.modelSelector = this.panel.getByTestId("assistant-model-selector");
    this.weakHint = this.panel.getByTestId("assistant-model-weak-hint");
    this.noModelsCta = this.panel.getByTestId("assistant-no-models-configure-providers");
    this.disabledState = this.panel.getByTestId("assistant-disabled-state");
  }

  /** Open the panel from the canvas. A no-op when it is already open (the trigger toggles). */
  async open(timeout = 15000): Promise<void> {
    if (!(await this.panel.isVisible().catch(() => false))) {
      await this.trigger.click();
    }
    await expect(this.panel).toBeVisible({ timeout });
  }

  /**
   * Wait until the panel settles into one of its terminal states and return it.
   *
   * Polls the three candidates with `isVisible()` rather than racing two waits or using
   * `or().first()`, which resolves by DOM order and pins the wait to its full timeout
   * when an attached-but-hidden element comes first (#599).
   */
  async waitForTerminalState(timeout = 30000): Promise<AssistantPanelState> {
    let state: AssistantPanelState | undefined;
    await expect
      .poll(
        async () => {
          state = await this.readState();
          return state;
        },
        {
          timeout,
          message:
            "the Assistant panel never reached a terminal state (enabled composer, no-models or disabled)",
        },
      )
      .not.toBeUndefined();
    return state as AssistantPanelState;
  }

  private async readState(): Promise<AssistantPanelState | undefined> {
    if (await this.disabledState.isVisible().catch(() => false)) return "disabled";
    if (await this.noModelsCta.isVisible().catch(() => false)) return "no-models";
    if (
      (await this.textarea.isVisible().catch(() => false)) &&
      (await this.textarea.isEnabled({ timeout: 1000 }).catch(() => false))
    ) {
      return "composer";
    }
    return undefined;
  }

  /**
   * The open model menu, addressed through the trigger's `aria-controls` rather than
   * `getByRole("menu")`, so another menu elsewhere on the page can never be read instead.
   * Opens it when it is closed.
   */
  async openModelMenu(timeout = 10000): Promise<Locator> {
    if ((await this.modelSelector.getAttribute("aria-expanded")) !== "true") {
      await this.modelSelector.click();
    }
    await expect(this.modelSelector).toHaveAttribute("aria-expanded", "true", { timeout });
    await expect(this.modelSelector, "the model selector exposes no aria-controls id for its menu").toHaveAttribute("aria-controls", /\S/);
    const menuId = await this.modelSelector.getAttribute("aria-controls");
    const menu = this.page.locator(`[id="${menuId}"]`);
    await expect(menu).toBeVisible({ timeout });
    return menu;
  }

  /**
   * Read the model menu grouped by provider. Upstream renders each provider as a label
   * followed by a wrapper holding that provider's `menuitem`s; the "Refresh List" and
   * "Manage Model Providers" items sit directly under the menu root and belong to no
   * provider, so they are left out.
   */
  async readModelMenu(): Promise<AssistantModelMenu> {
    const menu = await this.openModelMenu();
    return menu.evaluate((root) => {
      const groups: Record<string, string[]> = {};
      for (const item of Array.from(root.querySelectorAll('[role="menuitem"]'))) {
        const wrapper = item.parentElement;
        if (!wrapper || wrapper === root) continue;
        const label = wrapper.previousElementSibling;
        if (!label || label.hasAttribute("role")) continue;
        const provider = (label.textContent ?? "").trim();
        if (!provider) continue;
        (groups[provider] ??= []).push((item.textContent ?? "").trim());
      }
      return groups;
    });
  }

  /** Select a model from under its provider's label, never a same-named item of another provider. */
  async selectModel(provider: string, model: string): Promise<void> {
    // XPath 1.0 has no escape sequences; no Langflow provider name carries a quote.
    expect(provider, "provider label must not contain a double quote").not.toContain('"');
    const menu = await this.openModelMenu();
    const group = menu.locator(
      `xpath=.//*[@role="menuitem"]/parent::*[preceding-sibling::*[1][not(@role) and normalize-space(.)="${provider}"]]`,
    );
    await group.getByRole("menuitem", { name: model, exact: true }).click();
    await expect(this.modelSelector).toHaveAttribute("aria-expanded", "false");
  }
}
