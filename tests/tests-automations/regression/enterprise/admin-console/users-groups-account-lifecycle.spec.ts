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
 * `console-tab-contract` proved all seven `/admin-ee` screens resolve and fetch
 * their own data. It says nothing about what any of them lets an operator DO.
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
 * Reasoning, the measured surface and the two locator traps:
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

/**
 * One row, located by the account it is about.
 *
 * There are no per-row testids on this screen. Every control is named
 * `"<Control> — <username>"`, which is the entire locator story here.
 */
function accountRow(page: Page, username: string) {
  return page.getByRole("row", { name: new RegExp(username) });
}

function rowControl(page: Page, username: string, control: string) {
  return accountRow(page, username).getByRole("button", {
    name: `${control} — ${username}`,
  });
}

async function openUsersScreen(page: Page): Promise<void> {
  await page.goto("/admin-ee/users-groups");
  // Wait for a ROW, not the request: an empty table satisfies half the
  // assertions below while proving nothing.
  await expect(accountRow(page, EE_USERNAME)).toBeVisible({ timeout: 30_000 });
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
      await openUsersScreen(page);

      await test.step("all three controls on that row are disabled, each saying why", async () => {
        for (const control of ["Active", "Superuser", "Delete"]) {
          await expect(
            rowControl(page, EE_USERNAME, control),
            `${control} is operable on the break-glass account`,
          ).toBeDisabled();
        }
        // The reasons are not decoration: they are what tells an operator the
        // control is off by policy rather than by a bug.
        await expect(
          rowControl(page, EE_USERNAME, "Active"),
        ).toHaveAccessibleDescription(/cannot deactivate your own account/i);
        await expect(
          rowControl(page, EE_USERNAME, "Delete"),
        ).toHaveAccessibleDescription(/break-glass account cannot be/i);
      });

      // The half a screenshot cannot show. A disabled control over a permissive
      // API is a screen that only looks protective, and nothing else here — or
      // anywhere in the suite — would notice.
      const users = await request.get("/api/v1/users/?limit=100", {
        headers: { Authorization: auth },
      });
      const { users: accounts } = (await users.json()) as {
        users: { id: string; username: string }[];
      };
      const breakGlass = accounts.find((user) => user.username === EE_USERNAME);
      expect(breakGlass, `the instance has no ${EE_USERNAME} account`).toBeDefined();
      const target = `/api/v1/users/${breakGlass!.id}`;

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

      await test.step("demoting and deleting it are refused as BREAK-GLASS (409)", async () => {
        const demote = await request.patch(target, {
          headers: { Authorization: auth },
          data: { is_superuser: false },
        });
        expect(demote.status()).toBe(409);
        expect(await demote.text()).toMatch(/break-glass account cannot be/i);

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
        await expect(accountRow(page, subject.username)).toBeVisible();

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

        await rowControl(page, subject.username, "Delete").click();
        const dialog = page.getByRole("dialog");

        await test.step("the dialog states the action cannot be undone", async () => {
          await expect(dialog).toContainText(/this action cannot be undone/i);
        });

        await test.step("cancelling closes it", async () => {
          // Two controls read `Cancel` in this dialog — the visible one and a
          // second from the shared modal shell. `.first()` is deliberate;
          // `getByText("Cancel")` is a strict-mode violation waiting to happen.
          await dialog.getByRole("button", { name: "Cancel" }).first().click();
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
        await expect(accountRow(page, subject.username)).toBeVisible();

        await rowControl(page, subject.username, "Delete").click();
        const dialog = page.getByRole("dialog");
        // By role and name. The confirm control carries
        // `data-testid="replace-button"` — a shared modal component, so that
        // testid says nothing about deletion and would follow the component into
        // whatever dialog it is reused by next.
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();

        await test.step("the row goes", async () => {
          await expect(accountRow(page, subject.username)).toHaveCount(0);
        });

        await test.step("and so does the account", async () => {
          // The row disappearing is a render; the listing is the state.
          await expect
            .poll(() => isListed(request, auth, subject.username), { timeout: 15_000 })
            .toBe(false);
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
        await expect(accountRow(page, subject.username)).toBeVisible();

        await test.step("it starts active and unprivileged", async () => {
          expect(await readAccount(request, auth, subject.username)).toMatchObject({
            is_active: true,
            is_superuser: false,
          });
        });

        await test.step("deactivating it is confirmed, and lands at the API", async () => {
          await rowControl(page, subject.username, "Active").click();
          const dialog = page.getByRole("dialog");
          // The edit dialog names its subject. The delete one does not — see the
          // note in the spec doc; that asymmetry is recorded in #1633 rather
          // than asserted, so this only pins the copy that exists.
          await expect(dialog).toContainText(subject.username);
          await dialog.getByRole("button", { name: "Confirm", exact: true }).click();

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
          await rowControl(page, subject.username, "Superuser").click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: "Confirm", exact: true }).click();

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
