import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import {
  assignRole,
  builtinRoleIds,
  createCustomRole,
  deleteRole,
  deleteRoleRaw,
  getSharedRbacSubject,
  patchRole,
  readAllRoleAssignments,
  requireAuthzAdminUi,
  retryOnDroppedConnection,
  revokeAssignmentsFor,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The operator screen for authorization.
 *
 * `enterprise/authz/` holds eight API specs and none of them opens a browser.
 * This is the screen an operator actually uses to grant and revoke access, and
 * the four tests here are the properties that decide whether what the operator
 * sees is what the instance enforces.
 *
 * It is NOT where the route name suggests: `/admin-ee/access-control` redirects
 * to `/admin-ee/users-groups`, and the `/admin-ee` tab list has no Access
 * Control tab at all. The routes are mounted under Settings.
 */
const ROLES_TAB = "/settings/access-control";
const ASSIGNMENTS_TAB = "/settings/access-control/assignments";

/**
 * The two tables' columns, in order.
 *
 * Cells below are addressed by index, which is only honest if the order is
 * checked — so each test that reads a cell asserts the header first. A screen
 * that reordered its columns would otherwise let every cell assertion read the
 * neighbouring value and still pass.
 */
const ROLE_COLUMNS = ["Name", "Type", "Permissions", "Inherits from", "Description", "Actions"];
const ASSIGNMENT_COLUMNS = ["User", "Role", "Scope", "Sources", "Actions"];

/** Column indices, named so the assertions read as what they mean. */
const ROLE_TYPE = ROLE_COLUMNS.indexOf("Type");
const ASSIGNMENT_USER = ASSIGNMENT_COLUMNS.indexOf("User");
const ASSIGNMENT_ROLE = ASSIGNMENT_COLUMNS.indexOf("Role");
const ASSIGNMENT_SCOPE = ASSIGNMENT_COLUMNS.indexOf("Scope");
const ASSIGNMENT_SOURCES = ASSIGNMENT_COLUMNS.indexOf("Sources");

/**
 * The role picker labels system roles by DISPLAY name, not by the API's name:
 * `developer` renders as **Editor**. `viewer` is the role these tests grant, and
 * it appears as `Viewer (System)`.
 */
const VIEWER_OPTION = /^Viewer \(System\)$/;
const VIEWER_CELL = "Viewer";

/**
 * Open a tab and wait for its table to be populated.
 *
 * Waits on a ROW, never on the request: a screen that has not finished loading
 * satisfies every "this control is absent" assertion in this file while proving
 * nothing — the failure mode the sibling governance UI spec was written around.
 */
async function openTab(page: Page, url: string, ready: Locator, what: string): Promise<void> {
  await page.goto(url);
  await expect(
    ready,
    `${what} never rendered — the assertions below would pass against an empty screen`,
  ).toBeVisible({ timeout: 30_000 });
}

/** The assignments row for one user. Unique: the subject's username carries a timestamp. */
function assignmentRow(page: Page, username: string): Locator {
  return page.getByRole("row").filter({ hasText: username });
}

/**
 * Click a trigger and get its dialog open, repairing a DROPPED click.
 *
 * Measured on this screen: `Assign role` is visible and clickable, the click
 * lands, and the dialog never mounts — `getByRole("dialog")` is still "element(s)
 * not found" five seconds later, which is far too long for a React dialog whose
 * click was actually delivered. It reproduces roughly one run in four and hits
 * both triggers here, `Assign role` and the row's `Revoke`.
 *
 * This repairs the click, it does not paper over an assertion: what each test
 * asserts is what the dialog then does to the instance, and none of that is
 * relaxed. The same platform behaviour is already handled this way for the
 * canvas sidebar, where a node add drops its click across four surfaces.
 *
 * Guarded so it can never open a second dialog: an already-open dialog is
 * detected before clicking, because clicking through its overlay would time out
 * and turn a repaired attempt into a failed one.
 */
async function openDialog(trigger: Locator, dialog: Locator): Promise<void> {
  await expect(async () => {
    if (!(await dialog.isVisible())) await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000, intervals: [0, 500, 1_000, 2_000] });
}

test.describe("Enterprise — the Access Control operator screen", () => {
  let superuserAuth: string;
  let roleIds: Record<string, string>;
  let subject: RbacUser;

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireAuthzAdminUi(request, superuserAuth);
    roleIds = await builtinRoleIds(request, superuserAuth);
    // One shared subject for the whole file, cached across runs: EE allows five
    // logins per minute for the whole machine, and a user per test would spend
    // that budget on setup.
    subject = await getSharedRbacSubject(request, superuserAuth);
  });

  // Independence, in both directions. Before, because a test that died mid-way
  // would otherwise hand the next one a grant it did not make; after, because the
  // assignment test 3 creates is made BY THE SCREEN, so the id is one this spec
  // only learns if it gets far enough to read it back.
  test.beforeEach(async ({ request }) => {
    await revokeAssignmentsFor(request, superuserAuth, subject.id);
  });

  test.afterEach(async ({ request }) => {
    await revokeAssignmentsFor(request, superuserAuth, subject.id);
  });

  test(
    "a system role offers no way to change it, on the screen and at the API",
    { tag: ["@enterprise", "@regression", "@authz"] },
    async ({ page, request }) => {
      // A row of each kind, so the absence of the system row's controls is read
      // against a row that has them rather than against an empty action column.
      const custom = await createCustomRole(
        request,
        superuserAuth,
        `ac-ui-role-${Date.now()}`,
      );

      try {
        await seedEnterpriseUiSession(page, request);
        const systemRow = page.getByTestId("role-row-viewer");
        await openTab(page, ROLES_TAB, systemRow, "the roles table");

        await test.step("the columns are in the order these assertions read", async () => {
          await expect(page.getByRole("columnheader")).toHaveText(ROLE_COLUMNS);
        });

        await test.step("the system role is typed System and offers only View", async () => {
          await expect(systemRow.getByRole("cell").nth(ROLE_TYPE)).toHaveText("System");
          await expect(systemRow.getByRole("button", { name: "View" })).toBeVisible();
          // The load-bearing pair. The badge is a label; these absences are what
          // stop the edit.
          await expect(systemRow.getByRole("button", { name: "Edit" })).toHaveCount(0);
          await expect(systemRow.getByRole("button", { name: "Delete" })).toHaveCount(0);
        });

        await test.step("the custom role is typed Custom and offers all three", async () => {
          // The positive half. Without it, a screen that rendered no action
          // buttons at all would satisfy both absences above.
          const customRow = page.getByTestId(`role-row-${custom.name}`);
          await expect(customRow.getByRole("cell").nth(ROLE_TYPE)).toHaveText("Custom");
          for (const name of ["View", "Edit", "Delete"]) {
            await expect(customRow.getByRole("button", { name })).toBeVisible();
          }
        });

        await test.step("and the API refuses both writes to the system role", async () => {
          // A screen that hid the controls over an API that accepted the write
          // would be a read-only screen that is not read-only.
          // Wrapped: this is the first API call after several seconds of driving
          // the screen, and a connection dropped there is not evidence about the
          // refusal being asserted.
          const patched = await retryOnDroppedConnection(() =>
            patchRole(request, superuserAuth, roleIds.viewer, {
              description: "tampered by the E2E suite",
            }),
          );
          expect(patched.status(), await patched.text()).toBe(400);
          expect(await patched.text()).toContain("System roles cannot be modified");

          const deleted = await retryOnDroppedConnection(() =>
            deleteRoleRaw(request, superuserAuth, roleIds.viewer),
          );
          expect(deleted.status(), await deleted.text()).toBe(400);
          expect(await deleted.text()).toContain("System roles cannot be deleted");
        });

        await test.step("and the role is unchanged after the refusals", async () => {
          // A 400 that still applied the change would be the worst of both.
          const reread = await retryOnDroppedConnection(() =>
            request.get(`/api/v1/authz/roles/${roleIds.viewer}`, {
              headers: { Authorization: superuserAuth },
            }),
          );
          expect(reread.status()).toBe(200);
          const role = (await reread.json()) as { description: string; is_system: boolean };
          expect(role.description).not.toContain("tampered");
          expect(role.is_system).toBe(true);
        });
      } finally {
        await deleteRole(request, superuserAuth, custom.id);
      }
    },
  );

  test(
    "the Assignments tab lists a grant held by another user",
    { tag: ["@enterprise", "@regression", "@authz"] },
    async ({ page, request }) => {
      // Granted to the SUBJECT, not to the caller. The screen reads
      // /authz/admin/role-assignments; its caller-scoped sibling returns only the
      // caller's own grants, and on a single-admin instance the two responses are
      // identical — so a regression onto the wrong one shows the operator their
      // own row, looks correct, and hides every other user's access.
      await assignRole(request, superuserAuth, subject.id, roleIds.viewer);

      await seedEnterpriseUiSession(page, request);
      const row = assignmentRow(page, subject.username);
      await openTab(page, ASSIGNMENTS_TAB, row, `the assignment row for ${subject.username}`);

      await test.step("the columns are in the order these assertions read", async () => {
        await expect(page.getByRole("columnheader")).toHaveText(ASSIGNMENT_COLUMNS);
      });

      await test.step("the row names the user, the role, the scope and the source", async () => {
        await expect(row.getByRole("cell").nth(ASSIGNMENT_USER)).toHaveText(subject.username);
        await expect(row.getByRole("cell").nth(ASSIGNMENT_ROLE)).toHaveText(VIEWER_CELL);
        await expect(row.getByRole("cell").nth(ASSIGNMENT_SCOPE)).toHaveText("Global");
        await expect(row.getByRole("cell").nth(ASSIGNMENT_SOURCES)).toHaveText("Manual");
      });

      await test.step("and offers to revoke it", async () => {
        await expect(row.getByRole("button", { name: "Revoke" })).toBeVisible();
      });
    },
  );

  test(
    "assigning at project scope through the dialog creates a project-scoped assignment",
    { tag: ["@enterprise", "@regression", "@authz"] },
    async ({ page, request }) => {
      // The test owns its project for two reasons: the stock instance carries two
      // projects both named "Starter Project" (different owners, told apart in the
      // picker only by a " — <owner>" suffix), and comparing the created
      // assignment against an id this test minted turns a text match into an
      // equality.
      const project = await createProjectViaApi(
        request,
        { Authorization: superuserAuth },
        { namePrefix: "ac-ui-scope" },
      );

      try {
        await seedEnterpriseUiSession(page, request);
        const assignButton = page.getByRole("button", { name: "Assign role" });

        // The dialog's three pickers are built from these two reads, so waiting
        // for them is waiting for the real precondition rather than for the
        // button to merely look clickable. Armed before the navigation, or a
        // response that already arrived would never be seen.
        const usersLoaded = page.waitForResponse(
          (response) => response.url().includes("/authz/admin/users") && response.ok(),
        );
        const scopesLoaded = page.waitForResponse(
          (response) =>
            response.url().includes("/authz/admin/assignment-scopes") && response.ok(),
        );
        await openTab(page, ASSIGNMENTS_TAB, assignButton, "the assignments tab");
        await Promise.all([usersLoaded, scopesLoaded]);

        const dialog = page.getByRole("dialog");

        await test.step("open the dialog and pick the user and the role", async () => {
          await openDialog(assignButton, dialog);

          await dialog.getByRole("combobox", { name: "User" }).click();
          await page.getByRole("option", { name: subject.username }).click();

          await dialog.getByRole("combobox", { name: "Role" }).click();
          await page.getByRole("option", { name: VIEWER_OPTION }).click();
        });

        await test.step("switch the scope to Project and pick this test's project", async () => {
          await dialog.getByRole("combobox", { name: "Scope" }).click();
          await page.getByRole("option", { name: "Project", exact: true }).click();

          // Only appears once the scope is not Global — asserting it is visible is
          // asserting the scope switch took effect at all.
          const target = dialog.getByRole("combobox", { name: "Scope target" });
          await expect(target).toBeVisible();
          await target.click();
          await page.getByRole("option", { name: new RegExp(project.name) }).click();
        });

        await test.step("submit, and the dialog closes", async () => {
          await dialog.getByRole("button", { name: "Assign Role" }).click();
          await expect(dialog).toBeHidden();
        });

        await test.step("the API holds one assignment, scoped to that project", async () => {
          // The assertion that matters. Scope is the axis the deny matrix turns
          // on, and a picker that submitted `global` regardless would hand
          // instance-wide access to an operator who asked for one project.
          await expect
            .poll(async () => {
              const all = await readAllRoleAssignments(request, superuserAuth);
              return all.filter((assignment) => assignment.user_id === subject.id);
            })
            .toMatchObject([
              {
                role_id: roleIds.viewer,
                domain_type: "project",
                domain_id: project.projectId,
              },
            ]);
        });

        await test.step("and the row states the scope it was given", async () => {
          const row = assignmentRow(page, subject.username);
          await expect(row.getByRole("cell").nth(ASSIGNMENT_SCOPE)).toHaveText(
            `Project: ${project.name}`,
          );
        });
      } finally {
        await project.deleteProject();
      }
    },
  );

  test(
    "revoking on the screen removes the assignment at the API",
    { tag: ["@enterprise", "@regression", "@authz"] },
    async ({ page, request }) => {
      await assignRole(request, superuserAuth, subject.id, roleIds.viewer);

      await seedEnterpriseUiSession(page, request);
      const row = assignmentRow(page, subject.username);
      await openTab(page, ASSIGNMENTS_TAB, row, `the assignment row for ${subject.username}`);

      const dialog = page.getByRole("dialog");

      await test.step("revoke on that row and confirm", async () => {
        // Scoped to the row, then to the dialog. Both buttons are named exactly
        // "Revoke", so an unscoped locator is strict-mode ambiguous the moment
        // the dialog opens.
        await openDialog(row.getByRole("button", { name: "Revoke" }), dialog);
        await expect(dialog).toContainText(`Revoke ${VIEWER_CELL}?`);
        await expect(dialog).toContainText(
          `${subject.username} will lose the permissions this role grants.`,
        );
        await dialog.getByRole("button", { name: "Revoke" }).click();
        await expect(dialog).toBeHidden();
      });

      await test.step("the subject holds no assignment at the API", async () => {
        // The row disappearing is a render; this is the state.
        await expect
          .poll(async () => {
            const all = await readAllRoleAssignments(request, superuserAuth);
            return all.filter((assignment) => assignment.user_id === subject.id).length;
          })
          .toBe(0);
      });

      await test.step("and the row is gone from the screen", async () => {
        await expect(row).toHaveCount(0);
      });
    },
  );
});
