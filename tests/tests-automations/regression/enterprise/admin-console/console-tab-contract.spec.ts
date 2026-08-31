import type { Page } from "@playwright/test";
import type { PageWithErrorHooks } from "../../../../fixtures/fixtures";
import type { KnownHttpDefect } from "../../../../fixtures/http-error-policy";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import { requireRbacInstance } from "../../../../helpers/enterprise/rbac";

/**
 * The shell contract of the Enterprise admin console.
 *
 * `/admin-ee` is the console an operator governs an instance from, and § 21 of
 * the checklist names the admin UI as the part Enterprise exclusively owns —
 * every enforcement mechanism behind it is already covered from the API side.
 * It has seven screens; before this spec one of them was covered, for one
 * field, so nothing would have noticed a screen that stopped loading, a route
 * that stopped resolving, or a tab whose label opened the wrong screen.
 *
 * This file is deliberately shallow. It says nothing about what any screen lets
 * an operator DO — that is a follow-up per tab, and every one of those depends
 * on this one, because an assertion about a filter or a confirmation dialog
 * passes vacuously against a screen that never rendered.
 *
 * Two DOM facts decide its shape, and both are the opposite of the obvious
 * guess. Getting either wrong produces a spec that looks reasonable and asserts
 * nothing:
 *
 *  - The strip holds seven `role="tab"` BUTTONS, not links, named by their
 *    visible label and carrying no testid at all — so navigation is by role and
 *    name, and which one is current is `aria-selected`.
 *  - `data-testid="enterprise-admin-tab-<route>"` is NOT on the tab. Despite its
 *    name it sits on the screen's own `<section role="tabpanel">`, whose
 *    `aria-label` is the tab's visible label, and only the active route's panel
 *    exists in the DOM. The first version of this file read it as the active-tab
 *    marker and failed all nine tests against a console where nothing was wrong.
 *    The correction is an improvement: a container anchors more than a marker —
 *    visible says this screen's content region mounted, unique says no other
 *    mounted with it, and `aria-label` ties the route to the label the strip
 *    shows, which is the mapping this spec exists to pin.
 *
 * Full reasoning, including why each screen is anchored on its subtitle rather
 * than on a testid, in `docs/enterprise/admin-console/console-tab-contract.md`.
 */

interface AdminTab {
  /** Path segment under `/admin-ee/`. */
  route: string;
  /** Visible label on the tab strip. NOT derivable from the route: see `catalog`. */
  label: string;
  /**
   * The screen's own header copy.
   *
   * Anchoring on this rather than on a `data-testid` is measured, not stylistic:
   * four of the seven candidate testids (`models-empty-state`,
   * `providers-recommended-state`, `login-connections-empty-state`,
   * `audit-details-cell`) describe an instance STATE and vanish on a configured
   * instance, and a fifth (`admin-sub-tabs`) is shared with a neighbouring tab.
   * Each subtitle was measured to appear exactly once on its own screen and on
   * none of the other six.
   */
  subtitle: string;
  /**
   * The one API read no other tab performs.
   *
   * The load-bearing assertion of this file. All seven screens paint the same
   * chrome, so "something rendered" is satisfied by any of them; only this
   * separates a screen that loaded from a shell that painted.
   */
  read: string;
  /**
   * 4xx/5xx this screen provokes on purpose, declared so the advisory log stays
   * worth reading.
   *
   * Empty for six of the seven. A declaration that never fires FAILS its test,
   * so this belongs per tab rather than once for the file — and it is data here
   * rather than a branch inside a test body.
   */
  knownHttpErrors: KnownHttpDefect[];
  /**
   * Reads this screen performs beyond `read`, which a caller must await before
   * asserting on the screen.
   *
   * Only `security` has any, and awaiting them is not tidiness (#1636): its
   * `503` on `/api/v1/sso/entitlements` is DECLARED above, and the fixture fails
   * a declaration that does not occur. The per-tab test awaited its own `read`
   * and observed the `503` alongside it; the strip and i18n walks merely passed
   * through and could finish first. Under a full-directory run they did, and the
   * spec reported a stale exemption for a state that was firing on every visit.
   *
   * Measured: entitlements is requested on every arrival at the screen — by
   * `goto`, by clicking the tab, and again on clicking away and back. Nothing is
   * cached, so awaiting it cannot hang.
   *
   * It is also a better test. A screen whose reads have not landed is a screen
   * the i18n scan is reading too early, and an assertion of ABSENCE taken
   * against a half-rendered screen is the failure mode this file's own doc warns
   * about.
   */
  secondaryReads: string[];
}

