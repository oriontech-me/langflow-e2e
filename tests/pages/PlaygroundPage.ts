import type { Page } from "@playwright/test";
import { BasePage } from "../BasePage";

export class PlaygroundPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async waitForLoad() {
    await this.page.waitForSelector('[data-testid="playground-btn-flow-io"]', {
      timeout: 30000,
    });
  }

  async open() {
    await this.page.getByTestId("playground-btn-flow-io").click();
    await this.waitForLoad();
  }

  async sendMessage(message: string) {
    const input = this.page.getByTestId("input-chat-playground");
    await input.fill(message);
    await input.press("Enter");
  }

  async waitForResponse(timeout = 60000) {
    await this.page.waitForSelector('[data-testid="div-chat-message"]', {
      timeout,
    });
  }

  async getLastResponse(): Promise<string> {
    const messages = this.page.getByTestId("div-chat-message");
    const count = await messages.count();
    return messages.nth(count - 1).innerText();
  }

  async clearChat() {
    await this.page.getByTestId("delete-session-button").click();
  }

  async stopResponse() {
    await this.page.getByTestId("stop-button-playground").click();
  }

  async close() {
    await this.page.keyboard.press("Escape");
  }
}
