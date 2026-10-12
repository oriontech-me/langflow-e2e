import { readFileSync } from "node:fs";
import type {
  APIRequestContext,
  Page,
  Response as PwResponse,
} from "@playwright/test";
import type { PageWithErrorHooks } from "../../../../fixtures/fixtures";
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
 * Since 1.13 the screen reads OSS's unified feed (#2259):
 *
 *   ?exclude_action=audit%3Aread&kind=action&since=<7 days ago>&limit=50&include_total=true
 *
 * so permission checks are hidden, the log's own reads are hidden, and a
 * seven-day window applies — and only two of the three are stated by a control.
 * None is a defect; each means a build that changed what the default hides
 * without changing what the controls say would be invisible.
 *
 * The export is now a browser download of `/api/v1/audits/export`, which no
 * request-layer dedupe can swallow — so the FILE is asserted, which #1639 kept
 * this spec from doing on 1.12.
 */

const AUDIT_PATH = "/api/v1/audits";
const EXPORT_PATH = "/api/v1/audits/export";

/** The seven-day default, as the Time filter states it. */
const DEFAULT_RANGE = "Last 7 days";

/**
 * `Resource` labels are relabellings, not slugs: this one sends
 * `resource_type=sso_connection`. A screen that sent its own label would filter
 * nothing and still look filtered, so one pair is pinned rather than assumed.
 */
const RESOURCE_LABEL = "Connections & sign-in";
const RESOURCE_PARAM = "sso_connection";

/** The exported file's columns, in order (OSS `audits.py`). */
const EXPORT_COLUMNS = [
  "timestamp",
  "user_id",
  "actor_type",
  "actor_id",
  "action",
  "resource_type",
  "resource_id",
  "result",
  "details",
  "source",
  "kind",
  "resource_name",
  "operation",
  "error_code",
  "request_id",
];

/**
 * The per-resource audit sources the screen probes on every mount. Both need
 * `audit_read`, which no built-in Enterprise role grants, so they answer 403 to
 * the RBAC superuser too — a product observation recorded in #2259. Declared
 * rather than silenced, so a fix surfaces as a stale declaration naming itself.
 */
const AUDIT_SOURCE_PROBES = ["/api/v1/flows/audits", "/api/v1/projects/audits"];

function panel(page: Page) {
  return page.getByTestId("enterprise-admin-tab-audit-logs");
}

/** Each listed event's row. The collapsed details `<tr>` beside it carries no testid. */
function eventRows(page: Page) {
  return panel(page).locator('[data-testid^="audit-row-"]');
}

/**
 * Record the query of every audit LISTING read, in order, as each completes.
 *
 * `limit=1` reads are skipped: the screen probes the feed's availability with one
 * on load and issues another before an export, and neither is the filter the
 * screen applied. Armed before navigating, because the first listing read fires
 * during the load and carries the defaults this spec is about.
 */
function recordAuditQueries(page: Page): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  page.on("response", (response: PwResponse) => {
    const url = new URL(response.url());
    if (
      url.pathname === AUDIT_PATH &&
      response.request().method() === "GET" &&
      url.searchParams.get("limit") !== "1"
    ) {
      queries.push(url.searchParams);
    }
  });
  return queries;
}

/** The most recent listing query, once one later than `after` has completed. */
async function nextQuery(
  queries: URLSearchParams[],
  after: number,
): Promise<URLSearchParams> {
  await expect
    .poll(() => queries.length, {
      message: "the control did not cause a new audit read",
      timeout: 15_000,
    })
    .toBeGreaterThan(after);
  return queries[queries.length - 1];
}

async function openAuditScreen(page: Page) {
  const queries = recordAuditQueries(page);
  await page.goto("/admin/audit-logs");
  // Wait for the panel, not the request: the assertions below read controls,
  // and a screen that has not mounted has none to read.
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  await nextQuery(queries, 0);
  return queries;
}