const TABS: AdminTab[] = [
  {
    route: "users-groups",
    label: "Users & groups",
    subtitle: "Manage users and their access to this Langflow instance.",
    read: "/api/v1/users/",
    knownHttpErrors: [],
    secondaryReads: [],
  },
  {
    route: "access-control",
    label: "Access control",
    subtitle: "Define roles, grant them to people and teams, and review who has access.",
    read: "/api/v1/authz/roles",
    knownHttpErrors: [],
    secondaryReads: [],
  },
  {
    // The one screen whose label does not name its route.
    route: "catalog",
    label: "Components",
    subtitle: "Manage the approved component catalog, builder visibility, and policy.",
    read: "/api/v1/enterprise-admin/catalog/components",
    knownHttpErrors: [],
    secondaryReads: [],
  },
  {
    route: "models",
    label: "Models",
    subtitle: "Choose which models are available in this Langflow instance.",
    read: "/api/v1/model-availability-policy",
    knownHttpErrors: [],
    secondaryReads: [],
  },
  {
    route: "providers",
    label: "Providers",
    subtitle: "Approve model providers globally for this Langflow installation.",
    read: "/api/v1/model-provider-policy",
    knownHttpErrors: [],
    secondaryReads: [],
  },
  {
    route: "security",
    label: "Security",
    subtitle: "Configure login connections, recovery access, and security defaults.",
    read: "/api/v1/sso/connections",
    // The screen also reads entitlements, and an Enterprise instance with no
    // licence refuses that with 503 — correctly, by design. Not this spec's
    // finding: `enterprise/auth/entitlement-fail-closed.spec.ts` asserts that
    // exact refusal as the product's contract. Declared rather than silenced
    // with `allowHttpErrors()`, which would take the whole test's advisory log
    // with it, and verified in both directions: against a LICENSED instance the
    // 503 stops firing and the fixture fails naming this entry to delete.
    knownHttpErrors: [
      {
        pathname: "/api/v1/sso/entitlements",
        status: 503,
        reason:
          "an unlicensed Enterprise instance refuses the entitlements read by design — " +
          "the contract asserted by enterprise/auth/entitlement-fail-closed.spec.ts",
      },
    ],
    // The read that carries the declaration above. Awaited on every arrival, so
    // the declaration cannot go stale on a loaded run (#1636).
    secondaryReads: ["/api/v1/sso/entitlements"],
  },
  {
    route: "audit-logs",
    label: "Audit logs",
    subtitle: "Sign-on and access-control events for this Langflow instance, newest first.",
    read: "/api/v1/authz/audit",
    knownHttpErrors: [],
    secondaryReads: [],
  },
];

/**
 * A `namespace.someKey` token appearing anywhere in a string.
 *
 * Anywhere, not anchored, and that is measured rather than cautious: the most
 * serious of #1563's findings reaches the DOM as the COMPOSED accessible name
 * `"admin.deleteTitle — langflow"` on the delete-account button. An anchored
 * pattern reports the seven harmless column headers and misses that one.
 */
