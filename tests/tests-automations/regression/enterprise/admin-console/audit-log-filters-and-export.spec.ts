import type { Page, Response as PwResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  getEnterpriseAuthToken,
  seedEnterpriseUiSession,
} from "../../../../helpers/enterprise/enterprise-auth";
import {
  attemptFlowCreate,
  cleanupRbacUser,
  createRbacUser,
  getProjectOwnedBy,
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
      const foreignProjectId = await getProjectOwnedBy(request, auth);
      // A subject unique to this run, NOT the directory's shared one, and the
      // one login this file spends. It is what makes the seeded denial
      // IDENTIFIABLE: the shared subject has denials on this container from
      // every previous run, so "every visible row is a deny" was satisfied by
      // rows the instance already carried — measured, by a mutation that seeded
      // into the subject's OWN project (an `owner_override`, not a deny) and
      // still passed. The seed was decorative. Keyed on a username that cannot
      // pre-exist, it is not.
      const subject = await createRbacUser(request, auth, "audit-screen");

      await test.step("seed a denial in THIS run", async () => {
        // Produced here rather than found in the container: a filter assertion
        // over rows the instance happened to carry passes for reasons unrelated
        // to the filter, and on a fresh instance has nothing to assert over.
        //
        // It has to be a write the subject is REFUSED, which since the
        // 2026-08-27 build means naming a project it does not own — a bare
        // create is allowed by the owner override and audited `owner_override`,
        // not `deny` (#1635).
        const refused = await attemptFlowCreate(
          request,
          subject.auth,
          `audit-screen-deny-${Date.now()}`,
          foreignProjectId,
        );
        expect(refused.status()).toBe(403);
      });

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
    async ({ page }) => {
      const queries = await openAuditScreen(page);

      let before = queries.length;
      await chooseOption(page, "Result", /^Deny$/i);
      await nextQuery(queries, before);

      await settleDedupeWindow(page);

      before = queries.length;
      await panel(page).getByRole("button", { name: "Export CSV" }).click();
      const query = await nextQuery(queries, before);

      await test.step("the export carries the active filter", async () => {
        // Asserted on the REQUEST, never on the file. Measured on this build:
        // the export answers 200 and produces no download, 0 of 12 attempts,
        // each logging `Duplicate request: /api/v1/authz/audit` (#1639).
        // Asserting the file would pin that defect; asserting it loosely enough
        // to pass would pin nothing. Both properties worth protecting live here.
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
    },
  );
});
