import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

// Clicks the blank-flow card and returns the id from the flow-creation POST, NOT
// from the canvas URL: the URL id is a transient client-side handle on this
// Langflow version and does not match the persisted flow (deleting it 404s and
// silently leaks the real one). The POST response is the authoritative id.
async function openBlankFlow(page: Page): Promise<string | undefined> {
  const flowCreation = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByTestId("blank-flow").click();
  const id = ((await (await flowCreation).json()) as { id?: string }).id;
  await page.waitForURL(/\/flow\//, { timeout: 30000 });
  return id;
}

// MCP-server pre-clean/verification calls authenticate via the shared
// `getAuthToken` helper (which uses `GET /api/v1/auto_login`). The suite starts
// Langflow with `LANGFLOW_AUTO_LOGIN=true`, under which `POST /api/v1/login`
// with username/password can be rejected — the previous inline login calls
// silently yielded an undefined token, so the follow-up DELETE ran
// unauthenticated and the pre-clean never removed a leftover server. A stale
// server then makes the next registration hit a pre-existing name, which the
// backend rejects with HTTP 500 ("Server already exists.", `api/v2/mcp.py`) —
// see the investigation in #396. `getAuthToken` returns a ready-to-use
// `Authorization` header value (or "" when the instance has no auth).

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

// Id of the flow the running test created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively building mid-run (#515).
let createdFlowId: string | undefined;

test.describe("MCP Client – Configure and Execute Tool", () => {
  test.afterEach(async ({ page }) => {
    const flowId = createdFlowId;
    createdFlowId = undefined;

    // Navigate off the editor first so the unmounted flow page stops polling the
    // flow we are about to delete. The auth header is reused for both the MCP
    // server cleanup and the flow deletion — page.request is unauthenticated
    // under AUTO_LOGIN and would 401 otherwise.
    await page.goto("/");
    const authHeader = await getAuthToken(page.request);
    const opts = authHeader
      ? { headers: { Authorization: authHeader } }
      : undefined;

    const serversToClean = [MCP_SERVER_NAME, BAD_SERVER_NAME, HTTP_FORM_SERVER_NAME];
    try {
      for (const name of serversToClean) {
        await page.request.delete(`/api/v2/mcp/servers/${name}`, opts);
      }
    } catch {
      // best-effort
    }

    // Delete ONLY the flow this test created (scoped teardown, #515). Not
    // swallowed: a failed cleanup surfaces instead of silently leaking (#547).
    if (flowId) {
      await deleteFlow(page.request, flowId, opts);
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
        createdFlowId = await openBlankFlow(page);
      });

      await test.step("Delete existing MCP server and re-add via JSON", async () => {
        const authHeader = await getAuthToken(page.request);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: authHeader },
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
        createdFlowId = await openBlankFlow(page);
      });

      await test.step("Pre-clean: delete bad-server if it exists", async () => {
        const authHeader = await getAuthToken(page.request);
        await page.request.delete(`/api/v2/mcp/servers/${BAD_SERVER}`, {
          headers: { Authorization: authHeader },
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
        createdFlowId = await openBlankFlow(page);
      });

      await test.step("Pre-clean: delete http-form-server if it exists", async () => {
        const authHeader = await getAuthToken(page.request);
        await page.request.delete(`/api/v2/mcp/servers/${HTTP_SERVER}`, {
          headers: { Authorization: authHeader },
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
        const authHeader = await getAuthToken(page.request);

        const resp = await page.request.get("/api/v2/mcp/servers", {
          headers: { Authorization: authHeader },
        });
        expect(resp.status()).toBe(200);

        const servers: Array<{ name: string }> = await resp.json();
        const registered = servers.find((s) => s.name === HTTP_SERVER);
        expect(registered, `Server "${HTTP_SERVER}" not found in API response`).toBeTruthy();
      });
    },
  );

  test(
    // @stable removed pending #463 — depends on the `npx server-everything` MCP
    // server registering its tools in time, which hard-failed the daily suite
    // (2026-07-01) on cold startup. Re-add once server startup is reliable in CI.
    "selects get-sum tool, provides numeric inputs, and verifies sum in output",
    { tag: ["@mcp", "@regression"] },
    async ({ page }) => {
      // Allow backend errors — npx server may return transient errors while starting
      (page as any).allowFlowErrors();

      await test.step("Open blank flow", async () => {
        await awaitBootstrapTest(page);
        await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
        createdFlowId = await openBlankFlow(page);
      });

      await test.step("Register everything server via JSON and wait for tools", async () => {
        const authHeader = await getAuthToken(page.request);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: authHeader },
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
