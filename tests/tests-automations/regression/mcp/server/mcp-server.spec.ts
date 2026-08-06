import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { openAddMcpServerModal } from "../../../../helpers/mcp/open-add-mcp-server-modal";
import { addComponentFromSidebarWithoutSearch } from "../../../../helpers/flows/add-component-from-sidebar";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";

/**
 * Add-MCP-Server modal: stdio / HTTP registration, field persistence and tool
 * refresh. Spec doc: `docs/mcp/server/mcp-server.md`.
 *
 * STDIO CONTRACT (#1091). Langflow requires `command` to be a SINGLE executable
 * — options and the package go in `args`. Registering
 * "npx @modelcontextprotocol/server-everything" as the command is refused with
 * a 422 ("MCP stdio command must be a single executable name or path"). The
 * rule arrived with the multi-tenant hardening forward-port (upstream #14073,
 * 2026-07-15) so every policy layer sees the same argv; `npx`/`uvx` themselves
 * are still allowlisted. Every stdio registration below therefore fills
 * `stdio-command-input` with the bare executable and `stdio-args_N` with the
 * rest. The last test in this file pins that contract directly.
 */

// Package runners are `npx`, not `uvx`, wherever the subprocess must actually
// come up: the published `mcp-server-fetch`/`mcp-server-time` packages this file
// used to register now fail at import against the current `mcp` Python SDK
// (`McpError` renamed to `MCPError`), and pinning the server version does not
// help because its `mcp` dependency floats. That is a third-party breakage, not
// Langflow's — see the spec doc. `uvx` stays covered as a command by the
// field-persistence test, which never starts the subprocess.
const NPX = "npx";
const PKG_EVERYTHING = "@modelcontextprotocol/server-everything";
const PKG_SEQUENTIAL = "@modelcontextprotocol/server-sequential-thinking";

// `npx` downloads the package on a cold container, so the FIRST tool list of a
// run can take far longer than every dropdown interaction that follows it. The
// sibling stdio test in `mcp-client-regression.spec.ts` needed exactly this
// budget for the same reason (#463); the 30 s this file carried was never
// exercised in CI, because none of these tests were `@stable` until #1091.
const TOOL_LIST_TIMEOUT = 120_000;

// Flow ids observed on `POST /api/v1/flows` 201, plus the MCP servers each test
// registered. Pattern A from authoring-conventions: `awaitBootstrapTest` runs
// before the blank-flow / starter click, so the canvas URL id is the stale
// bootstrap one (#681) and only the response ids are trustworthy. Deleting a
// transient id 404s harmlessly — `deleteFlow` treats 404 as done.
const createdFlowIds: string[] = [];
const registeredServers: string[] = [];

