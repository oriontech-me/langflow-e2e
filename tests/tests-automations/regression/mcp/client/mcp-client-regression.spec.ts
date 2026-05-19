import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

// Worker- and timestamp-suffixed name prevents cross-file races: this spec and
// mcp-client-agent.spec.ts both register an MCP "everything" server, and
// file-level serial mode does not serialize across workers.
const MCP_SERVER_NAME = `everything-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now()}`;
const MCP_JSON_CONFIG = JSON.stringify({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: "npx",
      args: ["@modelcontextprotocol/server-everything"],
    },
  },
});

// Serial mode required — Tests 1 and 4 share the same npx server and conflict when run in parallel
test.describe.configure({ mode: "serial" });

// `bad-server` and `http-form-server` stay as fixed names — they are only used in
// individual tests in this file, file-level serial mode prevents intra-file races,
// and longer uniquified names can collide with Langflow's MCP server name handling.
const BAD_SERVER_NAME = "bad-server";
const HTTP_FORM_SERVER_NAME = "http-form-server";

test.describe("MCP Client – Configure and Execute Tool", () => {
  test.afterEach(async ({ page }) => {
    const serversToClean = [MCP_SERVER_NAME, BAD_SERVER_NAME, HTTP_FORM_SERVER_NAME];
    try {
      const token = await page.request
        .post("/api/v1/login", {
          form: { username: "langflow", password: "langflow" },
        })
        .then((r) => r.json())
        .then((d) => d.access_token as string);
      for (const name of serversToClean) {
        await page.request.delete(`/api/v2/mcp/servers/${name}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
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

        await expect(page.getByTestId("sidebar-nav-mcp")).toBeVisible({
          timeout: 15000,
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

  test(
    "unreachable HTTP server results in empty tool dropdown",
    { tag: ["@mcp", "@regression", "@stable"] },
    async ({ page }) => {
      const BAD_SERVER = BAD_SERVER_NAME;

      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("Pre-clean: delete bad-server if it exists", async () => {
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);
        await page.request.delete(`/api/v2/mcp/servers/${BAD_SERVER}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      });

      await test.step("Register unreachable HTTP server via HTTP tab", async () => {
        await expect(page.getByTestId("sidebar-nav-mcp")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-nav-mcp").click();
        await expect(page.getByTestId("sidebar-add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });

        await page.getByTestId("http-tab").click();
        await expect(page.getByTestId("http-name-input")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("http-name-input").fill(BAD_SERVER);
        await page.getByTestId("http-url-input").fill("http://localhost:1/mcp");

        await page.getByTestId("add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
          timeout: 10000,
        });

        await expect(
          page.getByTestId(`add-component-button-${BAD_SERVER}`),
        ).toBeVisible({ timeout: 30000 });
      });

      await test.step("Add MCPTools component and verify empty tool dropdown", async () => {
        await page.getByTestId(`add-component-button-${BAD_SERVER}`).click();
        await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
          timeout: 15000,
        });
        await zoomOut(page, 3);

        // Wait for backend to attempt connection (it may fail silently)
        await page.waitForTimeout(5000);

        // Open dropdown and verify it has no selectable tool options
        await page.evaluate(() => {
          (
            document.querySelector('[data-testid="dropdown_str_tool"]') as HTMLElement
          )?.click();
        });

        // Confirm the dropdown is actually open before asserting zero options.
        // This prevents a false-positive where the evaluate click fails silently
        // and toHaveCount(0) trivially passes because the dropdown never opened.
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="dropdown_str_tool"]');
            return (
              el?.getAttribute("aria-expanded") === "true" ||
              !!document.querySelector('[role="listbox"]') ||
              !!document.querySelector("[data-radix-popper-content-wrapper]")
            );
          },
          { timeout: 5000 },
        );

        // Confirm the dropdown component is still visible (guards against crash/disappear)
        await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({ timeout: 3000 });

        // No tool options should appear — the server is unreachable
        const toolOptions = page.locator('[data-testid$="-option"]');
        await expect(toolOptions).toHaveCount(0, { timeout: 5000 });
      });
    },
  );

  test(
    "configures MCP server via HTTP form tab and verifies registration",
    { tag: ["@mcp", "@regression", "@stable"] },
    async ({ page }) => {
      const HTTP_SERVER = HTTP_FORM_SERVER_NAME;

      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("Pre-clean: delete http-form-server if it exists", async () => {
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);
        await page.request.delete(`/api/v2/mcp/servers/${HTTP_SERVER}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      });

      await test.step("Register server via HTTP form tab", async () => {
        await expect(page.getByTestId("sidebar-nav-mcp")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-nav-mcp").click();
        await expect(page.getByTestId("sidebar-add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });

        await page.getByTestId("http-tab").click();
        await expect(page.getByTestId("http-name-input")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("http-name-input").fill(HTTP_SERVER);
        await page.getByTestId("http-url-input").fill("http://localhost:1/mcp");

        await page.getByTestId("add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
          timeout: 10000,
        });
      });

      await test.step("Verify server appears in sidebar", async () => {
        await expect(
          page.getByTestId(`add-component-button-${HTTP_SERVER}`),
        ).toBeVisible({ timeout: 30000 });
      });

      await test.step("Verify server is persisted in the database", async () => {
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);

        const resp = await page.request.get("/api/v2/mcp/servers", {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(resp.status()).toBe(200);

        const servers: Array<{ name: string }> = await resp.json();
        const registered = servers.find((s) => s.name === HTTP_SERVER);
        expect(registered, `Server "${HTTP_SERVER}" not found in API response`).toBeTruthy();
      });
    },
  );

  test(
    "selects get-sum tool, provides numeric inputs, and verifies sum in output",
    { tag: ["@mcp", "@regression", "@stable"] },
    async ({ page }) => {
      // Allow backend errors — npx server may return transient errors while starting
      (page as any).allowFlowErrors();

      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("Register everything server via JSON and wait for tools", async () => {
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        await expect(page.getByTestId("sidebar-nav-mcp")).toBeVisible({
          timeout: 15000,
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
        await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
          timeout: 10000,
        });

        await expect(
          page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`),
        ).toBeVisible({ timeout: 30000 });

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

      await test.step("Select get-sum tool from dropdown", async () => {
        await page.evaluate(() => {
          (
            document.querySelector('[data-testid="dropdown_str_tool"]') as HTMLElement
          )?.click();
        });
        // Match by name prefix — the ordinal index in `get-sum-{N}-option` shifts whenever
        // server-everything reorders its tools across releases.
        const getSumOption = page.locator('[data-testid^="get-sum-"][data-testid$="-option"]');
        await expect(getSumOption).toBeVisible({ timeout: 15000 });
        await getSumOption.evaluate((el) => (el as HTMLElement).click());
      });

      await test.step("Fill numeric inputs a=3 and b=5", async () => {
        // server-everything's get-sum tool exposes float inputs with testids float_float_a / float_float_b
        await expect(page.getByTestId("float_float_a")).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByTestId("float_float_b")).toBeVisible({
          timeout: 10000,
        });
        await page.getByTestId("float_float_a").fill("3");
        await page.getByTestId("float_float_b").fill("5");
      });

      await test.step("Run node and verify output contains 8", async () => {
        await page.getByTestId("button_run_mcp tools").click();
        const outputBtn = page
          .locator('[data-testid^="output-inspection-response-"]')
          .first();
        await expect(outputBtn).toBeVisible({ timeout: 60000 });
        await outputBtn.click();
        const outputModal = page.locator('[role="dialog"]');
        await expect(outputModal).toBeVisible({ timeout: 10000 });
        // The get-sum tool returns "The sum of 3 and 5 is 8." — match the full sentence to avoid false positives
        await expect(outputModal.getByText("The sum of 3 and 5 is 8.")).toBeVisible({ timeout: 5000 });
      });
    },
  );
});
