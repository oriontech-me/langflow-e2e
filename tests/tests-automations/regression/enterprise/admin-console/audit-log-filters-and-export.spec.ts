import type {
  APIRequestContext,
  Page,
  Response as PwResponse,
} from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import type { RbacUser } from "../../../../helpers/enterprise/rbac";
import {
  attemptFlowCreate,
  cleanupRbacUser,
  createRbacUser,
  getProjectOwnedBy,
  getSharedRbacSubject,
  requireRbacInstance,
} from "../../../../helpers/enterprise/rbac";

/**
 * What the audit-log screen SENDS, as opposed to what it shows.
 *
 * `enterprise/authz/operator-surfaces.spec.ts` covers the audit API: that
 * `?result=deny` narrows and that every returned row is a deny. This covers the
 * screen over it, and the two can disagree in ways the API spec cannot see — a
 * control can filter client-side, or send a parameter the backend ignores, and
 * the listing looks filtered either way.
 *
 * It is also the one screen in this console whose DEFAULTS change what an
 * operator believes they are looking at. The first request is
 *
 *   ?exclude_event=authorization_decision&since=<7 days ago>&page=1&size=50
 *
 * so permission checks are hidden and a seven-day window applies, and the only
 * place either is stated is the screen's own controls. Neither is a defect;
 * both mean a build that changed what the default hides without changing what
 * the controls say would be invisible.
 *
 * The export is asserted on its REQUEST and not on its file, and that is
 * measured rather than cautious — see #1639 and the spec doc.
 */

const AUDIT_PATH = "/api/v1/authz/audit";

/** The seven-day default, as the Time range control states it. */
const DEFAULT_RANGE = "Last 7 days";

/**
 * `Event type` labels are relabellings, not slugs: this one sends
 * `resource_type=sso_connection`. A screen that sent its own label would filter
 * nothing and still look filtered, so one pair is pinned rather than assumed.
 */
const EVENT_TYPE_LABEL = "Connections & sign-in";
const EVENT_TYPE_PARAM = "sso_connection";

/** The screen's page size, which the export must NOT be limited to. */
const PAGE_SIZE = 50;

function panel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-audit-logs");
}

/**
 * Record the query of every audit read, in order, as each one COMPLETES.
 *
 * Responses rather than requests, and that is load-bearing rather than tidy.
 * The screen's request layer deduplicates by pathname (#1639): clicking Export
 * while a listing read is still in flight suppresses the export's own request
 * entirely, and the first version of this file did exactly that — it advanced as
 * soon as the filter's request was SENT, clicked Export into the open window,
 * and timed out waiting for a read that was never issued. Waiting for the
 * response closes the window, and measured with the gap in place the export
 * fires 4 times out of 4 with no duplicate warning at all.
 *
 * Armed before navigating: the first read fires during the load, and it is the
 * one that carries the defaults this spec is about.
 */
function recordAuditQueries(page: Page): string[] {
  const queries: string[] = [];
  page.on("response", (response: PwResponse) => {
    const url = new URL(response.url());
    if (url.pathname === AUDIT_PATH && response.request().method() === "GET") {
      queries.push(url.search);
    }
  });
  return queries;
}

/** The most recent audit query, once one later than `after` has COMPLETED. */
async function nextQuery(queries: string[], after: number): Promise<string> {
  await expect
    .poll(() => queries.length, {
      message:
        "the control did not cause a new audit read — if this is the Export " +
        "control, the screen's dedupe may have swallowed it (#1639)",
      timeout: 15_000,
    })
    .toBeGreaterThan(after);
  return queries[queries.length - 1];
}

async function openAuditScreen(page: Page) {
  const queries = recordAuditQueries(page);
  await page.goto(`/admin-ee/audit-logs`);
  // Wait for the panel, not the request: the assertions below read controls,
  // and a screen that has not mounted has none to read.
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  await nextQuery(queries, 0);
  return queries;
}

/**
 * Let the screen's request dedupe release before issuing another read.
 *
 * The only wait in this file, and the number is measured rather than chosen.
 * The request layer deduplicates by pathname (#1639): a read issued in the
 * moment after a previous one completes is swallowed, silently, and the export
 * is the only control here that issues a read a user asked for rather than one
 * the screen issues itself.
 *
 * Measured on this build, exporting at a fixed gap after the filter's response
 * landed, twice per gap:
 *
 *   gap    0 ms -> the export's request fired 0 / 2
 *   gap  250 ms -> 2 / 2
 *   gap  500 / 1000 / 2000 ms -> 2 / 2
 *
 * So the window closes inside 250 ms. This waits three times that, which is
 * generous against a threshold that sharp and still trivial against the test's
 * runtime. There is no state to poll instead: the Export control never disables,
 * and the read arrays are already quiet inside the window — measured both.
 */
