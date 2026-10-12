import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  EE_USERNAME,
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { requireRbacInstance } from "../../../../helpers/enterprise/rbac";

/**
 * What the Users & Groups screen does, as opposed to whether it loads.
 *
 * `console-tab-contract` proved every `/admin` screen resolves and fetches its
 * own data. It says nothing about what any of them lets an operator DO.
 * This is the first per-tab follow-up, and this tab is first because of what its
 * controls are: an account is deactivated, promoted to superuser and DELETED
 * from here, and the deletion is irreversible.
 *
 * Each test is shaped around a way the screen can satisfy the obvious assertion
 * while being wrong:
 *
 *  - a disabled control over an API that accepts the write is a screen that only
 *    LOOKS protective, and the disabled state is what stops anyone finding out
 *    by hand;
 *  - a dialog that deletes on either button passes every test that only walks
 *    the happy path, so Cancel is asserted as its own test;
 *  - a toggle that flips its own pixels and sends nothing is invisible to any
 *    assertion made on the toggle, so both are read back from the API.
 *
 * The 1.13 table (EE PR 493, LE-2923) moved every control: a row's `Manage`
 * expands a sibling panel holding `Edit User — <u>` and `Delete user — <u>`, and
 * Active / Superuser are switches inside the Edit user dialog, saved together
 * (#2259).
 *
 * Reasoning, the measured surface and the locator traps:
 * `docs/enterprise/admin-console/users-groups-account-lifecycle.md`.
 */

/** Long enough for the EE minimum; these accounts never sign in. */
const SUBJECT_PASSWORD = "AccountLifecycle123!";

interface Subject {
  id: string;
  username: string;
}

/**
 * Create an account through the API, WITHOUT signing it in.
 *
 * Deliberately not `createRbacUser`, which also logs the account in and so costs
 * one unit of a budget that is 5 per minute for the whole machine. Nothing here
 * needs the subject's own token — these tests act on it as an administrator — so
 * this spec spends none of that budget beyond the shared cached admin login.
 */
