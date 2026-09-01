import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  getSharedRbacSubject,
  readAuditLog,
  reconcileEntities,
  requireRbacInstance,
  type RbacUser,
  attemptFlowCreate,
  getProjectOwnedBy,
} from "../../../../helpers/enterprise/rbac";

/**
 * Three operator surfaces beside the instance-wide reconcile: scoped reconcile,
 * audit export status, and directory membership sync. Each is something an
 * administrator makes a decision from, and none is referenced by any other spec.
 *
 * Scoped reconcile works only when `entity_key` is the CASBIN key — `role:viewer`
 * answers `200` with `trigger: "operator:targeted"`. A role's UUID, its bare name,
 * and a key matching nothing all answer `500` with a `message` envelope rather
 * than the `detail` every other refusal here uses, which is the signature of an
 * unhandled exception (#1555). Test 2 asserts the correct behaviour and is
 * therefore EXPECTED RED.
 *
 * The audit filters are asserted from the POSITIVE side only. An invalid filter
 * value answers `200` with an empty envelope, indistinguishable in shape from
 * "nothing matched" (#1555) — an auditor with a typo gets a clean bill of health.
 * That is a real hazard, and it is also a product choice between `422` and empty:
 * pinning today's answer as correct would be this repo deciding it by assertion,
 * so it is documented and the tests assert only that a valid filter genuinely
 * filters, which nothing did before.
 *
 * Directory sync is guarded by the AGE of the snapshot, not by replay: a fresh
 * `observed_at` is accepted and `2020-01-01` is refused `409`. It is submitted with
 * `users: []`, because a snapshot carrying real memberships would mutate them on a
 * shared instance and the guard under test is the timestamp.
 */

const SUPERUSER_GUARD = "Superuser required for authz admin endpoints";
const ADMIN_ROUTE_GUARD = "RBAC administrator role required";