/** Server names currently registered on the instance. */
async function listMcpServerNames(page: Page): Promise<string[]> {
  const authHeader = await getAuthToken(page.request);
  const resp = await page.request.get("/api/v2/mcp/servers", {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  // Checked, not assumed: an error body is not an array, so an unchecked read
  // fails as `servers.map is not a function` inside whichever assertion called
  // this — hiding the status that actually explains the run.
  if (!resp.ok()) {
    throw new Error(
      `GET /api/v2/mcp/servers: ${resp.status()} — ${await resp.text()}`,
    );
  }
  const servers: Array<{ name: string }> = await resp.json();
  return servers.map((s) => s.name);
}

test.beforeEach(async ({ page }) => {
  createdFlowIds.length = 0;
  registeredServers.length = 0;
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
});

// Id-scoped cleanup — never a wipe (#553). The servers are listed first so a
// test that already deleted its own through the UI (the happy path for most of
// them) does not issue a 404 delete on every run.
test.afterEach(async ({ request }) => {
  const names = registeredServers.splice(0);
  const ids = createdFlowIds.splice(0);
  if (names.length === 0 && ids.length === 0) return;

  const bearer = await getAuthToken(request);
  const options = bearer ? { headers: { Authorization: bearer } } : undefined;

  if (names.length > 0) {
    const resp = await request.get("/api/v2/mcp/servers", options);
    const existing: string[] = resp.ok()
      ? ((await resp.json()) as Array<{ name: string }>).map((s) => s.name)
      : names;
    for (const name of names) {
      if (existing.includes(name)) {
        const del = await request.delete(
          `/api/v2/mcp/servers/${name}`,
          options,
        );
        // Warn rather than throw: the flow cleanup below still has to run, and
        // a silent failure here is what lets registered servers accumulate on
        // the shared instance (the buildup #545 set out to stop).
        if (!del.ok()) {
          console.warn(
            `⚠️  MCP server cleanup failed: ${name} — ${del.status()} ${await del.text()}`,
          );
        }
      }
    }
  }

  // Deliberately NOT swallowed, unlike the precedent in
  // `agent-tool-name-validation.spec.ts` — `deleteFlow` throws so a cleanup
  // regression is visible instead of silent (see its docstring). A transient id
  // 404s, which it treats as done, so this only fires on a real failure.
  for (const id of ids) {
    await deleteFlow(request, id, options);
  }
});

// Quarantined for #1266 — recurrent flake on a TRANSPORT-level signature:
// `apiRequestContext.get: Timeout 20000ms exceeded.` on GET
// /api/v2/mcp/servers?action_count=true, same signature on the 2026-07-30,
// 2026-08-03 and 2026-08-04 dailies. Filed as load/reachability about this
// spec, not about changing tool mode (CONTRIBUTING.md -> Infra-signature
// exemption: a spec that keeps appearing as collateral while others do not).
// Lifting the quarantine (remove test.fixme + restore @stable) is a
// deliverable of #1266.
test.fixme(
  "user must be able to change mode of MCP tools without any issues",
  { tag: ["@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    (page as any).allowFlowErrors();
    await page.waitForTimeout(5000);

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();
    // Use the first available MCP server component instead of a specific one
    const firstServerBtn = page.locator('[data-testid^="add-component-button-"]').first();
    await expect(firstServerBtn).toBeVisible({ timeout: 30000 });
    await firstServerBtn.click();

    // See if the color matches

    const isDark = await page.evaluate(() => {
      return document.body.classList.contains("dark");
    });

    for (const path of await page
      .getByTestId("generic-node-title-arrangement")
      .getByTestId("icon-Mcp")
      .locator("path")
      .all()) {
      const color = await path.evaluate(
        (el) => window.getComputedStyle(el).fill,
      );
      expect(color).toBe(isDark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)");
    }

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    await openAddMcpServerModal(page);

    await page.getByTestId("stdio-tab").click();

    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_server_${randomSuffix}`;
    registeredServers.push(testName);
    await page.getByTestId("stdio-name-input").fill(testName);

    await page.getByTestId("stdio-command-input").fill(NPX);
    await page.getByTestId("stdio-args_0").fill(PKG_EVERYTHING);

    await page.getByTestId("add-mcp-server-button").click();

    // Poll API until server tools are loaded before interacting with dropdown
    await expect
      .poll(
        async () => {
          const resp = await page.request.get(
            "/api/v2/mcp/servers?action_count=true",
          );
          const servers: Array<{ name: string; toolsCount: number | null }> =
            await resp.json();
          return servers.find((s) => s.name === testName)?.toolsCount ?? null;
        },
        { timeout: TOOL_LIST_TIMEOUT, intervals: [3000] },
      )
      .not.toBeNull();

    await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
      timeout: 30000,
    });

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

    await adjustScreenView(page);

    // The selected tool's own inputs arrive with a node rebuild that lands a
    // beat after the option click, so this needs an auto-retrying assertion —
    // a bare count() samples the node before `message` is on it. The `@stable`
    // sibling that selects the same echo tool waits the same way
    // (`mcp-client-regression.spec.ts`), which is why it never hit this race;
    // here it stayed invisible because the registration above had been failing
    // since 2026-07-15 and the test never got this far (#1091).
    await expect(page.getByTestId("popover-anchor-input-message")).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("user_menu_button").click({ timeout: 3000 });

    await page.getByTestId("menu_settings_button").click({ timeout: 3000 });

    await page.waitForTimeout(500);

    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });

    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 3000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 3000,
    });

    await expect(page.getByText(testName)).toBeVisible({
      timeout: 3000,
    });

    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 3000 });

    await page
      .getByText("Edit", { exact: true })
      .first()
      .click({ timeout: 3000 });

    await page.waitForTimeout(500);

    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await expect(page.getByTestId("json-tab")).toBeDisabled({
      timeout: 3000,
    });

    await expect(page.getByTestId("stdio-tab")).not.toBeDisabled({
      timeout: 3000,
    });

    await expect(page.getByTestId("http-tab")).toBeDisabled({
      timeout: 3000,
    });

    // Both halves of the split must round-trip: a backend that dropped `args`
    // on save would still show the right command.
    expect(await page.getByTestId("stdio-command-input").inputValue()).toBe(NPX);
    expect(await page.getByTestId("stdio-args_0").inputValue()).toBe(
      PKG_EVERYTHING,
    );

    await page.waitForTimeout(500);

    await page.getByTestId("add-mcp-server-button").click();

    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 30000 });

    await page.waitForTimeout(500);

    await page
      .getByText("Delete", { exact: true })
      .first()
      .click({ timeout: 3000 });

    await page.waitForSelector(
      '[data-testid="btn_delete_delete_confirmation_modal"]',
      {
        timeout: 3000,
      },
    );

    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .click({ timeout: 3000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 3000,
    });

    await expect(page.getByText(testName)).not.toBeVisible({
      timeout: 10000,
    });
  },
);

test(
  "user must be able to add and delete MCP server from sidebar",
  { tag: ["@release", "@workspace", "@components", "@mcp", "@stable"] },
  async ({ page }) => {
    (page as any).allowFlowErrors();
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();

    await page.waitForTimeout(500);

    const sidebarButton = page.getByTestId("sidebar-add-mcp-server-button");
    const fallbackButton = page.getByTestId("add-mcp-server-button-sidebar");

    if (await sidebarButton.isVisible({ timeout: 30000 }).catch(() => false)) {
      await sidebarButton.click();
    } else {
      await fallbackButton.click();
    }
    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("stdio-tab").click();

    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_server_${randomSuffix}`;
    registeredServers.push(testName);
    await page.getByTestId("stdio-name-input").fill(testName);

    await page.waitForTimeout(500);

    await page.getByTestId("stdio-command-input").fill(NPX);
    await page.getByTestId("stdio-args_0").fill(PKG_EVERYTHING);

    await page.getByTestId("add-mcp-server-button").click();

    await page
      .getByTestId(`add-component-button-${testName}`)
      .click({ timeout: 30000 });

    // Component added to canvas — verify the MCPTools node is present
    // MCPTools node is present on canvas with the new server
    await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
      timeout: 30000,
    });

    // Verify server appears in Settings → MCP Servers and can be deleted
    await page.getByTestId("user_menu_button").click({ timeout: 3000 });
    await page.getByTestId("menu_settings_button").click({ timeout: 3000 });
    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });
    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 3000 });
    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 10000,
    });
    await expect(page.getByText(testName)).toBeVisible({ timeout: 5000 });

    // Delete the server from Settings
    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 5000 });
    await page.getByText("Delete", { exact: true }).first().click({ timeout: 3000 });
    await page.waitForSelector(
      '[data-testid="btn_delete_delete_confirmation_modal"]',
      { timeout: 3000 },
    );
    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .click({ timeout: 3000 });
    await expect(page.getByText(testName)).not.toBeVisible({ timeout: 10000 });
    await page.goto("/");
  },
);

