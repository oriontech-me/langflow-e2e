import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";

// The row menu of /settings/connections, and the non-interactive opt-in it carries.
// Spec doc: docs/core-functionality/integrations/connections-row-actions.md
//
// Every locator is keyed on the seeded connection's unique `name`
// (connection-row-<name>, connection-menu-<name>, unattended-<name>): the page
// lists every connection of the superuser the whole suite shares, so nothing
// here may depend on a row's position or on the list's length.
//
// Two connections, one journey each, on purpose: connection writes share a
// per-user bucket of 30/minute and a UI action cannot be retried, so the file
// spends 9 writes per run — three back-to-back validation runs stay under the
// bucket even if they land in one window.
test.describe("Connections page — row actions and the non-interactive opt-in", () => {
  const PAGE = "/settings/connections";
  const OPT_IN = "Allow scheduled and deployed runs";
  // Exact copy, measured on 1.13.0.dev19 (connections.toast.* in the en bundle).
  const TOAST = {
    unattendedOn: "Scheduled and deployed runs may use this connection.",
    unattendedOff: "Scheduled and deployed runs may no longer use this connection.",
    renamed: "Connection renamed.",
    tested: "Credential checked.",
    revoked: "Connection revoked.",
    deleted: "Connection deleted.",
  };

  const seeded: CreatedConnection[] = [];

  test.afterEach(async ({ request }) => {
    const mine = seeded.splice(0);
    if (mine.length === 0) return;
    const headers = { Authorization: await getAuthToken(request) };
    // One list read first: a DELETE that answers 404 is still charged to the
    // per-user write bucket, and test 2 deletes its own connection through the UI.
    const res = await request.get("/api/v1/connections", { headers });
    const live = res.ok()
      ? new Set(((await res.json()) as ConnectionRead[]).map((row) => row.id))
      : null;
    for (const connection of mine) {
      if (live && !live.has(connection.id)) continue;
      await connection.deleteConnection(request).catch((error) => {
        console.warn(`⚠️ Orphan connection left behind (${connection.name}): ${error}`);
      });
    }
  });

  /** The connection as the API lists it, or undefined when it is gone. */
  async function readConnection(
    request: APIRequestContext,
    headers: Record<string, string>,
    name: string,
  ): Promise<ConnectionRead | undefined> {
    const res = await request.get("/api/v1/connections", { headers });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as ConnectionRead[]).find((row) => row.name === name);
  }

  async function openConnectionsPage(page: Page, name: string): Promise<Locator> {
    await page.goto(PAGE);
    const row = page.getByTestId(`connection-row-${name}`);
    await expect(row, `the seeded row ${name} on ${PAGE}`).toBeVisible({ timeout: 30000 });
    return row;
  }

  async function openRowMenu(page: Page, name: string): Promise<Locator> {
    await page.getByTestId(`connection-menu-${name}`).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  /** A success toast by its exact copy, inside the page's alert region. */
  function toast(page: Page, text: string): Locator {
    return page.getByRole("status").getByText(text, { exact: true });
  }

  test(
    "the non-interactive opt-in is off by default, and every change to it shows on the switch and in the API",
    { tag: ["@stable", "@integrations", "@settings"] },
    async ({ page, request }) => {
      const headers = { Authorization: await getAuthToken(request) };
      // Seeded WITHOUT allow_non_interactive: the false read below is the
      // server's default, not an echo of the seed (a flipped default is a
      // silent privilege grant — upstream's risk #8).
      const connection = await createConnectionViaApi(request, headers, { label: "optin" });
      seeded.push(connection);
      // The switch inside the "Allow scheduled and deployed runs" item. The item
      // itself is a plain role=menuitem with no state; the switch carries it.
      const optIn = page.getByTestId(`unattended-${connection.name}`);

      await test.step("a fresh connection reads allow_non_interactive: false from the API", async () => {
        expect(connection.connection.allow_non_interactive, "the create response").toBe(false);
        const row = await readConnection(request, headers, connection.name);
        expect(row, `list row ${connection.name}`).toBeTruthy();
        expect(row?.allow_non_interactive, "the list row").toBe(false);
      });

      await test.step("the row menu shows the opt-in with its switch off", async () => {
        await openConnectionsPage(page, connection.name);
        const menu = await openRowMenu(page, connection.name);
        await expect(menu.getByRole("menuitem", { name: OPT_IN })).toBeVisible();
        await expect(optIn).toHaveAttribute("role", "switch");
        await expect(optIn).toHaveAttribute("aria-checked", "false");
      });

      await test.step("switching it on announces that direction and the API agrees", async () => {
        await optIn.click();
        await expect(toast(page, TOAST.unattendedOn)).toBeVisible();
        await expect(optIn).toHaveAttribute("aria-checked", "true");
        // Read after the toast, which follows the PATCH response: a stale read
        // here is the write-before-commit class of #1759/#1777/#1807.
        const row = await readConnection(request, headers, connection.name);
        expect(row?.allow_non_interactive, "the API after switching on").toBe(true);
      });

      await test.step("switching it off announces the other direction and the API agrees", async () => {
        await optIn.click();
        await expect(toast(page, TOAST.unattendedOff)).toBeVisible();
        await expect(optIn).toHaveAttribute("aria-checked", "false");
        const row = await readConnection(request, headers, connection.name);
        expect(row?.allow_non_interactive, "the API after switching off").toBe(false);
      });

      await test.step("a grant made through the API shows on the switch after a reload", async () => {
        // Upstream's acceptance text, verbatim: "Show state set through the API too."
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        const res = await request.patch(`/api/v1/connections/${connection.id}`, {
          headers,
          data: { allow_non_interactive: true },
        });
        expect(res.status(), await res.text()).toBe(200);
        await page.reload();
        await expect(page.getByTestId(`connection-row-${connection.name}`)).toBeVisible({
          timeout: 30000,
        });
        await openRowMenu(page, connection.name);
        await expect(optIn).toHaveAttribute("aria-checked", "true");
      });
    },
  );

  test(
    "Rename, Check credential, Revoke and Delete each act on the row, and the API agrees",
    { tag: ["@stable", "@integrations", "@settings"] },
    async ({ page, request }) => {
      const headers = { Authorization: await getAuthToken(request) };
      const connection = await createConnectionViaApi(request, headers, { label: "rowactions" });
      seeded.push(connection);
      const row = page.getByTestId(`connection-row-${connection.name}`);
      const renamed = `Renamed ${connection.name}`;

      await test.step("the row shows the seeded connection, ready and never checked", async () => {
        await openConnectionsPage(page, connection.name);
        await expect(row.getByText(connection.displayName, { exact: true })).toBeVisible();
        await expect(row.getByText("Ready", { exact: true })).toBeVisible();
        await expect(row.getByText("Never", { exact: true })).toBeVisible();
      });

      await test.step("Delete is locked while the connection holds a credential", async () => {
        const menu = await openRowMenu(page, connection.name);
        await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(menu.getByRole("menuitem", { name: "Revoke" })).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
      });

      await test.step("Rename prompts with the current name, and the row and the API take the new one", async () => {
        // Rename is a native window.prompt, not a dialog component.
        const prompted = new Promise<{ type: string; message: string; defaultValue: string }>(
          (resolve) => {
            page.once("dialog", async (dialog) => {
              const seen = {
                type: dialog.type(),
                message: dialog.message(),
                defaultValue: dialog.defaultValue(),
              };
              await dialog.accept(renamed);
              resolve(seen);
            });
          },
        );
        await page.getByRole("menu").getByRole("menuitem", { name: "Rename" }).click();
        expect(await prompted).toEqual({
          type: "prompt",
          message: "Rename",
          defaultValue: connection.displayName,
        });
        await expect(toast(page, TOAST.renamed)).toBeVisible();
        await expect(row.getByText(renamed, { exact: true })).toBeVisible();
        const read = await readConnection(request, headers, connection.name);
        expect(read?.display_name, "the API after the rename").toBe(renamed);
      });

      await test.step("Check credential stamps the last check without claiming the credential works", async () => {
        await openRowMenu(page, connection.name);
        await page.getByRole("menu").getByRole("menuitem", { name: "Check credential" }).click();
        await expect(toast(page, TOAST.tested)).toBeVisible();
        await expect(row.getByText("Never", { exact: true })).toHaveCount(0);
        const read = await readConnection(request, headers, connection.name);
        expect(read?.health_checked_at, "health_checked_at after the check").toBeTruthy();
        expect(Number.isNaN(Date.parse(read?.health_checked_at ?? "")), "a parseable timestamp").toBe(
          false,
        );
        // The transition only: the check answered `healthy` for a planted FAKE
        // token, so `healthy` proves nothing about the credential.
        expect(read?.health, "health after the check").not.toBe("unknown");
      });

      await test.step("Revoke moves the badge to Revoked and the API drops the credential", async () => {
        await openRowMenu(page, connection.name);
        await page.getByRole("menu").getByRole("menuitem", { name: "Revoke" }).click();
        await expect(toast(page, TOAST.revoked)).toBeVisible();
        await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
        const read = await readConnection(request, headers, connection.name);
        expect(read).toMatchObject({ status: "revoked", has_credentials: false });
      });

      await test.step("with the credential gone, Delete unlocks and removes the row", async () => {
        const menu = await openRowMenu(page, connection.name);
        await expect(menu.getByRole("menuitem", { name: "Revoke" })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        const remove = menu.getByRole("menuitem", { name: "Delete" });
        await expect(remove).not.toHaveAttribute("aria-disabled", "true");
        await remove.click();
        await expect(toast(page, TOAST.deleted)).toBeVisible();
        await expect(row).toHaveCount(0);
        // Re-read from the list: there is no GET on the item path, and the SPA
        // catch-all answers that GET with 404 for a LIVE connection too (#1966).
        expect(await readConnection(request, headers, connection.name)).toBeUndefined();
      });
    },
  );
});