async function settleDedupeWindow(page: Page): Promise<void> {
  await page.waitForTimeout(750);
}

async function chooseOption(page: Page, combobox: string, option: RegExp) {
  await panel(page).getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option }).first().click();
}

/**
 * Create a subject unique to this run and have it refused a write, so the audit
 * log holds a denial THIS RUN produced.
 *
 * Two things it must be, and each was learned by a test passing when it should
 * not have:
 *
 *  - **In-run**, because a filter assertion over rows the instance happened to
 *    carry passes for reasons unrelated to the filter — and on a fresh instance
 *    has nothing to assert over at all. The export test learned this the hard
 *    way: it filtered to `Deny` without seeding one and failed deterministically
 *    the first time it met a clean database, with `Export CSV` correctly
 *    `disabled` over an empty set (#1663).
 *  - **Identifiable**, because the directory's shared subject carries denials
 *    from every previous run, so "every visible row is a deny" was satisfied
 *    regardless. A username that cannot pre-exist fixes that; it costs the one
 *    login this file spends.
 *
 * The refusal has to name a project the subject does NOT own. Since the
 * 2026-08-27 build a bare `POST /api/v1/flows/` is allowed by the owner override
 * and audited `owner_override`, not `deny` (#1635).
 */
async function seedDenial(
  request: APIRequestContext,
  auth: string,
  prefix: string,
): Promise<RbacUser> {
  const foreignProjectId = await getProjectOwnedBy(request, auth);
  const subject = await createRbacUser(request, auth, prefix);
  const refused = await attemptFlowCreate(
    request,
    subject.auth,
    `${prefix}-deny-${Date.now()}`,
    foreignProjectId,
  );
  expect(refused.status(), await refused.text()).toBe(403);
  return subject;
}

/**
 * The same denial, seeded as the directory's SHARED subject — no new login.
 *
 * Used where the assertion needs the filtered set to be non-empty but does not
 * need to recognise which row it seeded. That distinction is the whole reason
 * both variants exist, and getting it wrong cost a run: making both tests create
 * a unique subject doubled this file's login cost, and EE allows five per minute
 * for the whole machine — so the fix for a data dependency (#1663) arrived as a
 * `429`, which is flaky by construction rather than merely on a clean database.
 *
 * The shared subject is cached across processes and validated before reuse, so
 * after the first run this costs nothing. On a fresh instance it costs one.
 */
async function seedDenialAsSharedSubject(
  request: APIRequestContext,
  auth: string,
): Promise<void> {
  const foreignProjectId = await getProjectOwnedBy(request, auth);
  const subject = await getSharedRbacSubject(request, auth);
  const refused = await attemptFlowCreate(
    request,
    subject.auth,
    `audit-export-deny-${Date.now()}`,
    foreignProjectId,
  );
  expect(refused.status(), await refused.text()).toBe(403);
}

