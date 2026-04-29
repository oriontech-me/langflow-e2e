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
      // Allow backend errors — npx server may return transient errors while starting
      (page as any).allowFlowErrors();

      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("Delete existing MCP server and re-add via JSON", async () => {
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

        // Click save and wait for modal to close
        await page.getByTestId("add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
          timeout: 10000,
        });

        // Wait for server to appear in sidebar
        await expect(
          page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`),
        ).toBeVisible({ timeout: 30000 });

        // Wait for the npx process to start and report tools via API
        // action_count=true makes the backend actively connect to each server
        await expect
          .poll(
            async () => {
              const resp = await page.request.get(
                "/api/v2/mcp/servers?action_count=true",
              );
              const servers: Array<{ name: string; toolsCount: number | null }> =
                await resp.json();
              return servers.find((s) => s.name === MCP_SERVER_NAME)?.toolsCount ?? null;
            },
            { timeout: 90000, intervals: [3000] },
          )
          .not.toBeNull();
      });

      await test.step("Add MCPTools component to canvas", async () => {
        await page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`).click();
        await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
          timeout: 15000,
        });
        await zoomOut(page, 3);
      });

      await test.step("Open tool dropdown and select echo", async () => {
        // Tools are confirmed loaded via API — open dropdown and click echo
        await page.evaluate(() => {
          (
            document.querySelector('[data-testid="dropdown_str_tool"]') as HTMLElement
          )?.click();
        });
        await page.waitForFunction(
          () => !!document.querySelector('[data-testid="echo-0-option"]'),
          { timeout: 15000 },
        );
        await page.evaluate(() => {
          (
            document.querySelector('[data-testid="echo-0-option"]') as HTMLElement
          )?.click();
        });
      });

      await test.step("Fill message input", async () => {
        await expect(page.getByTestId("popover-anchor-input-message")).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId("popover-anchor-input-message").fill("oi");
      });

      await test.step("Run node and verify output", async () => {
        await page.getByTestId("button_run_mcp tools").click();
        const outputBtn = page
          .locator('[data-testid^="output-inspection-response-"]')
          .first();
        await expect(outputBtn).toBeVisible({ timeout: 60000 });
        await outputBtn.click();
        await expect(page.getByText("oi").first()).toBeVisible({ timeout: 10000 });
      });
    },
  );
});
