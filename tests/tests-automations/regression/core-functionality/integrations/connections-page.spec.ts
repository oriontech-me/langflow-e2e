import type { APIRequestContext, APIResponse, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { postLogin } from "../../../../helpers/auth/login-request";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { retryAfterMs } from "../../../../helpers/integrations/delete-connection";
import {
  navigateSettingsPages,
  settingsNavEntry,
} from "../../../../helpers/ui/go-to-settings";

// The /settings/connections page itself: how a user reaches it, what an empty
// view says, what a row shows, which tab holds which connection, how search
// narrows the table, and what the status badge reads per state.
// Spec doc: docs/core-functionality/integrations/connections-page.md
//
// Sibling: connections-row-actions.spec.ts (#1970) owns the row MENU and the
// non-interactive opt-in; nothing here opens the menu.
//
// Every locator is keyed on a name this file generated (connection-row-<name>,
// authorize-<name>, the handle google/<name>): the page lists every connection
// the shared superuser can see, so nothing here may read a row's position or
// the list's length, and "gone" is only ever asserted of this file's own rows.
//
// Write budget: connection writes share a per-user bucket of 30/minute and a
// rendered page cannot be retried, so the file spends 9 superuser writes per run
// (test 1 none; test 2 three seeds and three deletes; test 3 one seed, one
// revoke and one delete). The second user's writes land in that user's bucket.
test.describe("Connections page — navigation, empty view, rows, tabs, search and status", () => {
  const PAGE = "/settings/connections";
  // Exact copy, measured on 1.13.0.dev19 (connections.* in the en bundle).
  const SUBTITLE =
    "Accounts your flows act through. Tokens stay on the server; only metadata is shown here.";
  const EMPTY = "No connections yet.";
  const COLUMNS = ["Connection", "Owner", "Account", "Status", "Scopes", "Last check", "Actions"];
  const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";

  /** A second user, driven through its own request context. */
  interface ThrowawayUser {
    id: string;
    /** Isolated on purpose: the login's cookies must never reach the superuser's `request`. */
    request: APIRequestContext;
    headers: Record<string, string>;
    connections: CreatedConnection[];
  }

  const seeded: CreatedConnection[] = [];
  const throwawayUsers: ThrowawayUser[] = [];

  test.afterEach(async ({ request }) => {
    const mine = seeded.splice(0);
    const users = throwawayUsers.splice(0);
    if (mine.length === 0 && users.length === 0) return;
    const headers = { Authorization: await getAuthToken(request) };

    if (mine.length > 0) {
      // One list read first: a DELETE that answers 404 is still charged to the
      // per-user write bucket.
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
    }

    for (const user of users) {
      // The owner deletes its own rows (its bucket, not the superuser's); then the
      // user goes, which measured to take any row it still owned with it.
      for (const connection of user.connections) {
        await connection.deleteConnection().catch((error) => {
          console.warn(`⚠️ Orphan connection left behind (${connection.name}): ${error}`);
        });
      }
      const res = await request.delete(`/api/v1/users/${user.id}`, { headers });
      if (res.status() !== 200) {
        console.warn(`⚠️ Orphan user left behind (${user.id}): ${res.status()} ${await res.text()}`);
      }
      await user.request.dispose();
    }
  });

  /**
   * Creates, activates and logs in a throwaway user. It is registered for
   * teardown as soon as it exists, so a later failure still deletes it.
   */
  async function createThrowawayUser(
    request: APIRequestContext,
    superHeaders: Record<string, string>,
    newContext: () => Promise<APIRequestContext>,
  ): Promise<ThrowawayUser> {
    const username = `connpage${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const password = "Throwaway!12345";
    const created = await request.post("/api/v1/users/", {
      headers: superHeaders,
      data: { username, password },
    });
    expect(created.status(), await created.text()).toBe(201);
    const user: ThrowawayUser = {
      id: (await created.json()).id,
      request: await newContext(),
      headers: {},
      connections: [],
    };
    throwawayUsers.push(user);
    // A user created through the API arrives inactive and cannot log in yet.
    const activated = await request.patch(`/api/v1/users/${user.id}`, {
      headers: superHeaders,
      data: { is_active: true },
    });
    expect(activated.status(), await activated.text()).toBe(200);
    // The one login of the file: OSS limits /api/v1/login to 5/minute per client IP.
    const login = await postLogin(user.request, username, password);
    expect(login.status(), await login.text()).toBe(200);
    user.headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
    return user;
  }

  /**
   * A POST that is a PRECONDITION here — the badge is the subject, not the
   * route — so one 429 is waited out, the contract the seeding helpers keep.
   */
  async function postPrecondition(
    request: APIRequestContext,
    url: string,
    headers: Record<string, string>,
  ): Promise<APIResponse> {
    const first = await request.post(url, { headers });
    if (first.status() !== 429) return first;
    const wait = retryAfterMs(first.headers());
    console.warn(`⚠️ ${url} hit its rate limit (429) — waiting ${wait} ms for the window to reset`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return request.post(url, { headers });
  }

  /** A row's cell under the column with this header — located by text, not position. */
  async function cell(page: Page, row: Locator, column: string): Promise<Locator> {
    const headers = (await page.getByRole("columnheader").allInnerTexts()).map((text) => text.trim());
    const index = headers.indexOf(column);
    expect(index, `column "${column}" among ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);
    return row.locator("td").nth(index);
  }

  function tab(page: Page, name: string): Locator {
    return page
      .getByRole("tablist", { name: "Connection views" })
      .getByRole("tab", { name, exact: true });
  }

  async function openTab(page: Page, name: string): Promise<void> {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
  }

  test(
    "Settings navigation reaches the Connections page, and an empty view says so while still offering Add",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      await test.step("the account menu, Settings and the Connections entry land on the page", async () => {
        await page.goto("/");
        // Verified hops (#1696); the last one is confirmed by the entry's own
        // href, since this page renders no settings_menu_header.
        await navigateSettingsPages(page, "Settings", "Connections");
        const entry = settingsNavEntry(page, "Connections");
        await expect(entry).toHaveText("Connections");
        await expect(entry).toHaveAttribute("href", PAGE);
        await expect(entry).toHaveAttribute("data-active", "true");
        await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
        await expect(page).toHaveTitle("Connections | Langflow");
      });

      await test.step("the heading, the subtitle's promise and Add connection render verbatim", async () => {
        await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
        // The user-facing half of the secret boundary (#1967): a silent removal
        // of this sentence is a change to what the page promises.
        await expect(page.getByText(SUBTITLE, { exact: true })).toBeVisible();
        await expect(page.getByTestId("add-connection")).toHaveText("Add connection");
      });

      await test.step("three views, with Mine selected", async () => {
        const tablist = page.getByRole("tablist", { name: "Connection views" });
        await expect(tablist.getByRole("tab")).toHaveText(["Mine", "Instance", "Other users"]);
        await expect(tab(page, "Mine")).toHaveAttribute("aria-selected", "true");
      });

      await test.step("a view with nothing to show reads its empty copy, drops the table and still offers Add", async () => {
        // The page has ONE empty state, for any view with nothing to show — tab
        // AND search. A shared superuser is never guaranteed an empty list, and
        // under auto_login the UI cannot move to a fresh user, so the view is
        // emptied by a search no connection can match.
        await page.getByTestId("connections-search").fill(uniqueConnectionName("nomatch"));
        await expect(page.getByTestId("connections-empty")).toHaveText(EMPTY);
        await expect(page.getByRole("table")).toHaveCount(0);
        await expect(page.getByTestId("add-connection")).toBeVisible();
      });
    },
  );

  test(
    "a seeded row shows what the account is, each tab holds only its ownership kind, and search narrows by name, account and handle",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request, playwright }) => {
      const headers = { Authorization: await getAuthToken(request) };
      const accountDisplay = `Scout ${uniqueConnectionName("acct")}`;
      const rowOf = (connection: CreatedConnection) =>
        page.getByTestId(`connection-row-${connection.name}`);

      const { mine, pending, instance, theirs } = await test.step("seed a user row, a pending row, an instance row and another user's row", async () => {
        const mine = await createConnectionViaApi(request, headers, {
          label: "page_row",
          // Two scopes, not one: the counter has a single plural form upstream
          // ("1 scopes"), so a one-scope count would pin that defect.
          grantedScopes: [`${GOOGLE_SCOPE}gmail.send`, `${GOOGLE_SCOPE}drive.file`],
          account: { id: `${uniqueConnectionName("acct")}@example.com`, display: accountDisplay },
        });
        seeded.push(mine);
        const pending = await createConnectionViaApi(request, headers, {
          label: "page_pending",
          credentials: null,
        });
        seeded.push(pending);
        const instance = await createConnectionViaApi(request, headers, {
          label: "page_instance",
          ownershipMode: "instance",
        });
        seeded.push(instance);
        const other = await createThrowawayUser(request, headers, () =>
          playwright.request.newContext({ baseURL: test.info().project.use.baseURL }),
        );
        const theirs = await createConnectionViaApi(other.request, other.headers, {
          label: "page_other",
        });
        other.connections.push(theirs);
        expect(theirs.connection.owner_id, "the second user's row is owned by that user").not.toBe(
          mine.connection.owner_id,
        );
        return { mine, pending, instance, theirs };
      });

      await test.step("the table carries every column, and row A shows its name, handle, owner, account, status, scopes and last check", async () => {
        await page.goto(PAGE);
        await expect(rowOf(mine), `the seeded row ${mine.name} on ${PAGE}`).toBeVisible({
          timeout: 30000,
        });
        const columns = (await page.getByRole("columnheader").allInnerTexts()).map((text) =>
          text.trim(),
        );
        for (const column of COLUMNS) {
          expect(columns, `the "${column}" column`).toContain(column);
        }
        const row = rowOf(mine);
        const connectionCell = await cell(page, row, "Connection");
        await expect(connectionCell.getByText(mine.displayName, { exact: true })).toBeVisible();
        await expect(connectionCell.getByText(`google/${mine.name}`, { exact: true })).toBeVisible();
        await expect(await cell(page, row, "Owner")).toHaveText("You");
        await expect(await cell(page, row, "Account")).toHaveText(accountDisplay);
        await expect(await cell(page, row, "Status")).toHaveText("Ready");
        await expect(row.getByTestId(`authorize-${mine.name}`)).toHaveCount(0);
        const scopesCell = await cell(page, row, "Scopes");
        await expect(scopesCell.getByText("2 scopes", { exact: true })).toBeVisible();
        // The count AND the list: a count alone passes on an empty list. The
        // abbreviated list is sr-only text — the full URLs only appear on hover.
        await expect(scopesCell.getByText("gmail.send, drive.file", { exact: true })).toHaveCount(1);
        await expect((await cell(page, row, "Last check")).getByText("Never", { exact: true })).toBeVisible();
      });

      await test.step("the never-authorized row reads Pending and offers Authorize", async () => {
        const row = rowOf(pending);
        await expect(row).toBeVisible();
        await expect((await cell(page, row, "Status")).getByText("Pending", { exact: true })).toBeVisible();
        await expect(row.getByTestId(`authorize-${pending.name}`)).toHaveText("Authorize");
        await expect(await cell(page, row, "Account")).toHaveText("Not signed in yet");
        await expect(await cell(page, row, "Scopes")).toHaveText("No scopes granted");
      });

      await test.step("Mine holds the superuser's own rows, and neither the instance row nor the other user's", async () => {
        await expect(tab(page, "Mine")).toHaveAttribute("aria-selected", "true");
        await expect(rowOf(mine)).toBeVisible();
        await expect(rowOf(pending)).toBeVisible();
        await expect(rowOf(instance)).toHaveCount(0);
        await expect(rowOf(theirs)).toHaveCount(0);
      });

      await test.step("Instance holds the instance row, owned by the instance, and none of the others", async () => {
        await openTab(page, "Instance");
        // The held row first: once it renders, the tab's filter has run, so the
        // absences below cannot pass on a view that has not switched yet.
        await expect(rowOf(instance)).toBeVisible();
        await expect(await cell(page, rowOf(instance), "Owner")).toHaveText("Instance");
        for (const connection of [mine, pending, theirs]) {
          await expect(rowOf(connection), `${connection.name} outside Instance`).toHaveCount(0);
        }
      });

      await test.step("Other users holds the other user's private row and none of the superuser's (langflow#15182)", async () => {
        await openTab(page, "Other users");
        await expect(rowOf(theirs)).toBeVisible();
        for (const connection of [mine, pending, instance]) {
          await expect(rowOf(connection), `${connection.name} outside Other users`).toHaveCount(0);
        }
      });

      await test.step("search keeps the row its name, handle or account matches and drops the other", async () => {
        await openTab(page, "Mine");
        const search = page.getByTestId("connections-search");
        // Ordered so every probe flips which row is shown: a probe that left the
        // previous result standing would pass on a search that ignored the input.
        await search.fill(mine.name);
        await expect(rowOf(mine)).toBeVisible();
        await expect(rowOf(pending)).toHaveCount(0);
        // The handle: P's display name does not contain "google/".
        await search.fill(`google/${pending.name}`);
        await expect(rowOf(pending)).toBeVisible();
        await expect(rowOf(mine)).toHaveCount(0);
        // The account: neither row's display name nor handle contains it.
        await search.fill(accountDisplay);
        await expect(rowOf(mine)).toBeVisible();
        await expect(rowOf(pending)).toHaveCount(0);
      });
    },
  );

  test(
    "the status badge follows the connection's state: expired and revoked each offer Reconnect",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const headers = { Authorization: await getAuthToken(request) };

      const connection = await test.step("seed a planted credential that expired in 2020, and let /health find it", async () => {
        const created = await createConnectionViaApi(request, headers, {
          label: "page_expiring",
          credentials: {
            access_token: `E2E-PLANTED-${Date.now().toString(36)}`,
            expires_at: "2020-01-01T00:00:00Z",
          },
        });
        seeded.push(created);
        // A planted token has no OAuth binding, so the check compares expires_at
        // with the clock and records `expired` — status is persisted, never
        // derived at read time.
        const res = await postPrecondition(request, `/api/v1/connections/${created.id}/health`, headers);
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as ConnectionRead).status).toBe("expired");
        return created;
      });

      const row = page.getByTestId(`connection-row-${connection.name}`);
      const reconnect = row.getByTestId(`authorize-${connection.name}`);

      await test.step("the row reads Expired and offers Reconnect", async () => {
        await page.goto(PAGE);
        await expect(row, `the seeded row ${connection.name} on ${PAGE}`).toBeVisible({
          timeout: 30000,
        });
        const status = await cell(page, row, "Status");
        await expect(status.getByText("Expired", { exact: true })).toBeVisible();
        await expect(reconnect).toHaveText("Reconnect");
      });

      await test.step("after a revoke the row reads Revoked and still offers Reconnect", async () => {
        const res = await postPrecondition(request, `/api/v1/connections/${connection.id}/revoke`, headers);
        expect(res.status(), await res.text()).toBe(200);
        expect(await res.json()).toMatchObject({ status: "revoked", has_credentials: false });
        await page.reload();
        await expect(row).toBeVisible({ timeout: 30000 });
        const status = await cell(page, row, "Status");
        await expect(status.getByText("Revoked", { exact: true })).toBeVisible();
        await expect(status.getByText("Expired", { exact: true })).toHaveCount(0);
        await expect(reconnect).toHaveText("Reconnect");
      });
    },
  );
});
