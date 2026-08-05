import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

/**
 * Global Variables CRUD via the dedicated Settings page
 * (`/settings/global-variables`).
 *
 * dev49 note — why the Settings page, not a component's Globe picker: the old
 * flow created variables through an OpenAI node's `input_value` global-variable
 * picker. On dev49 that picker AUTO-APPLIES the created variable to
 * `input_value`, which (a) renders the name in two places (the field anchor and
 * a `disabled-option-<name>`), breaking exact-text asserts, and (b) makes a
 * Credential variable 400 —
 * "Cannot use a Credential-typed global variable in 'input_value'" — so the
 * Credential secrecy test could not run at all. The Settings page is the
 * canonical CRUD surface: a single-render data table, no node binding, no 400,
 * and stable testids (`api-key-button-store`, `save-variable-btn`,
 * `delete-row-button`).
 *
 * Teardown is by API id (captured from the create POST), never a UI trash
 * click: a UI teardown that fails under load leaks the variable, and a leaked
 * Credential variable poisons later tests — the real driver of the recurring
 * #810 flake.
 *
 * dev16 note (#1303) — the table is ag-grid with ROW VIRTUALIZATION and a new
 * variable is appended at the END of the list, so past the rendered window
 * (measured: 18 rows on the 1280x720 viewport CI uses) the row is in the grid's
 * data model but not in the DOM. `getByRole("treegrid").getByText(name)` then
 * reports `element(s) not found` — the same message it reports when the grid
 * has no rows at all, which is why the recurring flake read as "the variable
 * was never created". Two mechanisms are therefore separated here:
 *
 *   - `createVariable` asserts the POST returned 201 with an id, and waits for
 *     the `GET /api/v1/variables/` that CARRIES the new name. A create that
 *     failed, or a list the frontend never received, now fails as itself.
 *   - `revealVariableRow` scrolls the grid to the appended row before asserting
 *     it, so neither a pass nor a failure depends on how many variables the
 *     account happens to hold.
 *
 * Still open on #1303: on the 2026-08-05 daily the grid held ZERO rows for the
 * full timeout after a 201 create, with the backend measurably healthy — a
 * different state from virtualization that did not reproduce locally. The list
 * wait above exists so its next occurrence names itself instead of being read
 * as this one.
 */

const createdVariableIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdVariableIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdVariableIds.splice(0)) {
    await request
      .delete(`/api/v1/variables/${id}`, { headers: { Authorization: bearer } })
      .catch(() => {});
  }
});

// Open the Settings → Global Variables page. Wait for the always-present
// "Add New" button — the data table (`treegrid`) does NOT render on an empty
// variable list, so it is not a reliable readiness gate.
async function openGlobalVariablesSettings(page: Page): Promise<void> {
  await page.goto("/settings/global-variables");
  await expect(page.getByTestId("api-key-button-store")).toBeVisible({
    timeout: 30000,
  });
}

interface NewVariable {
  name: string;
  type: "generic" | "credential";
  value: string;
}

/**
 * Wait for the list request the grid renders from — `GET /api/v1/variables/`
 * with no query string (the category-scoped variant is a different list) —
 * whose payload does or does not carry `name`.
 *
 * This is the frontend-side proof that the data reached the page, which is what
 * separates "the row did not render" from "the row was never in the list".
 */
function waitForVariablesList(
  page: Page,
  name: string,
  shouldContain: boolean,
): Promise<Error | null> {
  // Settled, never rejecting: an assertion between arming this waiter and
  // awaiting it can fail first, and a rejected waiter left dangling is then
  // reported as a second "page.waitForResponse: Test ended" error on top of the
  // real one. The caller decides what a timeout means.
  return page
    .waitForResponse(
      async (response) => {
        if (response.request().method() !== "GET") return false;
        const url = new URL(response.url());
        if (!url.pathname.endsWith("/api/v1/variables/")) return false;
        if (url.search) return false;
        if (!response.ok()) return false;
        const body = await response.json().catch(() => null);
        if (!Array.isArray(body)) return false;
        const present = body.some(
          (variable: { name?: string }) => variable?.name === name,
        );
        return present === shouldContain;
      },
      { timeout: 30000 },
    )
    .then(() => null)
    .catch((error: Error) => error);
}

// Create a variable through the "Add New" dialog. Both round-trips are armed
// BEFORE the save click so neither can be missed: the create POST, and the list
// refetch that carries the new name.
async function createVariable(page: Page, v: NewVariable): Promise<void> {
  await page.getByTestId("api-key-button-store").click(); // "Add New"
  // Select the type tab BEFORE filling, so the value lands on the right field.
  await page.getByTestId(`${v.type}-tab`).click();
  await page.getByPlaceholder("Enter a name for the variable...").fill(v.name);
  await page
    .getByPlaceholder("Enter a value for the variable...")
    .fill(v.value);

  const saved = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/variables/") &&
      resp.request().method() === "POST",
    { timeout: 30000 },
  );
  const listed = waitForVariablesList(page, v.name, true);
  await page.getByTestId("save-variable-btn").click();

  const resp = await saved;
  const body = (await resp.json().catch(() => null)) as { id?: string } | null;
  expect(
    resp.status(),
    `create of "${v.name}" must return 201 (got ${resp.status()})`,
  ).toBe(201);
  expect(body?.id, `create of "${v.name}" returned no id`).toBeTruthy();
  if (body?.id) createdVariableIds.push(body.id);

  // A create that succeeded but never reached the list is a distinct verdict
  // from a row that failed to render — fail it as itself.
  await assertListRefetched(
    listed,
    `the variables list was never refetched with "${v.name}" after a 201 create`,
  );
}