async function createSubject(
  request: APIRequestContext,
  auth: string,
  prefix: string,
): Promise<Subject> {
  const username = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const created = await request.post("/api/v1/users/", {
    headers: { Authorization: auth },
    data: { username, password: SUBJECT_PASSWORD },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return { id, username };
}

/** Best-effort teardown; never throws over a failure the test already reported. */
async function removeSubject(
  request: APIRequestContext,
  auth: string,
  subject: Subject,
): Promise<void> {
  await request
    .delete(`/api/v1/users/${subject.id}`, { headers: { Authorization: auth } })
    .catch(() => undefined);
}

/** Whether the account is still listed, which is the state — a row is a render. */
async function isListed(
  request: APIRequestContext,
  auth: string,
  username: string,
): Promise<boolean> {
  const response = await request.get("/api/v1/users/?limit=100", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const { users } = (await response.json()) as { users: { username: string }[] };
  return users.some((user) => user.username === username);
}

async function readAccount(
  request: APIRequestContext,
  auth: string,
  username: string,
): Promise<{ is_active: boolean; is_superuser: boolean } | undefined> {
  const response = await request.get("/api/v1/users/?limit=100", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const { users } = (await response.json()) as {
    users: { username: string; is_active: boolean; is_superuser: boolean }[];
  };
  return users.find((user) => user.username === username);
}

/** The account's id, which keys its row and its details panel. */
async function accountId(
  request: APIRequestContext,
  auth: string,
  username: string,
): Promise<string> {
  const response = await request.get("/api/v1/users/?limit=100", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const { users } = (await response.json()) as { users: { id: string; username: string }[] };
  const found = users.find((user) => user.username === username);
  expect(found, `the instance has no ${username} account`).toBeDefined();
  return found!.id;
}

/** One row, by its stable testid. */
function accountRow(page: Page, id: string) {
  return page.getByTestId(`user-row-${id}`);
}

async function openUsersScreen(page: Page): Promise<void> {
  await page.goto("/admin/users-groups");
  await expect(page.getByTestId("users-table")).toBeVisible({ timeout: 30_000 });
}

/**
 * Narrow the table to one account and wait for its row.
 *
 * The table pages at 12 and orders by username, so on a dirty instance a fresh
 * account can sit on page 2; the search is what makes the row reachable at all.
 */
async function findAccount(page: Page, username: string, id: string) {
  await page.getByRole("textbox", { name: "Search Username" }).fill(username);
  const row = accountRow(page, id);
  // Wait for a ROW, not the request: an empty table satisfies half the
  // assertions below while proving nothing.
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

/**
 * Expand an account's details and return them.
 *
 * The panel is a SIBLING `<tr>` (`td#user-panel-<id>`), not part of the row, so
 * a control in it can never be found by scoping to the row.
 */
async function openAccountDetails(page: Page, username: string, id: string) {
  const row = await findAccount(page, username, id);
  await row.getByRole("button", { name: "Manage", exact: true }).click();
  const details = page.locator(`#user-panel-${id}`);
  await expect(details).toBeVisible();
  return details;
}

/**
 * The Edit user dialog. Its accessible name is "Dialog" — a hidden heading comes
 * before the visible "Edit user" — so it is found by its visible heading.
 */
function editDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit user" }) });
}

test.describe("Enterprise — the Users & Groups screen changes accounts, not just controls", () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, auth);
    await seedEnterpriseUiSession(page, request);
  });

  test(
    "the break-glass account is protected on the screen and refused by two distinct guards",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const selfId = await accountId(request, auth, EE_USERNAME);
      await openUsersScreen(page);
      const details = await openAccountDetails(page, EE_USERNAME, selfId);

      // The signed-in account IS the break-glass account on this lane, and since
      // 1.13 the self reason wins over the break-glass one on screen (EE PR 493).
      // The break-glass guard is still what the API answers — asserted below.
      await test.step("deleting it is disabled, saying why", async () => {
        const remove = details.getByRole("button", { name: `Delete user — ${EE_USERNAME}` });
        await expect(remove, "Delete is operable on the signed-in account").toBeDisabled();
        // The reasons are not decoration: they are what tells an operator the
        // control is off by policy rather than by a bug.
        await expect(remove).toHaveAccessibleDescription(/cannot delete your own account/i);
      });

      await test.step("and in the Edit user dialog both switches are disabled, each saying why", async () => {
        await details.getByRole("button", { name: `Edit User — ${EE_USERNAME}` }).click();
        const dialog = editDialog(page);
        await expect(dialog).toBeVisible();
        const active = dialog.getByRole("switch", { name: "Active" });
        const superuser = dialog.getByRole("switch", { name: "Superuser" });
        await expect(active, "Active is operable on the signed-in account").toBeDisabled();
        await expect(superuser, "Superuser is operable on the signed-in account").toBeDisabled();
        await expect(active).toHaveAccessibleDescription(/cannot deactivate your own account/i);
        await expect(superuser).toHaveAccessibleDescription(
          /cannot remove superuser access from your own account/i,
        );
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });

      // The half a screenshot cannot show. A disabled control over a permissive
      // API is a screen that only looks protective, and nothing else here — or
      // anywhere in the suite — would notice.
      const target = `/api/v1/users/${selfId}`;

      await test.step("deactivating it is refused as SELF-protection (403)", async () => {
        const response = await request.patch(target, {
          headers: { Authorization: auth },
          data: { is_active: false },
        });
        // Asserted as a distinct guard, not merely "refused": a build that
        // collapsed the two into one would still refuse and would still pass a
        // laxer test, while the screen goes on showing two different reasons.
        expect(response.status()).toBe(403);
        expect(await response.text()).toMatch(/deactivate your own user account/i);
      });

      await test.step("demoting it is refused as SELF-protection too (409)", async () => {
        // On 1.12 this was the break-glass guard's refusal; since 1.13 the
        // self-protection check answers first, with its own wording.
        const demote = await request.patch(target, {
          headers: { Authorization: auth },
          data: { is_superuser: false },
        });
        expect(demote.status()).toBe(409);
        expect(await demote.text()).toMatch(/remove superuser access from your own account/i);
      });

      await test.step("deleting it is refused as BREAK-GLASS (409)", async () => {
        const remove = await request.delete(target, { headers: { Authorization: auth } });
        expect(remove.status()).toBe(409);
        expect(await remove.text()).toMatch(/break-glass account cannot be deleted/i);
      });

      await test.step("and the account survived all three attempts", async () => {
        const account = await readAccount(request, auth, EE_USERNAME);
        expect(account).toMatchObject({ is_active: true, is_superuser: true });
      });
    },
  );

  test(
    "cancelling the delete dialog leaves the account intact",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const subject = await createSubject(request, auth, "lifecycle-cancel");

      try {
        await openUsersScreen(page);
        const details = await openAccountDetails(page, subject.username, subject.id);

        // Armed before the dialog opens. Reading the listing afterwards is NOT
        // enough on its own and the force-fail proved it: swapping this test's
        // Cancel for the Delete control left it GREEN, because the listing was
        // read while the deletion was still in flight. "Nothing was sent" is the
        // claim, so it is asserted directly rather than inferred from a state
        // read that races the request it is trying to detect.
        const writes: string[] = [];
        page.on("request", (issued) => {
          const { pathname } = new URL(issued.url());
          if (pathname === `/api/v1/users/${subject.id}` && issued.method() !== "GET") {
            writes.push(`${issued.method()} ${pathname}`);
          }
        });

        await details.getByRole("button", { name: `Delete user — ${subject.username}` }).click();
        const dialog = page.getByRole("dialog", { name: "Delete User" });

        await test.step("the dialog states the action cannot be undone", async () => {
          await expect(dialog).toContainText(/this action cannot be undone/i);
        });

        await test.step("cancelling closes it", async () => {
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(dialog).toBeHidden();
        });

        await test.step("having sent no write for that account", async () => {
          // The assertion that makes the dialog a gate rather than decoration.
          expect(writes, "cancelling the dialog issued a write").toEqual([]);
        });

        await test.step("and the account is still there at the API", async () => {
          // Kept alongside the network assertion, not instead of it: this one
          // states the outcome an operator cares about, the one above is what
          // makes it non-racy.
          expect(await isListed(request, auth, subject.username)).toBe(true);
        });
      } finally {
        await removeSubject(request, auth, subject);
      }
    },
  );

  test(
    "confirming the delete dialog removes the account at the API",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const subject = await createSubject(request, auth, "lifecycle-delete");

      try {
        await openUsersScreen(page);
        const details = await openAccountDetails(page, subject.username, subject.id);

        await details.getByRole("button", { name: `Delete user — ${subject.username}` }).click();
        const dialog = page.getByRole("dialog", { name: "Delete User" });
        // By role and EXACT name, scoped to the dialog.
        const removed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/v1/users/${subject.id}` &&
            response.request().method() === "DELETE",
        );
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();

        await test.step("the delete is accepted for background erasure", async () => {
          // Since langflow-ai/langflow#15470 deletion is an asynchronous erase:
          // 202, not 200, and the account can still be listed for a moment.
          expect((await removed).status()).toBe(202);
          await expect(dialog).toBeHidden();
        });

        await test.step("the account goes at the API", async () => {
          // The state, polled: the erase runs in the background.
          await expect
            .poll(() => isListed(request, auth, subject.username), { timeout: 30_000 })
            .toBe(false);
        });

        await test.step("and so does its row, once the screen re-reads", async () => {
          // The screen refetches once, immediately — possibly before the erase
          // finished — so the row is read after a fresh load, not raced.
          await openUsersScreen(page);
          await page.getByRole("textbox", { name: "Search Username" }).fill(subject.username);
          await expect(accountRow(page, subject.id)).toHaveCount(0);
        });
      } finally {
        await removeSubject(request, auth, subject);
      }
    },
  );

  test(
    "the toggles change the account, not just the control",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const subject = await createSubject(request, auth, "lifecycle-toggle");

      try {
        await openUsersScreen(page);
        const details = await openAccountDetails(page, subject.username, subject.id);

        await test.step("it starts active and unprivileged", async () => {
          expect(await readAccount(request, auth, subject.username)).toMatchObject({
            is_active: true,
            is_superuser: false,
          });
        });

        await test.step("deactivating it is saved, and lands at the API", async () => {
          await details.getByRole("button", { name: `Edit User — ${subject.username}` }).click();
          const dialog = editDialog(page);
          // The edit dialog names its subject. The delete one does not — see the
          // note in the spec doc; that asymmetry is recorded in #1633 rather
          // than asserted, so this only pins the copy that exists.
          await expect(dialog).toContainText(subject.username);
          await dialog.getByRole("switch", { name: "Active" }).click();
          await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
          await expect(dialog).toBeHidden();

          // Read back from the API, never from the control that was clicked: a
          // toggle that flips itself and sends nothing satisfies any assertion
          // made on the toggle.
          await expect
            .poll(() => readAccount(request, auth, subject.username).then((a) => a?.is_active), {
              timeout: 15_000,
            })
            .toBe(false);
        });

        await test.step("promoting it to superuser lands at the API too", async () => {
          await details.getByRole("button", { name: `Edit User — ${subject.username}` }).click();
          const dialog = editDialog(page);
          await dialog.getByRole("switch", { name: "Superuser" }).click();
          await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
          await expect(dialog).toBeHidden();

          await expect
            .poll(
              () => readAccount(request, auth, subject.username).then((a) => a?.is_superuser),
              { timeout: 15_000 },
            )
            .toBe(true);
        });
      } finally {
        await removeSubject(request, auth, subject);
      }
    },
  );
});