test(
  "STDIO MCP server fields should persist after saving and editing",
  { tag: ["@release", "@workspace", "@components", "@mcp", "@stable"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();
    await page.waitForSelector(
      '[data-testid="add-component-button-lf-starter_project"]',
      {
        timeout: 30000,
      },
    );
    await addComponentFromSidebarWithoutSearch(
      page,
      "add-component-button-lf-starter_project",
    );

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    await openAddMcpServerModal(page);

    // Go to STDIO tab and fill all fields
    await page.getByTestId("stdio-tab").click();
    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    // Test data with random suffix
    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_stdio_server_${randomSuffix}`;
    registeredServers.push(testName);
    // `uvx` keeps the second allowlisted package runner covered as a COMMAND.
    // `mcp-server-test` is deliberately a package that does not exist: this test
    // asserts form persistence, and registration is accepted independently of
    // whether the subprocess ever starts.
    const testCommand = "uvx";
    const testPackageArg = "mcp-server-test";
    const testArg1 = "--verbose";
    const testArg2 = "--port=8080";
    const testArg3 = "--config=test.json";
    const testEnvKey1 = "NODE_ENV";
    const testEnvValue1 = "production";
    const testEnvKey2 = "DEBUG_MODE";
    const testEnvValue2 = "true";

    // Fill basic fields
    await page.getByTestId("stdio-name-input").fill(testName);
    await page.getByTestId("stdio-command-input").fill(testCommand);

    // The package that used to be glued onto the command is now args[0]
    await page.getByTestId("stdio-args_0").fill(testPackageArg);

    // Add first option by clicking plus button
    await page.getByTestId("input-list-plus-btn_-0").click();
    await page.getByTestId("stdio-args_1").fill(testArg1);

    // Add second option
    await page.getByTestId("input-list-plus-btn_-0").click();
    await page.getByTestId("stdio-args_2").fill(testArg2);

    // Add third option
    await page.getByTestId("input-list-plus-btn_-0").click();
    await page.getByTestId("stdio-args_3").fill(testArg3);

    // Add first environment variable
    await page.getByTestId("stdio-env-key-0").fill(testEnvKey1);
    await page.getByTestId("stdio-env-value-0").fill(testEnvValue1);

    // Add second environment variable
    await page.getByTestId("stdio-env-plus-btn-0").click();
    await page.getByTestId("stdio-env-key-1").fill(testEnvKey2);
    await page.getByTestId("stdio-env-value-1").fill(testEnvValue2);

    // Save the server
    await page.getByTestId("add-mcp-server-button").click();

    // Go to settings to edit the server
    await page.getByTestId("user_menu_button").click({ timeout: 30000 });
    await page.getByTestId("menu_settings_button").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });
    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 3000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 3000,
    });

    // Find and edit the server
    await expect(page.getByText(testName)).toBeVisible({
      timeout: 3000,
    });

    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 3000 });

    await page
      .getByText("Edit", { exact: true })
      .first()
      .click({ timeout: 3000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    // Verify all fields persisted correctly
    expect(await page.getByTestId("stdio-name-input").inputValue()).toBe(
      testName,
    );
    expect(await page.getByTestId("stdio-command-input").inputValue()).toBe(
      testCommand,
    );
    expect(await page.getByTestId("stdio-args_0").inputValue()).toBe(
      testPackageArg,
    );
    expect(await page.getByTestId("stdio-args_1").inputValue()).toBe(testArg1);
    expect(await page.getByTestId("stdio-args_2").inputValue()).toBe(testArg2);
    expect(await page.getByTestId("stdio-args_3").inputValue()).toBe(testArg3);
    expect(await page.getByTestId("stdio-env-key-0").last().inputValue()).toBe(
      testEnvKey1,
    );
    expect(
      await page.getByTestId("stdio-env-value-0").last().inputValue(),
    ).toBe(testEnvValue1);
    expect(await page.getByTestId("stdio-env-key-1").last().inputValue()).toBe(
      testEnvKey2,
    );
    expect(
      await page.getByTestId("stdio-env-value-1").last().inputValue(),
    ).toBe(testEnvValue2);

    // Clean up - cancel the edit modal
    await page.keyboard.press("Escape");

    // Delete the test server
    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 3000 });

    await page
      .getByText("Delete", { exact: true })
      .first()
      .click({ timeout: 3000 });

    await page.waitForSelector(
      '[data-testid="btn_delete_delete_confirmation_modal"]',
      {
        timeout: 3000,
      },
    );

    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .click({ timeout: 3000 });
  },
);

test(
  "HTTP/SSE MCP server fields should persist after saving and editing",
  { tag: ["@release", "@workspace", "@components", "@mcp", "@stable"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();
    await page.waitForSelector(
      '[data-testid="add-component-button-lf-starter_project"]',
      {
        timeout: 30000,
      },
    );
    await addComponentFromSidebarWithoutSearch(
      page,
      "add-component-button-lf-starter_project",
    );

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    await openAddMcpServerModal(page);

    // Go to HTTP tab and fill all fields
    await page.getByTestId("http-tab").click();
    await page.waitForSelector('[data-testid="http-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    // Test data with random suffix
    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_http_server_${randomSuffix}`;
    registeredServers.push(testName);
    const testUrl = "https://api.example.com/mcp";
    const testHeaderKey1 = "Authorization";
    const testHeaderValue1 = "Bearer token123";
    const testHeaderKey2 = "Content-Type";
    const testHeaderValue2 = "application/json";
    const testEnvKey1 = "API_TIMEOUT";
    const testEnvValue1 = "30000";
    const testEnvKey2 = "RETRY_COUNT";
    const testEnvValue2 = "3";

    // Fill basic fields
    await page.getByTestId("http-name-input").fill(testName);
    await page.getByTestId("http-url-input").fill(testUrl);

    // Add first header
    await page.getByTestId("http-headers-key-0").fill(testHeaderKey1);
    await page
      .getByTestId("popover-anchor-http-headers-value-0")
      .first()
      .fill(testHeaderValue1);

    // Add second header
    await page.getByTestId("http-headers-plus-btn-0").click();
    await page.getByTestId("http-headers-key-1").fill(testHeaderKey2);
    // Use nth(1) to get the second value field
    await page
      .getByTestId("popover-anchor-http-headers-value-1")
      .first()
      .fill(testHeaderValue2);

    // Add first environment variable
    await page.getByTestId("http-env-key-0").fill(testEnvKey1);
    await page.getByTestId("http-env-value-0").fill(testEnvValue1);

    // Add second environment variable
    await page.getByTestId("http-env-plus-btn-0").click();
    await page.getByTestId("http-env-key-1").fill(testEnvKey2);
    await page.getByTestId("http-env-value-1").fill(testEnvValue2);

    // Save the server
    await page.getByTestId("add-mcp-server-button").click();

    // Wait for save to complete and modal to close
    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "hidden",
      timeout: 30000,
    });

    // Go to settings to edit the server
    await page.getByTestId("user_menu_button").click({ timeout: 30000 });
    await page.getByTestId("menu_settings_button").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });
    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 30000,
    });

    // Find and edit the server
    await expect(page.getByText(testName)).toBeVisible({
      timeout: 10000,
    });

    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 10000 });

    await page
      .getByText("Edit", { exact: true })
      .first()
      .click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    // Wait for form fields to be populated
    await page.waitForSelector('[data-testid="http-name-input"]', {
      state: "visible",
      timeout: 10000,
    });
    await page.waitForSelector(
      '[data-testid="popover-anchor-http-headers-value-0"]',
      {
        state: "visible",
        timeout: 10000,
      },
    );

    // Verify all fields persisted correctly
    expect(await page.getByTestId("http-name-input").inputValue()).toBe(
      testName,
    );
    expect(await page.getByTestId("http-url-input").inputValue()).toBe(testUrl);
    expect(await page.getByTestId("http-headers-key-0").inputValue()).toBe(
      testHeaderKey1,
    );
    // Header values use InputComponent with global variables
    expect(
      await page
        .getByTestId("popover-anchor-http-headers-value-0")
        .first()
        .inputValue(),
    ).toBe(testHeaderValue1);
    expect(await page.getByTestId("http-headers-key-1").inputValue()).toBe(
      testHeaderKey2,
    );
    expect(
      await page
        .getByTestId("popover-anchor-http-headers-value-1")
        .first()
        .inputValue(),
    ).toBe(testHeaderValue2);
    expect(await page.getByTestId("http-env-key-0").inputValue()).toBe(
      testEnvKey1,
    );
    expect(await page.getByTestId("http-env-value-0").inputValue()).toBe(
      testEnvValue1,
    );
    expect(await page.getByTestId("http-env-key-1").inputValue()).toBe(
      testEnvKey2,
    );
    expect(await page.getByTestId("http-env-value-1").inputValue()).toBe(
      testEnvValue2,
    );

    // Clean up - cancel the edit modal
    await page.keyboard.press("Escape");

    // Delete the test server
    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 10000 });

    await page
      .getByText("Delete", { exact: true })
      .first()
      .click({ timeout: 10000 });

    await page.waitForSelector(
      '[data-testid="btn_delete_delete_confirmation_modal"]',
      {
        timeout: 10000,
      },
    );

    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .click({ timeout: 10000 });
  },
);

