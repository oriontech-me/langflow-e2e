import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test.describe("MCP Server – Flow Exposed as MCP Tool", () => {
  let flowId = "";

  test.afterEach(async ({ page }) => {
    if (flowId) {
      await deleteFlow(page.request, flowId);
      flowId = "";
    }
  });

  test(
    "flow appears as MCP tool in MCP Server tab and endpoint responds",
    { tag: ["@mcp", "@regression"] },
    async ({ page }) => {
      let flowName = "";

      await test.step("Create a blank ChatInput → ChatOutput flow and capture its name", async () => {
        await awaitBootstrapTest(page);
        flowId = await setupPlayground(page);
        // Capture the auto-generated name so we can assert this specific flow surfaces
        // in the tool list, instead of relying on a generic "at least one tool" check
        // that could pass for unrelated pre-existing flows.
        const flowResp = await page.request.get(`/api/v1/flows/${flowId}`);
        expect(flowResp.ok()).toBeTruthy();
        flowName = (await flowResp.json()).name as string;
        expect(flowName, "Newly-created flow must have a name").toBeTruthy();
      });

      await test.step("Navigate to home and open MCP Server tab", async () => {
        await page.goto("/");
        await expect(page.getByTestId("mcp-btn")).toBeVisible({ timeout: 15000 });
        await page.getByTestId("mcp-btn").click();
        await expect(page.getByTestId("mcp-server-title")).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Verify the newly-created flow appears in the tools list by name", async () => {
        await expect(page.getByTestId("div-mcp-server-tools")).toBeVisible({
          timeout: 10000,
        });
        // Langflow renders flow names in the MCP tools list as uppercase slugs
        // (e.g. "New Flow" → "NEW_FLOW"). Build the same slug to pinpoint THIS flow
        // instead of asserting a generic count > 0 which can pass for any prior flow.
        const flowSlug = flowName.toUpperCase().replace(/\s+/g, "_");
        await expect(
          page.getByTestId("div-mcp-server-tools").getByText(flowSlug, { exact: false }),
        ).toBeVisible({ timeout: 30000 });
      });

      await test.step("Verify the MCP endpoint URL is displayed in JSON config", async () => {
        // Click the JSON tab to display the connection config
        await page.getByRole("button", { name: "JSON" }).click();
        // The config must contain the project MCP endpoint URL
        await expect(
          page.getByText(/mcp\/project\/.+\/streamable/),
        ).toBeVisible({ timeout: 10000 });
      });

      await test.step("Verify the MCP streamable endpoint actually responds to JSON-RPC initialize", async () => {
        // Discover the project ID via the same endpoint the UI uses; normalize the shape
        // because /api/v1/projects/ may return a bare array or { folders: [...] }.
        const projectsResp = await page.request.get("/api/v1/projects/");
        expect(projectsResp.ok()).toBeTruthy();
        const projectsRaw = await projectsResp.json();
        const projects: Array<{ id: string }> = Array.isArray(projectsRaw)
          ? projectsRaw
          : (projectsRaw.folders ?? []);
        expect(projects.length).toBeGreaterThan(0);

        const initResp = await page.request.post(
          `/api/v1/mcp/project/${projects[0].id}/streamable`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            data: {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "langflow-e2e-test", version: "1" },
              },
            },
          },
        );
        expect(initResp.status()).toBe(200);
      });
    },
  );
});