test.describe("Enterprise — operator surfaces: scoped reconcile, audit filters, SIEM, directory sync", () => {
  let superuserAuth: string;
  let subject: RbacUser;

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, superuserAuth);
    subject = await getSharedRbacSubject(request, superuserAuth);
  });

  test(
    "a scoped reconcile reports itself as targeted, validates its enum, and is superuser-only",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const scoped = await reconcileEntities(request, superuserAuth, [
        { entity_type: "role", entity_key: "role:viewer" },
      ]);
      expect(scoped.status(), await scoped.text()).toBe(200);
      const verdict = (await scoped.json()) as {
        trigger?: string;
        scope?: string;
        outcome?: string;
      };
      // Not just a 200: the verdict has to say it was NARROWED. A targeted call
      // silently falling back to an instance-wide pass would look identical from
      // the status alone, and would make a scoped reconcile pointless.
      expect(verdict.scope).toBe("entities");
      expect(verdict.trigger).toBe("operator:targeted");

      const bogusType = await reconcileEntities(request, superuserAuth, [
        { entity_type: "bogus", entity_key: "role:viewer" },
      ]);
      // The enum IS validated — which is what makes the 500 in the next test a
      // defect rather than this endpoint simply being unvalidated.
      expect(bogusType.status()).toBe(422);
      expect(await bogusType.text()).toContain("'role', 'assignment', 'team'");

      const asSubject = await reconcileEntities(request, subject.auth, [
        { entity_type: "role", entity_key: "role:viewer" },
      ]);
      expect(asSubject.status()).toBe(403);
      expect(((await asSubject.json()) as { detail: string }).detail).toBe(
        SUPERUSER_GUARD,
      );
    },
  );

  test(
    "an unknown entity key is a client error, not a server error",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      // EXPECTED RED (#1555). A key that matches nothing answers 500 with a
      // `message` envelope. The request is well-formed and its enum field passed
      // validation, so the caller has no way to learn that the id they took from
      // `GET /authz/roles` is the wrong identifier for this endpoint.
      const unknown = await reconcileEntities(request, superuserAuth, [
        { entity_type: "role", entity_key: "role:does-not-exist-anywhere" },
      ]);
      expect(unknown.status()).toBeLessThan(500);
    },
  );

  test(
    "the audit filters actually filter",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      // Produce an auditable event in THIS run, so the assertion does not depend
      // on what the container happens to carry.
      // Seeded into a project the subject does not own. A bare create is
      // allowed by the owner override and audited as `owner_override`, not
      // `deny` — so since the 2026-08-27 build the old seed produced nothing for
      // `?result=deny` to find, and this test failed for want of a denial rather
      // than for a filtering fault (#1635).
      const foreignProjectId = await getProjectOwnedBy(request, superuserAuth);
      const denied = await attemptFlowCreate(
        request,
        subject.auth,
        `audit-filter-${Date.now()}`,
        foreignProjectId,
      );
      expect(denied.status()).toBe(403);

      const denies = await request.get("/api/v1/authz/audit?result=deny&size=25", {
        headers: { Authorization: superuserAuth },
      });
      expect(denies.status()).toBe(200);
      const body = (await denies.json()) as {
        items: { result: string }[];
        total: number;
      };
      expect(body.items.length).toBeGreaterThan(0);
      // EVERY row, not just the presence of rows: a filter that is accepted and
      // ignored returns a populated list that looks exactly like a filtered one.
      expect(body.items.every((entry) => entry.result === "deny")).toBe(true);

      // And the unfiltered read still works through the shared helper, so the
      // filter is narrowing rather than being the only thing that answers.
      const all = await readAuditLog(request, superuserAuth);
      expect(all.length).toBeGreaterThan(0);
    },
  );

  test(
    "SIEM status is coherently disabled, and behind a different guard than the audit log",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const status = await request.get("/api/v1/authz/siem/status", {
        headers: { Authorization: superuserAuth },
      });
      expect(status.status()).toBe(200);
      const body = (await status.json()) as Record<string, unknown>;
      // Coherently disabled, all together. The state that would mislead an
      // operator is a mixed one — `enabled: true` with no adapter configured
      // reads as "audit is being exported" when nothing leaves the instance.
      expect(body.enabled).toBe(false);
      expect(body.active).toBe(false);
      expect(body.adapter_configured).toBe(false);
      expect(body.capture_ready).toBe(false);
      expect(body.event_schema).toBeTruthy();

      const siemAsSubject = await request.get("/api/v1/authz/siem/status", {
        headers: { Authorization: subject.auth },
      });
      const auditAsSubject = await request.get("/api/v1/authz/audit?size=1", {
        headers: { Authorization: subject.auth },
      });
      expect(siemAsSubject.status()).toBe(403);
      expect(auditAsSubject.status()).toBe(403);
      // Side by side on purpose: two adjacent audit routes, both 403, behind
      // DIFFERENT guards. A client that cannot tell them apart tells the user to
      // ask the wrong person.
      expect(((await siemAsSubject.json()) as { detail: string }).detail).toBe(
        SUPERUSER_GUARD,
      );
      expect(((await auditAsSubject.json()) as { detail: string }).detail).toBe(
        ADMIN_ROUTE_GUARD,
      );
    },
  );

  test(
    "the directory snapshot is guarded by its age, and the route by the admin role",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const route = "/api/v1/authz/directory/memberships/reconcile";
      // Generated per run, so two runs never argue over one provider's history.
      const providerId = `e2e-probe-${Date.now()}`;
      const fresh = {
        provider_id: providerId,
        observed_at: new Date().toISOString(),
        users: [] as unknown[],
      };

      const accepted = await request.post(route, {
        headers: { Authorization: superuserAuth },
        data: fresh,
      });
      expect(accepted.status(), await accepted.text()).toBe(200);
      const report = (await accepted.json()) as {
        snapshot_age_seconds?: number;
        propagation?: string;
      };
      expect(report.snapshot_age_seconds).toBeLessThan(60);
      expect(report.propagation).toBeTruthy();

      const stale = await request.post(route, {
        headers: { Authorization: superuserAuth },
        data: { ...fresh, observed_at: "2020-01-01T00:00:00Z" },
      });
      expect(stale.status()).toBe(409);
      expect(((await stale.json()) as { detail: string }).detail).toContain(
        "stale",
      );

      // With a VALID body — this route validates before it authorizes, so an
      // empty body answers 422 to anybody and would read as "the route is open".
      const asSubject = await request.post(route, {
        headers: { Authorization: subject.auth },
        data: fresh,
      });
      expect(asSubject.status()).toBe(403);
      expect(((await asSubject.json()) as { detail: string }).detail).toBe(
        ADMIN_ROUTE_GUARD,
      );
    },
  );
});