/** Open one filter (a listbox button) and pick an option by its exact label. */
async function chooseFilter(page: Page, testId: string, option: string) {
  await panel(page).getByTestId(testId).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Minimal RFC 4180 reader: the `details` column carries quoted JSON. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

/**
 * Create a subject unique to this run and have it refused a write, so the audit
 * log holds a denial THIS RUN produced.
 *
 * In-run, because a filter assertion over rows the instance happened to carry
 * passes for reasons unrelated to the filter (#1663). Identifiable, because the
 * directory's shared subject carries denials from every previous run, so "every
 * visible row is a deny" was satisfied regardless — a username that cannot
 * pre-exist fixes that, at the cost of this file's one login.
 *
 * The refusal names a project the subject does NOT own: a bare create is allowed
 * by the owner override and audited `owner_override`, not `deny` (#1635).
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
 * For a test that needs the filtered set non-empty and can recognise its seed by
 * id rather than by a unique username: a second unique subject would double this
 * file's login cost against a five-per-minute budget.
 */
async function seedDenialAsSharedSubject(
  request: APIRequestContext,
  auth: string,
): Promise<RbacUser> {
  const foreignProjectId = await getProjectOwnedBy(request, auth);
  const subject = await getSharedRbacSubject(request, auth);
  const refused = await attemptFlowCreate(
    request,
    subject.auth,
    `audit-export-deny-${Date.now()}`,
    foreignProjectId,
  );
  expect(refused.status(), await refused.text()).toBe(403);
  return subject;
}

test.describe("Enterprise — the audit-log screen sends the filter it displays", () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, auth);
    await seedEnterpriseUiSession(page, request);
    for (const pathname of AUDIT_SOURCE_PROBES) {
      (page as PageWithErrorHooks).expectKnownHttpError({
        pathname,
        status: 403,
        reason:
          "no built-in Enterprise role grants audit_read, so the audit screen's " +
          "per-resource probe is refused even to the RBAC superuser (#2259)",
      });
    }
  });

  test(
    "the default view narrows twice, and says so on both controls",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);
      const first = queries[0];

      await test.step("permission checks are excluded, and the checkbox reflects it", async () => {
        expect(first.getAll("kind")).toEqual(["action"]);
        // The pair is the point. A request that hides a whole event class while
        // the control claims otherwise is a screen lying to the operator about
        // what "the audit log" contains — and denials live in that class.
        await expect(
          panel(page).getByRole("checkbox", { name: "Include permission checks" }),
        ).not.toBeChecked();
      });

      await test.step("a time window is applied, and the Time filter names it", async () => {
        expect(first.get("since")).toBeTruthy();
        await expect(panel(page).getByTestId("audit-filter-time")).toHaveText(
          new RegExp(DEFAULT_RANGE, "i"),
        );
      });

      await test.step("and the log's own reads are excluded, which no control states", async () => {
        // Pinned so a build that widens or drops this hidden default shows up.
        expect(first.getAll("exclude_action")).toEqual(["audit:read"]);
      });
    },
  );

  test(
    "including permission checks drops the exclusion from the query",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);
      const before = queries.length;

      await panel(page)
        .getByRole("checkbox", { name: "Include permission checks" })
        .click();

      // The control has to change the QUERY, not only itself. A checkbox that
      // ticks and sends nothing leaves the operator reading a log that still
      // hides the events they turned on.
      const query = await nextQuery(queries, before);
      expect(query.has("kind"), `kind is still sent: ${query}`).toBe(false);
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

        const before = queries.length;
        // `Deny` on its own drops `kind=action`, so denials — which are
        // authorization decisions — are listed without ticking the checkbox.
        await chooseFilter(page, "audit-filter-result", "Deny");
        const query = await nextQuery(queries, before);

        await test.step("the query carries the filter", async () => {
          expect(query.get("result")).toBe("deny");
        });

        await test.step("and EVERY row shown is a deny, this run's among them", async () => {
          await expect
            .poll(() => eventRows(page).count(), { timeout: 15_000 })
            .toBeGreaterThan(0);

          // Every row, not the presence of rows: a filter that is accepted and
          // ignored returns a populated list that looks exactly like a filtered
          // one. A denied permission check renders "Denied"; a denied ACTION
          // (e.g. deleting a built-in role) renders "Failed" — both are
          // `result=deny`, and neither is ever "Success" or "Allowed".
          const rows = await eventRows(page).allInnerTexts();
          for (const row of rows) {
            expect(row, "a row survived the Deny filter without being one").toMatch(
              /\b(Denied|Failed)\s*$/,
            );
          }

          // And THIS run's denial is among them. Without this the assertion above
          // is satisfied by whatever denials the container already held.
          expect(
            rows.some((row) => row.includes(subject.username)),
            `the denial seeded for ${subject.username} is not among the ` +
              `${rows.length} row(s) the Deny filter returned`,
          ).toBe(true);
        });
      } finally {
        await cleanupRbacUser(request, auth, subject);
      }
    },
  );

  test(
    "a Resource label sends the API's value, not its own text",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page }) => {
      const queries = await openAuditScreen(page);
      const before = queries.length;

      await chooseFilter(page, "audit-filter-type", RESOURCE_LABEL);

      const query = await nextQuery(queries, before);
      // The labels are relabellings: a screen that sent "Connections & sign-in"
      // would filter nothing and still look filtered.
      expect(query.get("resource_type")).toBe(RESOURCE_PARAM);
    },
  );

  test(
    "Export downloads the filtered set rather than the visible page",
    { tag: ["@enterprise", "@regression", "@ui-ux"] },
    async ({ page, request }) => {
      const auth = await getEnterpriseAuthToken(request);
      // Seeded so the filter selects something on a fresh instance (#1663).
      const subject = await seedDenialAsSharedSubject(request, auth);

      const queries = await openAuditScreen(page);
      const before = queries.length;
      await chooseFilter(page, "audit-filter-result", "Deny");
      await nextQuery(queries, before);

      // Asserted before exporting, so an empty set reports the real cause rather
      // than a click timeout.
      const exportButton = panel(page).getByTestId("audit-export");
      await expect(
        exportButton,
        "nothing matched the filter, so there is nothing to export",
      ).toBeEnabled();

      const downloadEvent = page.waitForEvent("download");
      await exportButton.click();
      const download = await downloadEvent;

      await test.step("the export carries the active filter and no page size", async () => {
        const url = new URL(download.url());
        expect(url.pathname).toBe(EXPORT_PATH);
        expect(url.searchParams.get("result")).toBe("deny");
        // An export limited to the page would hand an operator 50 rows while
        // they believe they exported the filtered set.
        expect(url.searchParams.has("limit"), `export URL: ${url}`).toBe(false);
        expect(url.searchParams.has("size"), `export URL: ${url}`).toBe(false);
      });

      await test.step("the file is the filtered set, with the documented shape", async () => {
        expect(download.suggestedFilename()).toMatch(
          /^langflow-audit-\d{4}-\d{2}-\d{2}\.csv$/,
        );
        const path = await download.path();
        const [header, ...rows] = parseCsv(readFileSync(path, "utf-8"));
        expect(header).toEqual(EXPORT_COLUMNS);
        expect(rows.length, "the export held no rows").toBeGreaterThan(0);

        const result = EXPORT_COLUMNS.indexOf("result");
        const userId = EXPORT_COLUMNS.indexOf("user_id");
        // Every row: a file that ignored the filter would carry allows too.
        expect(rows.filter((row) => row[result] !== "deny")).toEqual([]);
        // And this run's seed is in it, so the file is not an older export's shape.
        expect(
          rows.some((row) => row[userId] === subject.id),
          `the denial seeded by ${subject.username} is not in the exported file`,
        ).toBe(true);
      });
    },
  );
});