const I18N_KEY_TOKEN = /(?:^|\s)([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?=\s|$)/g;

/**
 * Every unresolved translation key in one string.
 *
 * The shape filter is the price of matching anywhere. Measured on the console:
 * unanchored matching produces exactly one false positive, *Approve IBM
 * watsonx.ai models for use across Langflow.* — a product name that is
 * `namespace.token` in shape. An i18n key names a message, so some segment of
 * it is camelCase (`deleteTitle`, `columnUsername`, `cannotDeactivateSelf`) or
 * it is nested more than one level deep; `watsonx.ai` is neither.
 *
 * The filter can miss an all-lowercase single-dot key, and that is the right
 * direction to be wrong in: a locale regression drops a namespace, not one
 * string, so its camelCase siblings still fail this test — while a fabricated
 * finding would send someone to read a screen that is correct.
 *
 * Measured both ways: 0 on the build this spec is validated against, 9 distinct
 * keys on the 2026-08-18 build that shipped the defect.
 */
function unresolvedI18nKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(I18N_KEY_TOKEN)) {
    const key = match[1];
    const segments = key.split(".");
    if (segments.length > 2 || segments.some((segment) => /[A-Z]/.test(segment))) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The screen's own content region.
 *
 * Named `...-tab-...` but mounted on the `role="tabpanel"` section, and only for
 * the active route — see the note at the top of this file.
 */
function screenPanel(page: Page, route: string) {
  return page.getByTestId(`enterprise-admin-tab-${route}`);
}

/** The strip button for one screen. Carries no testid; named by its label. */
function stripTab(page: Page, label: string) {
  return page.getByRole("tab", { name: label, exact: true });
}

/**
 * Arm a wait for every read this screen performs, BEFORE navigating to it.
 *
 * Armed first because the reads fire during the navigation: asking afterwards is
 * a race the screen usually wins, which is exactly how #1636 got in.
 */
function armReads(page: Page, tab: AdminTab) {
  return [tab.read, ...tab.secondaryReads].map((pathname) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === pathname &&
        response.request().method() === "GET",
      { timeout: 30_000 },
    ),
  );
}

/**
 * Navigate to one screen, wait for its reads to land, and assert it rendered.
 *
 * Used by the strip and i18n walks. `navigate` is passed in because they arrive
 * differently — one clicks the tab, the other deep-links — while what has to be
 * true on arrival is identical.
 */
async function visitScreen(
  page: Page,
  tab: AdminTab,
  navigate: () => Promise<unknown>,
): Promise<void> {
  const reads = armReads(page, tab);
  await navigate();
  await Promise.all(reads);
  await expectScreenRendered(page, tab);
}

/**
 * Open one screen and assert it is the one that rendered.
 *
 * Shared by the strip test and the i18n test so neither can inspect a screen
 * that never arrived — the failure mode that makes an assertion of absence pass
 * forever.
 */
async function expectScreenRendered(page: Page, tab: AdminTab): Promise<void> {
  await expect(
    screenPanel(page, tab.route),
    `'${tab.route}' did not mount its own panel`,
  ).toBeVisible();
  await expect(
    page.getByText(tab.subtitle, { exact: true }),
    `'${tab.route}' mounted its panel but not its body — the subtitle '${tab.subtitle}' is absent`,
  ).toBeVisible();
}

/**
 * Apply a screen's declared 4xx/5xx to the running test.
 *
 * Table-driven so six of the seven pass an empty list and no test body needs a
 * branch. See `AdminTab.knownHttpErrors` for why a blanket declaration is wrong.
 */
function declareKnownHttpErrors(page: Page, tabs: AdminTab[]): void {
  for (const defect of tabs.flatMap((tab) => tab.knownHttpErrors)) {
    (page as PageWithErrorHooks).expectKnownHttpError(defect);
  }
}

