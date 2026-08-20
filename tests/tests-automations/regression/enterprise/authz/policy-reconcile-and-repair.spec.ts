import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../../../../fixtures/fixtures";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  getSharedRbacSubject,
  reconcilePolicy,
  requireRbacInstance,
  resetSubjectGrants,
  syncPolicy,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The operator surface for policy drift, and whether its verdicts can be trusted.
 *
 * Enforcement reads `casbin_rule`, which is DERIVED from roles, assignments,
 * teams and shares. Those two representations can diverge, and Enterprise ships
 * `policy/reconcile` (diff, optionally repair), `policy/sync` (clear and rewrite)
 * and a `revision` hash to detect it.
 *
 * What needs pinning is not that the endpoints exist but that an operator can act
 * on what they say:
 *
 *   - a READ must not write, or an operator investigating drift finds it gone and
 *     concludes they imagined it;
 *   - a REPAIR must report what it changed and be idempotent, or "already
 *     consistent" is indistinguishable from "changed again" and the only safe move
 *     is to stop running it;
 *   - the REVISION must be deterministic, or it cannot detect anything: it has to
 *     move for a real change and come back when the change is undone.
 *
 * Two traps are encoded here rather than rediscovered. `repair` is a QUERY
 * parameter — sent in the body it is silently ignored and the same drift is
 * reported call after call, which reads exactly like a dead knob (the first
 * measurement concluded that). And `expected_count` tracks RESOURCES as well as
 * roles, so the revision only returns to a baseline while the project and flow
 * still exist; compared across their creation it compares two different policies.
 */

test.describe("Enterprise — policy reconciliation reads honestly and repairs idempotently", () => {
  let superuserAuth: string;
  let subject: RbacUser;
  let projectId: string;
  let deleteProject: (req?: APIRequestContext) => Promise<void>;
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, superuserAuth);
    subject = await getSharedRbacSubject(request, superuserAuth);

    // A project the grant in test 2 can be scoped to. Created ONCE and kept for
    // the whole file: creating it changes `expected_count`, so a per-test project
    // would move the baseline the revision assertions compare against.
    const project = await createProjectViaApi(
      request,
      { Authorization: superuserAuth },
      { namePrefix: "authz-reconcile" },
    );
    projectId = project.projectId;
    deleteProject = project.deleteProject;
  });

  test.beforeEach(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
  });

  test.afterAll(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
    await deleteProject?.(request).catch(() => undefined);
  });

  test(
    "a plain reconcile is a read: repeatable, and it writes nothing",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const first = await reconcilePolicy(request, superuserAuth);
      const second = await reconcilePolicy(request, superuserAuth);

      expect(first.repair).toBe(false);
      // Two reads of an unchanged instance must agree — on the hash and on every
      // count. A verdict that moves on its own is one an operator cannot act on.
      expect(second.revision).toBe(first.revision);
      expect(second.expected_count).toBe(first.expected_count);
      expect(second.actual_count).toBe(first.actual_count);
      expect(second.missing_count).toBe(first.missing_count);
      expect(second.extra_count).toBe(first.extra_count);

      // The load-bearing half: without repair it must not have written. If it
      // repaired silently, the drift an operator is chasing disappears between
      // two calls neither of which claimed to change anything.
      for (const verdict of [first, second]) {
        expect(verdict.inserted_count).toBe(0);
        expect(verdict.deleted_count).toBe(0);
      }

      const syncA = await syncPolicy(request, superuserAuth);
      const syncB = await syncPolicy(request, superuserAuth);
      expect(syncA.cleared).toBe(true);
      // Same input, same output — sync clears and rewrites, so a differing count
      // on the second call would mean the rewrite is not a function of the
      // derived policy alone.
      expect(syncB.counts).toEqual(syncA.counts);
    },
  );

  test(
    "the revision is deterministic: it moves for a grant and returns when it is revoked",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const baseline = await reconcilePolicy(request, superuserAuth);
      expect(baseline.revision, "the baseline carries a revision").toBeTruthy();

      const roles = await builtinRoleIds(request, superuserAuth);
      granted.assignments.push(
        await assignRole(request, superuserAuth, subject.id, roles.developer, {
          domain_type: "project",
          domain_id: projectId,
        }),
      );

      const afterGrant = await reconcilePolicy(request, superuserAuth);
      // A project-scoped grant writes tens of rules, so this is a change no
      // ordering or rounding difference could produce.
      expect(afterGrant.revision).not.toBe(baseline.revision);
      expect(afterGrant.expected_count!).toBeGreaterThan(
        baseline.expected_count!,
      );

      await resetSubjectGrants(request, superuserAuth, granted);

      const afterRevoke = await reconcilePolicy(request, superuserAuth);
      // Byte-identical, not merely "changed again". The hash is only usable for
      // drift detection if undoing a change restores the exact value — and the
      // project and flow set is unchanged across all three reads, which is what
      // makes the comparison valid at all.
      expect(afterRevoke.revision).toBe(baseline.revision);
      expect(afterRevoke.expected_count).toBe(baseline.expected_count);
    },
  );

  test(
    "repair reports what it changed, and a second repair changes nothing",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const repaired = await reconcilePolicy(request, superuserAuth, {
        repair: true,
      });

      // The knob was honoured. Asserted separately from the outcome because the
      // failure this catches is the body-vs-query trap: `repair` ignored comes
      // back as `false` here while everything else still looks plausible.
      expect(repaired.repair).toBe(true);
      expect(["clean", "repaired"]).toContain(repaired.outcome);

      // Whatever it reported, it must be self-consistent: a `repaired` verdict
      // carries a write, a `clean` one carries none. The alternative — `repaired`
      // with zero writes, or `clean` while writing — is the state that makes the
      // endpoint unusable as evidence.
      const writes =
        (repaired.inserted_count ?? 0) + (repaired.deleted_count ?? 0);
      if (repaired.outcome === "repaired") {
        expect(writes).toBeGreaterThan(0);
      } else {
        expect(writes).toBe(0);
      }

      const again = await reconcilePolicy(request, superuserAuth, {
        repair: true,
      });
      // Idempotence. A repair that keeps finding work on an instance nothing
      // touched in between is indistinguishable from one that never worked.
      expect(again.outcome).toBe("clean");
      expect(again.missing_count).toBe(0);
      expect(again.extra_count).toBe(0);
      expect(again.changed_count).toBe(0);
      expect(again.inserted_count).toBe(0);
      expect(again.deleted_count).toBe(0);
    },
  );

  test(
    "the reconciliation surface is superuser-only, with its own refusal",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const headers = { Authorization: subject.auth };
      const routes = [
        "/api/v1/authz/policy/reconcile",
        "/api/v1/authz/policy/reconcile?repair=true",
        "/api/v1/authz/policy/sync",
      ];

      for (const route of routes) {
        const response = await request.post(route, { headers, data: {} });
        expect(response.status(), `${route} as a role-less subject`).toBe(403);
        // A FOURTH guard message, distinct from the three separated in #1531.
        // Asserted exactly: one message reused across two gates collapses them
        // for every client that reads the refusal.
        expect(((await response.json()) as { detail: string }).detail).toBe(
          "Superuser required for authz admin endpoints",
        );
      }
    },
  );
});
