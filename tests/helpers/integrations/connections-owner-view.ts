import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { servedVersion, versionAtLeast } from "../other/served-version";

/**
 * How the `/settings/connections` page chooses whose connections it lists (#2409).
 *
 * Until `1.14.0.dev22` the three ownership views were TABS of the tablist
 * *Connection views* (`Mine`, `Instance`, `Other users`). langflow#16254 (merged
 * into `release-1.14.0` on 2026-11-08, first in `1.14.0.dev23`) turned them into
 * the options of an **Owner** select (`connections-owner-filter`) and left the
 * tablist with `Connections` and the superuser-only `Manage providers`. No 1.13.x
 * line carries either change, and the patch releases validated on demand are
 * 1.13.x, so a spec that switches views has to work on both sides.
 *
 * The side is decided by the VERSION the instance declares, never by looking for
 * the select: probing the DOM would pass a 1.14 build that lost the filter by
 * accident (the reasoning of `served-version.ts`).
 *
 * `1.14.0.dev22` alone carried the old tabs plus `Manage providers`; it is not a
 * side of its own here — no lane runs it any more — and is read as the tab shape,
 * which it was.
 *
 * Known blind spot, shared with `served-version.ts`: a SOURCE build of
 * `release-1.14.0` declares plain `1.14.0`, which ranks above `dev23`, so a
 * checkout from between langflow#16251 and langflow#16254 is read as the select
 * shape although it still has the tabs. Built images carry `.devN` and are
 * classified correctly.
 */
export const OWNER_FILTER_SINCE = "1.14.0.dev23";

export type OwnerView = "Mine" | "Instance" | "Other users";

/** The ownership views the page offers a superuser, in the order it lists them. */
export const OWNER_VIEWS: readonly OwnerView[] = [
  "Mine",
  "Instance",
  "Other users",
];

/** True when this version picks the owner with the select rather than with tabs. */
export function ownerFilterFor(version: unknown): boolean {
  return versionAtLeast(version, OWNER_FILTER_SINCE);
}

/** `ownerFilterFor` against the instance's own `GET /api/v1/version`. */
export async function servedOwnerFilter(
  request: APIRequestContext,
): Promise<boolean> {
  return ownerFilterFor(await servedVersion(request));
}

/** The tablist *Connection views*, on either side. */
export function connectionViews(page: Page): Locator {
  return page.getByRole("tablist", { name: "Connection views" });
}

/** The Owner select (from `1.14.0.dev23`). */
export function ownerFilter(page: Page): Locator {
  return page.getByTestId("connections-owner-filter");
}

/**
 * Asserts that `view` is the one being listed: the select reads it, or its tab is
 * selected.
 */
export async function expectOwnerView(
  page: Page,
  filter: boolean,
  view: OwnerView,
): Promise<void> {
  if (filter) {
    await expect(
      ownerFilter(page),
      `the Owner filter reads ${view}`,
    ).toHaveText(view);
    return;
  }
  await expect(
    connectionViews(page).getByRole("tab", { name: view, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
}

/** Switches the page to `view` and asserts the switch landed. */
export async function showOwnerView(
  page: Page,
  filter: boolean,
  view: OwnerView,
): Promise<void> {
  if (filter) {
    await ownerFilter(page).click();
    await page.getByRole("option", { name: view, exact: true }).click();
  } else {
    await connectionViews(page)
      .getByRole("tab", { name: view, exact: true })
      .click();
  }
  await expectOwnerView(page, filter, view);
}