test.describe("Enterprise — every screen of the admin console resolves and loads its own data", () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await getEnterpriseAuthToken(request);
    // `access-control` and `audit-logs` read `/authz/*` and have nothing to load
    // on a container without authorization, so two of the seven screens would
    // report an environment choice as a product failure.
    await requireRbacInstance(request, auth);
    // Seeded, not filled: the instance rate-limits login to 5/min for the whole
    // machine, and the login form is `enterprise/auth/login-surface`'s subject.
    await seedEnterpriseUiSession(page, request);
  });

  for (const tab of TABS) {
    test(
      `the ${tab.label} screen deep-links to itself and performs its own read`,
      { tag: ["@enterprise", "@regression", "@ui-ux"] },
      async ({ page }) => {
        declareKnownHttpErrors(page, [tab]);

        // Armed BEFORE navigating: the reads fire during the load, and asking
        // afterwards would be a race the screen usually wins.
        const [read, ...secondary] = armReads(page, tab);

        await page.goto(`/admin-ee/${tab.route}`);

        await test.step("the route resolves to itself rather than a default tab", async () => {
          // Asserted first and separately. A screen that redirected would go on
          // to satisfy every remaining assertion — of the DEFAULT tab.
          await expect(page).toHaveURL(new RegExp(`/admin-ee/${tab.route}(?:[?#]|$)`));
        });

        await test.step("the strip marks it as the current screen", async () => {
          await expect(stripTab(page, tab.label)).toHaveAttribute("aria-selected", "true");
        });

        await test.step("its own panel mounted, labelled as the tab that opens it", async () => {
          // The panel is where the route<->label mapping is actually pinned:
          // `Components` is `/admin-ee/catalog`, so the label cannot be derived.
          await expect(screenPanel(page, tab.route)).toBeVisible();
          await expect(screenPanel(page, tab.route)).toHaveAttribute("aria-label", tab.label);
        });

        await test.step("and its body rendered inside it", async () => {
          await expect(page.getByText(tab.subtitle, { exact: true })).toBeVisible();
        });

        await test.step(`and it performed its own read of ${tab.read}`, async () => {
          // The assertion that separates a loaded screen from a painted shell.
          const response = await read;
          expect(
            response.status(),
            `${tab.route} read ${tab.read} and the instance answered ${response.status()}`,
          ).toBeLessThan(300);

          // Not asserted on, only awaited: a screen's secondary reads are its
          // own business, but a declared HTTP state among them has to have
          // OCCURRED before this test ends (#1636).
          await Promise.all(secondary);
        });
      },
    );
  }

  test(
    "the tab strip opens the screen each label names",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      declareKnownHttpErrors(page, TABS);

      // Start somewhere the walk does not begin on, so the first click is a real
      // navigation rather than a no-op on the already-selected tab.
      const [first, ...rest] = TABS;
      await visitScreen(page, first, () => page.goto(`/admin-ee/${first.route}`));

      for (const tab of rest) {
        await test.step(`'${tab.label}' opens /admin-ee/${tab.route}`, async () => {
          // By role and name: the strip buttons carry no testid, and the label
          // does not name the route for `Components` -> `catalog`.
          await visitScreen(page, tab, () => stripTab(page, tab.label).click());
          await expect(page).toHaveURL(new RegExp(`/admin-ee/${tab.route}(?:[?#]|$)`));
        });
      }
    },
  );

  test(
    "no screen in the console renders an unresolved i18n key",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      // The guard of #1563, where `users-groups` shipped seventeen raw `admin.*`
      // keys — every column header, the two account toggles, and the
      // delete-confirmation dialog's title, body and both buttons, so the last
      // thing between a click and a deleted account stated nothing.
      declareKnownHttpErrors(page, TABS);

      const findings: string[] = [];

      for (const tab of TABS) {
        // Required before inspecting text: a blank screen satisfies "no raw
        // keys" perfectly and would keep satisfying it forever — and a screen
        // whose reads have not landed is one this scan is reading too early.
        await visitScreen(page, tab, () => page.goto(`/admin-ee/${tab.route}`));

        const raw = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll("body *"));
          const strings: string[] = [];

          for (const element of elements) {
            // Visible text: what the operator reads.
            if (element.children.length === 0) {
              strings.push((element.textContent ?? "").trim());
            }
            // Accessible names: what a screen-reader user is told instead. This
            // half is not decoration — #1563's `admin.deleteTitle` was the
            // accessible name of the DELETE-ACCOUNT button, and the two toggles
            // that deactivate an account and grant superuser were named the same
            // way. None of them is leaf text, so a scan of rendered copy alone
            // reports the harmless keys and misses every serious one.
            for (const attribute of ["aria-label", "title", "placeholder"]) {
              strings.push((element.getAttribute(attribute) ?? "").trim());
            }
          }

          return Array.from(new Set(strings.filter(Boolean)));
        });

        // Deduplicated by KEY, not by the string carrying it: the same key
        // reaches the DOM both bare and composed into an accessible name, and
        // reporting it twice would make the control's count read as noise.
        for (const key of new Set(raw.flatMap(unresolvedI18nKeys))) {
          findings.push(`${tab.route}: ${key}`);
        }
      }

      // Reported all at once, not one at a time: the negative control for this
      // predicate is the 2026-08-18 image, where it must produce nine keys on
      // `users-groups`, and the count is how that control is read.
      expect(
        findings,
        `the admin console rendered ${findings.length} unresolved translation key(s):\n` +
          findings.map((finding) => `  - ${finding}`).join("\n"),
      ).toEqual([]);
    },
  );
});
