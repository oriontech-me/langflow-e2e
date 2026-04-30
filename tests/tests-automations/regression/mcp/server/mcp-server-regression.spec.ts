import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("MCP Server – Flow Exposed as MCP Tool", () => {
  let flowId = "";

  test.afterEach(async ({ page }) => {
    if (flowId) {
      await page.request.delete(`/api/v1/flows/${flowId}`).catch(() => {});
      flowId = "";
    }
  });

  test(
    "flow appears as MCP tool in MCP Server tab and endpoint responds",
    { tag: ["@mcp", "@regression"] },
    async ({ page }) => {
      await test.step("Create a blank ChatInput → ChatOutput flow", async () => {
        await awaitBootstrapTest(page);
        flowId = await setupPlayground(page);
      });

      await test.step("Navigate to home and open MCP Server tab", async () => {
        await page.goto("/");
        await expect(page.getByTestId("mcp-btn")).toBeVisible({ timeout: 15000 });
        await page.getByTestId("mcp-btn").click();
        await expect(page.getByTestId("mcp-server-title")).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Verify the flow appears in the MCP tools list", async () => {
        await expect(page.getByTestId("div-mcp-server-tools")).toBeVisible({
          timeout: 10000,
        });
        // At least one tool should be listed (the flow we created)
        const tools = page.locator('[data-testid^="tool_"]');
        await expect(tools.first()).toBeVisible({ timeout: 10000 });
        expect(await tools.count()).toBeGreaterThan(0);
      });

      await test.step("Verify the MCP endpoint URL is displayed in JSON config", async () => {
        // Click the JSON tab to display the connection config
        await page.getByRole("button", { name: "JSON" }).click();
        // The config must contain the project MCP endpoint URL
        await expect(
          page.getByText(/mcp\/project\/.+\/streamable/),
        ).toBeVisible({ timeout: 10000 });
      });
    },
  );
});