test.describe("Enterprise — the audit-log screen sends the filter it displays", () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, auth);
    await seedEnterpriseUiSession(page, request);
  });

  test(
    "the default view narrows twice, and says so on both controls",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);

      await test.step("permission checks are excluded, and the checkbox reflects it", async () => {
        expect(queries[0]).toContain("exclude_event=authorization_decision");
        // The pair is the point. A request that hides a whole event class while
        // the control claims otherwise is a screen lying to the operator about
        // what "the audit log" contains — and denials live in that class.
        await expect(panel(page).getByRole("checkbox")).not.toBeChecked();
      });

      await test.step("a time window is applied, and the range control names it", async () => {
        expect(queries[0]).toMatch(/[?&]since=/);
        await expect(
          panel(page).getByRole("combobox", { name: "Time range" }),
        ).toHaveText(new RegExp(DEFAULT_RANGE, "i"));
      });
    },
  );

  test(
    "including permission checks drops the exclusion from the query",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);
      const before = queries.length;

      await panel(page).getByRole("checkbox").check();

      // The control has to change the QUERY, not only itself. A checkbox that
      // ticks and sends nothing leaves the operator reading a log that still
      // hides the events they turned on.
      const query = await nextQuery(queries, before);
      expect(query).not.toContain("exclude_event");
    },
  );

  test(
    "the Result filter narrows server-side, and every visible row matches",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const subject = await seedDenial(request, auth, "audit-screen");

      try {
        const queries = await openAuditScreen(page);

        // Denials ARE authorization decisions, which the default view excludes —
        // so the filter would return an empty log without this, and the test
        // would pass over nothing.
        let before = queries.length;
        await panel(page).getByRole("checkbox").check();
        await nextQuery(queries, before);

        before = queries.length;
        await chooseOption(page, "Result", /^Deny$/i);
        const query = await nextQuery(queries, before);

        await test.step("the query carries the filter", async () => {
          expect(query).toContain("result=deny");
        });

        await test.step("and EVERY row shown is a deny", async () => {
          // The BODY rowgroup. `getByRole("row")` over the table includes the
          // header, whose text has no verdict in it, so the first version of this
          // assertion failed on its own column titles.
          const body = panel(page).getByRole("rowgroup").last();
          await expect
            .poll(() => body.getByRole("row").count(), { timeout: 15_000 })
            .toBeGreaterThan(0);

          // Every row, not the presence of rows: a filter that is accepted and
          // ignored returns a populated list that looks exactly like a filtered
          // one, which is the failure this assertion exists for.
          const results = await body.getByRole("row").allInnerTexts();
          expect(results.length).toBeGreaterThan(0);
          for (const row of results) {
            expect(
              row,
              `a row survived the Deny filter without being one`,
            ).toMatch(/deny/i);
          }

          // And THIS run's denial is among them. Without this the assertion above
          // is satisfied by whatever denials the container already held, and the
          // seed proves nothing — which is exactly what a mutation demonstrated.
          expect(
            results.some((row) => row.includes(subject.username)),
            `the denial seeded for ${subject.username} is not among the ` +
              `${results.length} row(s) the Deny filter returned`,
          ).toBe(true);
        });
      } finally {
        await cleanupRbacUser(request, auth, subject);
      }
    },
  );

  test(
    "an Event type label sends the API's value, not its own text",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);
      const before = queries.length;

      await chooseOption(
        page,
        "Event type",
        new RegExp(`^${EVENT_TYPE_LABEL}$`),
      );

      const query = await nextQuery(queries, before);
      // The labels are relabellings: a screen that sent "Connections & sign-in"
      // would filter nothing and still look filtered.
      expect(query).toContain(`resource_type=${EVENT_TYPE_PARAM}`);
    },
  );

  test(
    "Export CSV asks for the filtered set rather than the visible page",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      // Seeded for the same reason the Result test seeds: the filter below must
      // select something. Without it, on an instance with no denials in the
      // default window, `Export CSV` is correctly DISABLED over an empty set and
      // the click times out — exactly how this test failed the first time it met
      // a fresh database (#1663).
      //
      // As the SHARED subject, not a fresh one: this test never has to recognise
      // the row it seeded, and a second unique subject would double the file's
      // login cost against a five-per-minute budget.
      await seedDenialAsSharedSubject(request, auth);

      {
        const queries = await openAuditScreen(page);

        // Denials are authorization decisions, which the default view excludes.
        // Without this the Deny filter selects nothing however well it is seeded.
        let before = queries.length;
        await panel(page).getByRole("checkbox").check();
        await nextQuery(queries, before);

        before = queries.length;
        await chooseOption(page, "Result", /^Deny$/i);
        await nextQuery(queries, before);

        // The set is non-empty BECAUSE this run made it so, not because the
        // container was dirty. Asserted before exporting, so a disabled control
        // reports the real cause rather than a click timeout.
        await expect(
          panel(page).getByRole("button", { name: "Export CSV" }),
          "nothing matched the filter, so there is nothing to export",
        ).toBeEnabled();

        await settleDedupeWindow(page);

        before = queries.length;
        await panel(page).getByRole("button", { name: "Export CSV" }).click();
        const query = await nextQuery(queries, before);

        await test.step("the export carries the active filter", async () => {
          // Asserted on the REQUEST, never on the file. Measured on this build:
          // the export answers 200 and produces no download, 0 of 12 attempts,
          // each logging `Duplicate request: /api/v1/authz/audit` (#1639).
          // Asserting the file would pin that defect; asserting it loosely
          // enough to pass would pin nothing. Both properties worth protecting
          // live here.
          expect(query).toContain("result=deny");
        });

        await test.step("and asks beyond the visible page", async () => {
          // An export limited to the page would hand an operator 50 rows while
          // they believe they exported the filtered set. Measured: the screen
          // reads `size=50`, the export `size=200`.
          const size = Number(new URLSearchParams(query).get("size"));
          expect(size, `the export requested size=${size}`).toBeGreaterThan(
            PAGE_SIZE,
          );
        });
      }
    },
  );
});