test(
  "mcp server tools should be refreshed when editing a server",
  { tag: ["@release", "@workspace", "@components", "@mcp", "@stable"] },
  async ({ page }) => {
    // Three `TOOL_LIST_TIMEOUT` waits (register A, edit to B, re-register A)
    // plus the settings round-trips do not fit the suite's 5-minute per-test
    // cap. Without this the test would die at the TEST timeout on a slow npm
    // registry instead of at the wait that actually ran out — the unattributed
    // timeout that costs a triage cycle to explain (#1011/#1019).
    test.setTimeout(8 * 60 * 1000);

    await page.waitForTimeout(5000);

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    // The flow under test has to be addressed by id from here on (#1340), and
    // the id has to satisfy BOTH sources — neither alone is enough here:
    //
    //  - `page.url()` alone is the documented trap. `awaitBootstrapTest` reaches
    //    the templates modal through "New Flow", so before the blank-flow
    //    navigation the URL still carries the bootstrap PLACEHOLDER — the flow
    //    Langflow deletes the moment the modal navigates elsewhere, and the one
    //    authoring-conventions Pattern A warns about (#681/#505).
    //  - the tracked `POST /flows` 201 ids alone do not say which flow the editor
    //    ended up on: this page creates the placeholder AND the blank flow, so
    //    picking one means trusting arrival order of two async body reads, and
    //    the wrong pick is precisely the id that gets deleted.
    //
    // So: poll until the editor's URL carries an id this page is known to have
    // created and that is not the placeholder. A transient or client-only id
    // cannot satisfy the membership test, and a blank-flow click that never
    // navigates fails HERE, naming the cause, instead of surfacing later as an
    // unattributed timeout. Measured on nightly 1.12.0.dev18: the click issues
    // its own `POST /flows` 201 and the URL changes every time (5/5) — the
    // placeholder is never reused — so this is about attribution, not a defect.
    const placeholderId = new URL(page.url()).pathname.match(
      /\/flow\/([0-9a-f-]{36})/,
    )?.[1];
    await page.getByTestId("blank-flow").click();
    const editorFlowId = () =>
      new URL(page.url()).pathname.match(/\/flow\/([0-9a-f-]{36})/)?.[1];
    await expect
      .poll(
        () => {
          const id = editorFlowId();
          return !!id && id !== placeholderId && createdFlowIds.includes(id);
        },
        {
          timeout: 30000,
          message:
            "the blank-flow click never landed the editor on a newly created " +
            "flow: the URL still holds the bootstrap placeholder, or its id is " +
            "not among this page's POST /api/v1/flows 201 responses",
        },
      )
      .toBe(true);
    const flowUnderTest = editorFlowId()!;
    await page.getByTestId("sidebar-nav-mcp").click();
    await page.waitForSelector(
      '[data-testid="add-component-button-lf-starter_project"]',
      {
        timeout: 30000,
      },
    );
    await addComponentFromSidebarWithoutSearch(
      page,
      "add-component-button-lf-starter_project",
    );

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    // Postcondition gate kept from the pre-#1087 sequence: adjustScreenView already
    // leaves the menu closed by reading the trigger's `data-state` (#1053), so this
    // only ASSERTS that it did — failing here, naming the canvas controls, instead
    // of ~60 lines down as "<html> intercepts pointer events" on the
    // mcp-server-dropdown click (#576). The `keyboard.press("Escape")` that used to
    // precede it is gone on purpose: it would mask that regression (#997).
    await expect(page.getByTestId("zoom_out")).toBeHidden();

    await openAddMcpServerModal(page);

    await page.getByTestId("stdio-tab").click();

    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_server_${randomSuffix}`;
    registeredServers.push(testName);
    await page.getByTestId("stdio-name-input").fill(testName);

    // Server A — sequential-thinking serves exactly one tool, so the tool list
    // it produces is unambiguous when compared against server B's below.
    await page.getByTestId("stdio-command-input").fill(NPX);
    await page.getByTestId("stdio-args_0").fill(PKG_SEQUENTIAL);

    await page.getByTestId("add-mcp-server-button").click();

    // Wait for save to complete and modal to close
    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "hidden",
      timeout: 30000,
    });

    await page.waitForSelector(
      '[data-testid="dropdown_str_tool"]:not([disabled])',
      {
        timeout: TOOL_LIST_TIMEOUT,
        state: "visible",
      },
    );

    await page.getByTestId("dropdown_str_tool").click();

    await page.waitForSelector('[data-testid="sequentialthinking-0-option"]', {
      state: "visible",
      timeout: 10000,
    });

    const sequentialOptionCount = await page
      .getByTestId("sequentialthinking-0-option")
      .count();

    expect(sequentialOptionCount).toBeGreaterThan(0);

    await page.getByTestId("sequentialthinking-0-option").click();

    // Fit view only — no zoom step here. The helper waits on
    // `canvas_controls_dropdown` itself (30 s), which subsumes the explicit
    // 10 s wait this sequence used to open with.
    await adjustScreenView(page, { numberOfZoomOut: 0 });

    // The selected tool's OWN inputs must render on the node. `sequentialthinking`
    // exposes `thoughtNumber` (integer) and `thought` (string); the node lowercases
    // integer names into `int_int_<name>` but keeps the case of string inputs.
    await page.waitForSelector('[data-testid="int_int_thoughtnumber"]', {
      state: "visible",
      timeout: 30000,
    });

    const thoughtNumberOptionCount = await page
      .getByTestId("int_int_thoughtnumber")
      .count();

    expect(thoughtNumberOptionCount).toBeGreaterThan(0);

    const thoughtOptionCount = await page
      .getByTestId("anchor-popover-anchor-input-thought")
      .count();

    expect(thoughtOptionCount).toBeGreaterThan(0);

    await page.getByTestId("user_menu_button").click({ timeout: 10000 });

    await page.getByTestId("menu_settings_button").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });

    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 30000,
    });

    await expect(page.getByText(testName)).toBeVisible({
      timeout: 10000,
    });

    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 10000 });

    await page
      .getByText("Edit", { exact: true })
      .first()
      .click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await expect(page.getByTestId("json-tab")).toBeDisabled({
      timeout: 10000,
    });

    await expect(page.getByTestId("stdio-tab")).not.toBeDisabled({
      timeout: 10000,
    });

    await expect(page.getByTestId("http-tab")).toBeDisabled({
      timeout: 10000,
    });

    // Wait for command input to be populated
    await page.waitForSelector('[data-testid="stdio-command-input"]', {
      state: "visible",
      timeout: 10000,
    });

    expect(await page.getByTestId("stdio-command-input").inputValue()).toBe(NPX);
    expect(await page.getByTestId("stdio-args_0").inputValue()).toBe(
      PKG_SEQUENTIAL,
    );

    // Switch to server B. Both runners are `npx` now that the command field
    // holds a bare executable, so the package in args[0] is what changes — which
    // also proves `args` round-trips through an edit, not only through a create.
    await page.getByTestId("stdio-args_0").fill(PKG_EVERYTHING);

    await page.getByTestId("add-mcp-server-button").click();

    // Wait for save to complete and modal to close
    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "hidden",
      timeout: 30000,
    });

    await awaitBootstrapTest(page, { skipModal: true });

    // By id, never a name-filtered `list-card` + `.first()` (#1340). Langflow
    // names every blank flow "New Flow"/"New Flow (N)", so under `fullyParallel`
    // that filter resolves whichever card the shared project's list puts first.
    // Measured on nightly 1.12.0.dev18: seeding ONE competing "New Flow …" in
    // this project before the list fetch is enough — the click opened the
    // competitor, and the test then died on the `text="MCP Tools"` wait below,
    // blaming the node for a flow it was never in. `openFlowById` also seeds the
    // assistant-onboarding flag and gates on the flow being writable, which the
    // card click never did (#1214/#1005).
    await openFlowById(page, flowUnderTest);

    // Wait for the MCP Tools component to be visible on canvas
    await page.waitForSelector('text="MCP Tools"', {
      state: "visible",
      timeout: 30000,
    });
    await page.getByText("MCP Tools", { exact: true }).last().click();
    await adjustScreenView(page);
    // Re-select the server after returning to flow (server reference may be lost after editing)
    await page.waitForSelector('[data-testid="mcp-server-dropdown"]', {
      timeout: 30000,
      state: "visible",
    });
    await page.getByTestId("mcp-server-dropdown").click();
    await page.getByTestId(`list_item_${testName}`).click({ timeout: 10000 });

    await page.waitForSelector(
      '[data-testid="dropdown_str_tool"]:not([disabled])',
      {
        timeout: TOOL_LIST_TIMEOUT,
        state: "visible",
      },
    );

    await page.getByTestId("dropdown_str_tool").click();

    // The refresh under test: the node must serve server B's tools, not the
    // sequential-thinking list it cached before the edit.
    await page.waitForSelector('[data-testid="echo-0-option"]', {
      state: "visible",
      timeout: 10000,
    });

    const echoOptionCount = await page.getByTestId("echo-0-option").count();

    expect(echoOptionCount).toBeGreaterThan(0);

    await expect(
      page.getByTestId("sequentialthinking-0-option"),
    ).toHaveCount(0);

    await page.getByTestId("user_menu_button").click({ timeout: 10000 });

    await page.getByTestId("menu_settings_button").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="sidebar-nav-MCP Servers"]', {
      timeout: 30000,
    });

    await page.getByTestId("sidebar-nav-MCP Servers").click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 30000,
    });
    await page
      .getByTestId(`mcp-server-menu-button-${testName}`)
      .click({ timeout: 10000 });

    await page
      .getByText("Delete", { exact: true })
      .first()
      .click({ timeout: 10000 });

    await page.waitForSelector(
      '[data-testid="btn_delete_delete_confirmation_modal"]',
      {
        timeout: 10000,
      },
    );

    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .click({ timeout: 10000 });

    await page.waitForSelector('[data-testid="add-mcp-server-button-page"]', {
      timeout: 10000,
    });

    await expect(page.getByText(testName)).not.toBeVisible({
      timeout: 10000,
    });

    await page.getByTestId("add-mcp-server-button-page").click();

    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("stdio-tab").click();

    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("stdio-name-input").fill(testName);

    // Re-register as server A — the node's tool list must go back to A's tools.
    await page.getByTestId("stdio-command-input").fill(NPX);
    await page.getByTestId("stdio-args_0").fill(PKG_SEQUENTIAL);

    await page.getByTestId("add-mcp-server-button").click();

    await expect(page.getByText(testName)).toBeVisible({
      timeout: 10000,
    });

    await awaitBootstrapTest(page, { skipModal: true });

    // See note above: by id, not by name.
    await openFlowById(page, flowUnderTest);

    // Wait for the MCP Tools component to be visible on canvas
    await page.waitForSelector('text="MCP Tools"', {
      state: "visible",
      timeout: 30000,
    });
    await page.getByText("MCP Tools", { exact: true }).last().click();

    // Re-select the server after returning to flow (server reference may be lost after editing)
    await page.waitForSelector('[data-testid="mcp-server-dropdown"]', {
      timeout: 30000,
      state: "visible",
    });
    await page.getByTestId("mcp-server-dropdown").click();
    await page.getByTestId(`list_item_${testName}`).click({ timeout: 10000 });

    await page.waitForSelector(
      '[data-testid="dropdown_str_tool"]:not([disabled])',
      {
        timeout: TOOL_LIST_TIMEOUT,
        state: "visible",
      },
    );

    await page.getByTestId("dropdown_str_tool").click();

    await page.waitForSelector('[data-testid="sequentialthinking-0-option"]', {
      state: "visible",
      timeout: 10000,
    });

    const sequentialOptionCount2 = await page
      .getByTestId("sequentialthinking-0-option")
      .count();

    expect(sequentialOptionCount2).toBeGreaterThan(0);
  },
);

test(
  "Streamable HTTP MCP server with server-everything should load tools correctly",
  { tag: ["@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    (page as any).allowFlowErrors();
    await awaitBootstrapTest(page);

    // Get the project's streamable HTTP endpoint from the Langflow API.
    // The /api/v1/projects/ response shape varies (sometimes a bare array,
    // sometimes `{ folders: [...] }`); api-folders-crud.spec.ts normalizes
    // the same way.
    const projectsResp = await page.request.get("/api/v1/projects/");
    const projectsRaw = await projectsResp.json();
    const projects: Array<{ id: string; name: string }> = Array.isArray(projectsRaw)
      ? projectsRaw
      : (projectsRaw.folders ?? []);
    expect(projects.length).toBeGreaterThan(0);
    const projectId = projects[0].id;
    // Derive base from PLAYWRIGHT_BASE_URL so the test works against any Langflow instance,
    // not only the default localhost:7860.
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860/";
    const server = new URL(
      `/api/v1/mcp/project/${projectId}/streamable`,
      baseUrl,
    ).toString();

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();

    // Sidebar trigger has two testid variants depending on whether MCP servers already
    // exist — match the fallback pattern used by other tests in this file (lines 211-218).
    const sidebarButton = page.getByTestId("sidebar-add-mcp-server-button");
    const fallbackButton = page.getByTestId("add-mcp-server-button-sidebar");
    if (await sidebarButton.isVisible({ timeout: 15000 }).catch(() => false)) {
      await sidebarButton.evaluate((el) => (el as HTMLElement).click());
    } else {
      await fallbackButton.click();
    }

    await expect(page.getByTestId("add-mcp-server-button")).toBeVisible({
      timeout: 15000,
    });

    // Switch to HTTP tab for Streamable HTTP
    await page.getByTestId("http-tab").click();

    await page.waitForSelector('[data-testid="http-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    const randomSuffix = Math.floor(Math.random() * 90000) + 10000;
    const testName = `test_streamable_http_${randomSuffix}`;
    registeredServers.push(testName);

    await page.getByTestId("http-name-input").fill(testName);
    await page.getByTestId("http-url-input").fill(server);
    await page.getByTestId("add-mcp-server-button").click();

    await expect(
      page.getByTestId(`add-component-button-${testName}`),
    ).toBeVisible({ timeout: 30000 });
    await page.getByTestId(`add-component-button-${testName}`).click();

    await zoomOut(page, 3);

    // The Langflow MCP endpoint exposes project flows as tools
    // Poll API until toolsCount is available
    await expect
      .poll(
        async () => {
          const resp = await page.request.get(
            "/api/v2/mcp/servers?action_count=true",
          );
          const servers: Array<{ name: string; toolsCount: number | null }> =
            await resp.json();
          return servers.find((s) => s.name === testName)?.toolsCount ?? null;
        },
        { timeout: 60000, intervals: [3000] },
      )
      .not.toBeNull();

    await page.evaluate(() => {
      (
        document.querySelector('[data-testid="dropdown_str_tool"]') as HTMLElement
      )?.click();
    });

    // Verify at least one tool is available (flows from the project)
    const toolOptions = page.locator('[data-testid*="-option"]');
    await expect(toolOptions.first()).toBeVisible({ timeout: 15000 });
    expect(await toolOptions.count()).toBeGreaterThan(0);

    // Cleanup
    const authHeader = await getAuthToken(page.request);
    await page.request.delete(`/api/v2/mcp/servers/${testName}`, {
      headers: { Authorization: authHeader },
    });
  },
);

test(
  "stdio command with an embedded argument is refused, and command plus args is accepted",
  { tag: ["@regression", "@workspace", "@components", "@mcp", "@stable"] },
  async ({ page }) => {
    // The refused registration is a deliberate 422. The fixture only FAILS a
    // test on flow errors, but this keeps the intent explicit — and the run log
    // will carry one expected `🚨 Backend Error: 422 /api/v2/mcp/servers/...`.
    (page as any).allowFlowErrors();

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-nav-mcp").click();

    // Sidebar trigger, not `openAddMcpServerModal` — this test adds no MCP node
    // to the canvas, and that helper reaches the modal through the node's
    // server dropdown. Two testid variants exist depending on whether servers
    // already exist; same fallback the sidebar tests above use.
    const sidebarButton = page.getByTestId("sidebar-add-mcp-server-button");
    const fallbackButton = page.getByTestId("add-mcp-server-button-sidebar");
    if (await sidebarButton.isVisible({ timeout: 30000 }).catch(() => false)) {
      await sidebarButton.click();
    } else {
      await fallbackButton.click();
    }
    await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
      state: "visible",
      timeout: 30000,
    });

    await page.getByTestId("stdio-tab").click();

    await page.waitForSelector('[data-testid="stdio-name-input"]', {
      state: "visible",
      timeout: 30000,
    });

    const randomSuffix = Math.floor(Math.random() * 90000) + 10000; // 5-digit random number
    const testName = `test_contract_${randomSuffix}`;
    registeredServers.push(testName);
    await page.getByTestId("stdio-name-input").fill(testName);

    await test.step("an executable with the package glued on is refused", async () => {
      await page
        .getByTestId("stdio-command-input")
        .fill(`${NPX} ${PKG_EVERYTHING}`);

      await page.getByTestId("add-mcp-server-button").click();

      // The dialog surfaces the policy message and stays open.
      await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
        /single executable name or path/i,
        { timeout: 15000 },
      );
      await expect(page.getByTestId("add-mcp-server-button")).toBeVisible();

      // Asserted against the API too: a modal that stayed open while the server
      // was created anyway would satisfy a UI-only check.
      expect(await listMcpServerNames(page)).not.toContain(testName);
    });

    await test.step("the same registration split into command + args is accepted", async () => {
      await page.getByTestId("stdio-command-input").fill(NPX);
      await page.getByTestId("stdio-args_0").fill(PKG_EVERYTHING);

      await page.getByTestId("add-mcp-server-button").click();

      await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
        timeout: 30000,
      });

      // The accepted half is what proves the validation discriminates rather
      // than refusing everything.
      expect(await listMcpServerNames(page)).toContain(testName);

      const authHeader = await getAuthToken(page.request);
      const stored = await (
        await page.request.get(`/api/v2/mcp/servers/${testName}`, {
          headers: authHeader ? { Authorization: authHeader } : undefined,
        })
      ).json();
      expect(stored.command).toBe(NPX);
      expect(stored.args).toEqual([PKG_EVERYTHING]);
    });
  },
);

// test(
//   "SSE MCP server with deepwiki should load tools correctly",
//   { tag: ["@release", "@workspace", "@components", "@mcp"] },
//   async ({ page }) => {
//     await page.waitForTimeout(5000);

//     // Start the MCP server with proper health checking
//     const server = "https://observability.mcp.cloudflare.com/mcp";

//     await awaitBootstrapTest(page);

//     await page.waitForSelector('[data-testid="blank-flow"]', {
//       timeout: 30000,
//     });
//     await page.getByTestId("blank-flow").click();
//     await page.getByTestId("sidebar-search-input").click();
//     await page.getByTestId("sidebar-search-input").fill("mcp tools");

//     await page.waitForSelector('[data-testid="models_and_agentsMCP Tools"]', {
//       timeout: 30000,
//     });

//     await page
//       .getByTestId("models_and_agentsMCP Tools")
//       .dragTo(page.locator('//*[@id="react-flow-id"]'), {
//         targetPosition: { x: 100, y: 100 },
//       });

//     await adjustScreenView(page, { numberOfZoomOut: 3 });

//     await openAddMcpServerModal(page);

//     // Switch to HTTP tab for SSE
//     await page.getByTestId("http-tab").click();

//     await page.waitForSelector('[data-testid="http-name-input"]', {
//       state: "visible",
//       timeout: 30000,
//     });

//     const randomSuffix = Math.floor(Math.random() * 90000) + 10000;
//     const testName = `test_sse_${randomSuffix}`;

//     // Fill in the server details
//     await page.getByTestId("http-name-input").fill(testName);

//     // Use the HTTP endpoint URL
//     await page.getByTestId("http-url-input").fill(server);

//     await page.getByTestId("add-mcp-server-button").click();

//     // Wait for tools to load with proper timeout (external server can be slow in CI)
//     await page.waitForSelector(
//       '[data-testid="dropdown_str_tool"]:not([disabled])',
//       {
//         timeout: 30000,
//         state: "visible",
//       },
//     );

//     await page.getByTestId("dropdown_str_tool").click();

//     // Check for tools from wiki
//     const toolOptions = page.locator('[data-testid*="-option"]');
//     const toolCount = await toolOptions.count();

//     // server-everything should have multiple tools (at least 5+)
//     expect(toolCount).toBeGreaterThan(5);

//     // Verify specific tools exist from server-everything
//     const readWikiStructureOption = page.getByTestId(
//       "read_wiki_structure-0-option",
//     );
//     expect(await readWikiStructureOption.count()).toBeGreaterThan(0);

//     // Select the readWikiStructure to verify it loads properly
//     await readWikiStructureOption.last().click();

//     // Wait for the tool input field to appear
//     await page.waitForSelector(
//       '[data-testid="popover-anchor-input-repoName"]',
//       {
//         state: "visible",
//         timeout: 30000,
//       },
//     );

//     // Verify the input field is present
//     await expect(
//       page.getByTestId("popover-anchor-input-repoName"),
//     ).toBeVisible();
//   },
// );