// Resolve a `waitForVariablesList` waiter, turning a timeout into a verdict of
// its own. Lives outside the test bodies so the branch is not a conditional in
// a test (`playwright/no-conditional-in-test`). The underlying error is kept
// on the message: "the list never arrived" is the verdict, but a closed page or
// a navigation reaches this the same way a plain timeout does, and only the
// original says which.
async function assertListRefetched(
  listed: Promise<Error | null>,
  message: string,
): Promise<void> {
  const failure = await listed;
  if (failure) throw new Error(`${message} — ${failure.message}`);
}

// The data table row for a given variable name.
function variableRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

// The variable name as rendered in the data table (single render on the
// Settings page — no node-binding duplicate).
function variableInTable(page: Page, name: string) {
  return page.getByRole("treegrid").getByText(name, { exact: true });
}

/**
 * Bring a newly created variable's row into the rendered window and return its
 * cell locator. ag-grid only keeps the visible rows plus a buffer in the DOM,
 * and a new variable is appended last, so the row has to be scrolled to before
 * it can be asserted — see the dev16 note above (#1303).
 *
 * The poll settles on VISIBILITY, not on presence in the DOM, so the caller's
 * own `toBeVisible` resolves immediately instead of opening a second 15 s
 * window on a row that is attached but not shown.
 */
async function revealVariableRow(page: Page, name: string) {
  const cell = variableInTable(page, name);
  await expect
    .poll(
      async () => {
        await page
          .locator(".ag-body-viewport")
          .evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          })
          .catch(() => {
            /* the grid is not rendered yet — reported by the poll below */
          });
        return cell.isVisible();
      },
      {
        timeout: 15000,
        message: `"${name}" never rendered in the variables table (the list request carried it, so the grid did not render it)`,
      },
    )
    .toBe(true);
  return cell;
}

test(
  "create a Generic type global variable",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `test-generic-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "generic",
      value: "generic-value-123",
    });

    // The variable must appear in the data table after creation.
    await expect(await revealVariableRow(page, varName)).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "delete a global variable removes it from the list",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `delete-me-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "generic",
      value: "to-be-deleted",
    });
    await expect(await revealVariableRow(page, varName)).toBeVisible({
      timeout: 15000,
    });

    // Delete is a bulk action: select the row, then click "Delete selected
    // items" (which is disabled until a row is selected).
    await variableRow(page, varName).locator(".ag-selection-checkbox").click();
    const deleteButton = page.getByTestId("delete-row-button");
    await expect(deleteButton).toBeEnabled({ timeout: 5000 });

    // Armed before the click: the list the grid re-renders from, without the
    // variable. On a virtualized grid a count of 0 is also what an off-screen
    // row yields, so this is what makes the assertion below mean "deleted".
    const listedWithout = waitForVariablesList(page, varName, false);
    await deleteButton.click();
    await assertListRefetched(
      listedWithout,
      `the variables list was never refetched without "${varName}" after the delete`,
    );

    // The variable must no longer be in the table.
    await expect(variableInTable(page, varName)).toHaveCount(0, {
      timeout: 15000,
    });
  },
);

test(
  "Credential variable value is hidden from the variable list",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await openGlobalVariablesSettings(page);

    const varName = `credential-${Date.now()}`;
    // Distinctive sentinel — if this string surfaces anywhere as visible text
    // after save, the Credential value leaked into the DOM.
    const sentinelValue = `SECRET-SENTINEL-${Date.now()}`;
    await createVariable(page, {
      name: varName,
      type: "credential",
      value: sentinelValue,
    });

    // Sanity, and load-bearing: the leak assertion below passes trivially on a
    // page that renders no variable at all, so it must not run until the row is
    // provably on screen.
    await expect(await revealVariableRow(page, varName)).toBeVisible({
      timeout: 15000,
    });

    // Critical: the Credential value must NOT appear as visible text anywhere
    // on the page — not standalone, and not embedded inside a toast, label, or
    // preview. `getByText` without `exact` does substring matching, so a leak
    // like `"Saved: SECRET-SENTINEL-..."` also fails. The table renders the
    // Credential value masked as `*****`; input `value` attributes don't count
    // as visible text — only rendered text does, which is the guarantee here.
    await expect(page.getByText(sentinelValue)).toHaveCount(0, {
      timeout: 5000,
    });
  },
);
