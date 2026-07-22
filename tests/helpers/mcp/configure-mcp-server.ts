import { expect, type Page } from "@playwright/test";

export interface ConfigureMcpServerOptions {
  /** Unique server name (used as the registration key and sidebar testid). */
  name: string;
  /**
   * MCP server URL. A dummy unreachable URL (e.g. `http://localhost:1/mcp`) is
   * fine when validating configuration/registration rather than connectivity.
   */
  url: string;
}

/**
 * Configure (register) an MCP server end-to-end via the sidebar's HTTP form tab.
 *
 * Precondition: a flow canvas is open (the MCP sidebar nav is reachable).
 * Leaves the modal closed on success. Verifying registration (sidebar entry /
 * `GET /api/v2/mcp/servers`) is the caller's job — this helper only performs the
 * configuration steps.
 *
 * Mirrors the HTTP-form flow validated by
 * `mcp/client/mcp-client-regression.spec.ts`.
 */
export async function configureMcpServer(
  page: Page,
  { name, url }: ConfigureMcpServerOptions,
): Promise<void> {
  await expect(page.getByTestId("sidebar-nav-mcp")).toBeVisible({ timeout: 15000 });
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
  await page.getByTestId("http-name-input").fill(name);
  await page.getByTestId("http-url-input").fill(url);

  await page.getByTestId("add-mcp-server-button").click();
  // The modal closes once registration is accepted.
  await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
    timeout: 10000,
  });
}
