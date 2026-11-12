import { expect, type Page } from "@playwright/test";

export type ApiVersion = "v1" | "v2";

/**
 * Selects an API version in the open API access modal and asserts it took.
 *
 * Every caller selects its version explicitly because the DEFAULT is not the same
 * on every release line (#2415): upstream #13508 (first nightly `1.14.0.dev23`)
 * made the modal open on `v2` on `release-1.14.0`, while `main` and the 1.13 lines
 * still open on `v1`. The selector itself (`api_version_v1` / `api_version_v2`)
 * exists on all of them. The two versions render different snippets — v1 a single
 * block (`btn-copy-code`) on `/api/v1/run/{id}` with a macOS/Linux ↔ Windows
 * sub-tab on cURL; v2 two steps (`btn-copy-step1/2`) on `POST /api/v2/workflows`
 * — so a spec relying on the default asserts a different snippet per line.
 *
 * The `aria-selected` check makes a click that did not take fail HERE, naming the
 * version, rather than as a wrong-snippet mismatch several steps later.
 */
export async function selectApiVersion(page: Page, version: ApiVersion): Promise<void> {
  const tab = page.getByTestId(`api_version_${version}`);
  await tab.click();
  await expect(tab, `the API access modal did not switch to ${version}`).toHaveAttribute(
    "aria-selected",
    "true",
  );
}
