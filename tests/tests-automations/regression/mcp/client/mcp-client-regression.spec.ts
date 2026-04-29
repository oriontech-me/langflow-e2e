import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

const MCP_SERVER_NAME = "everything";
const MCP_JSON_CONFIG = JSON.stringify({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: "npx",
      args: ["@modelcontextprotocol/server-everything"],
    },
  },
});

test.describe("MCP Client – Configure and Execute Tool", () => {
  test.afterEach(async ({ page }) => {
    try {
      const token = await page.request
        .post("/api/v1/login", {
          form: { username: "langflow", password: "langflow" },
        })
        .then((r) => r.json())
        .then((d) => d.access_token as string);
      await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // best-effort
    }
    try {
      await page.goto("/");
      await cleanAllFlows(page);
    } catch {
      // best-effort
    }
  });

  test(
    "configures MCP server via JSON, selects echo tool, runs it, and verifies output",
    { tag: ["@mcp", "@regression"] },
    async ({ page }) => {
      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("Ensure MCP server is freshly added via JSON", async () => {
        // Always delete and re-add to guarantee the npx process starts fresh
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        await page.getByTestId("sidebar-nav-mcp").click();
        await expect(page.getByTestId("sidebar-add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("json-tab").click();
        await expect(page.getByTestId("json-input")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("json-input").fill(MCP_JSON_CONFIG);
        await page.getByTestId("add-mcp-server-button").click();
        await expect(
          page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`),
        ).toBeVisible({ timeout: 30000 });
      });

      await test.step("Add MCPTools component to canvas", async () => {
        await page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`).click();
        await zoomOut(page, 3);
        await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Trigger tool loading via MCP server dropdown", async () => {
        // Clicking mcp-server-dropdown triggers custom_component/update which
        // connects to the npx server and fetches the tool list
        const updatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/custom_component/update") && r.status() === 200,
          { timeout: 60000 },
        );
        await page
          .getByTestId("mcp-server-dropdown")
          .evaluate((el) => (el as HTMLElement).click());
        await updatePromise;
        await page.keyboard.press("Escape");
      });

      await test.step("Open tool dropdown and select echo", async () => {
        await page
          .getByTestId("dropdown_str_tool")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("echo-0-option")).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId("echo-0-option").click();
      });

      await test.step("Fill message input", async () => {
        await expect(page.getByTestId("popover-anchor-input-message")).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId("popover-anchor-input-message").fill("oi");
      });

      await test.step("Run node and verify output contains echoed message", async () => {
        await page.getByTestId("button_run_mcp tools").click();
        const outputBtn = page
          .locator('[data-testid^="output-inspection-response-"]')
          .first();
        await expect(outputBtn).toBeVisible({ timeout: 60000 });
        await outputBtn.click();
        // The output popover shows the component result — verify "oi" appears on page
        await expect(page.getByText("oi").first()).toBeVisible({ timeout: 10000 });
      });
    },
  );
});
