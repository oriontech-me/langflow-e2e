import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  resetSubjectGrants,
  getSharedRbacSubject,
  readAuditLog,
  requireRbacInstance,
  attemptFlowCreate,
  getProjectOwnedBy,
} from "../../../../helpers/enterprise/rbac";

/**
 * The foundation spec for the RBAC area: it proves the INSTANCE VARIANT is what
 * it claims, so every later authorization test measures the product rather than
 * a misconfigured container.
 *
 * That is not a formality. An instance can report `authz_enabled: true` and
 * enforce nothing — with superuser bypass left on, the only account this lane
 * has is exempt from every check, and a whole deny matrix would pass against an
 * instance that never denied anything. The opposite miss is as easy: with the
 * RBAC bootstrap disabled the instance enforces against an empty assignment
 * table, denies everything including the superuser, and reads as a broken image
 * rather than a missing flag.
 *
 * Start it with `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh` — a
 * second container with its own Postgres, not a mode switch on the default one.
 *
 * TWO tests, and the shape is a budget decision rather than a stylistic one. EE
 * rate-limits `/api/v1/login` to five per minute per IP for the whole machine,
 * and every test user costs one. The first draft of this file created a user per
 * test; the second run inside a minute answered 429 and reported the limiter as
 * assertion failures, which is exactly the environment-red-wearing-product-red
 * clothing this lane is most exposed to. The lifecycle below is one user because
 * it IS one user's story — denied, granted, allowed, audited — not four
 * independent scenarios, so `test.step` gives the diagnosis a reader needs
 * without paying four logins for it.
 *
 * Deliberately NOT asserted here, and left to the deny-matrix spec this one
 * unblocks, so a foundation test cannot fail for a question it does not ask:
 * that `viewer` and no-role are indistinguishable for these calls (measured:
 * both 403, only `developer` flips them), and that the three refusal messages
 * differ by guard — `Permission denied`, `RBAC administrator role required`, and
 * `Superuser required to administer roles.`, that last meaning role
 * administration is gated on superuser rather than on the admin role.
 */

function scratchFlow(name: string) {
  return { name, description: "", data: { nodes: [], edges: [] } };
}

test.describe("Enterprise — the RBAC instance enforces, and a role changes the answer", () => {
  test(
    "the instance is configured to enforce, with bypass off and policy loaded",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const status = await requireRbacInstance(request, auth);

      // A rule count of zero would deny everything for a reason that has
      // nothing to do with any test written against this instance.
      expect(status.policy_rule_count ?? 0).toBeGreaterThan(0);
      expect(status.builtin_roles).toEqual(
        expect.arrayContaining(["viewer", "developer", "admin"]),
      );
      // The bootstrap ran: somebody holds a role, or the superuser itself would
      // be denied and every spec here would fail identically.
      expect(status.assignment_count ?? 0).toBeGreaterThan(0);
    },
  );

  test(
    "a role-less user is denied, granting a role allows the same call, and both are audited",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const user = await getSharedRbacSubject(request, auth);
      const foreignProjectId = await getProjectOwnedBy(request, auth);
      const roles = await builtinRoleIds(request, auth);
      const deniedName = `rbac-denied-${Date.now()}`;
      const allowedName = `rbac-allowed-${Date.now()}`;
      const assignments: string[] = [];
      let flowId: string | undefined;

      try {
        await test.step("with no role, the write is refused", async () => {
          // Into a project the subject does not own. Since the 2026-08-27 build
          // a bare create lands in the caller's OWN project, where the owner
          // override allows it for anybody — so the bare call stopped asking
          // this question at all (#1635). The override itself is asserted by the
          // sibling test below; this one is about the guard.
          const attempt = await attemptFlowCreate(
            request,
            user.auth,
            deniedName,
            foreignProjectId,
          );
          expect(attempt.status()).toBe(403);
        });

        await test.step("and the refusal left nothing behind", async () => {
          // The assertion that makes the 403 mean something. A refusal that
          // still created the resource is not an authorization control, and
          // nothing else in the suite would catch it — the caller sees the same
          // status either way. Read as the superuser, because the user who was
          // denied could not see their own resource regardless.
          const flows = await request.get("/api/v1/flows/", {
            headers: { Authorization: auth },
          });
          expect(flows.status()).toBe(200);
          const names = ((await flows.json()) as { name: string }[]).map(
            (flow) => flow.name,
          );
          expect(names).not.toContain(deniedName);
        });

        await test.step("granting developer flips the identical call to allowed", async () => {
          // The load-bearing pair. On its own a 403 is equally consistent with
          // "authorization works" and "this instance is broken"; only the flip
          // separates them, and it does so through the product's own mechanism
          // rather than a second observation.
          assignments.push(
            await assignRole(request, auth, user.id, roles.developer),
          );

          // The IDENTICAL call — same target project, not merely the same verb.
          // Repeating it against the subject's own project instead would be
          // answered by the owner override, which grants without consulting the
          // role, and the pair would no longer be about the role at all.
          const after = await attemptFlowCreate(
            request,
            user.auth,
            allowedName,
            foreignProjectId,
          );
          expect(after.status(), await after.text()).toBe(201);
          flowId = ((await after.json()) as { id: string }).id;
        });

        await test.step("the audit log carries both decisions for this actor", async () => {
          const mine = (await readAuditLog(request, auth)).filter(
            (entry) => entry.actor_id === user.id && entry.action === "flow:create",
          );
          // Asserted on a non-empty set first: `arrayContaining` over an empty
          // array does fail, but it fails saying nothing about why, and "the
          // filter matched nothing" and "the log recorded one outcome" are
          // different defects.
          expect(mine.length).toBeGreaterThanOrEqual(2);
          // The deny is the entry an operator actually needs: an enforcement
          // decision nobody can review afterwards is not auditable.
          expect(mine.map((entry) => entry.result)).toEqual(
            expect.arrayContaining(["deny", "allow"]),
          );
        });
      } finally {
        if (flowId) {
          await request
            .delete(`/api/v1/flows/${flowId}`, { headers: { Authorization: auth } })
            .catch(() => undefined);
        }
        // Reset, never delete: the subject is shared across this directory and
        // cached between runs, so deleting it would cost a fresh login on the
        // next one — the cost sharing it exists to avoid.
        await resetSubjectGrants(request, auth, { assignments, shares: [] });
      }
    },
  );

  test(
    "the owner override is scoped: it covers a project you own and nothing else",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const user = await getSharedRbacSubject(request, auth);
      await resetSubjectGrants(request, auth, { assignments: [], shares: [] });

      const foreignProjectId = await getProjectOwnedBy(request, auth);
      const ownProjectId = await getProjectOwnedBy(request, user.auth);
      const ownName = `override-own-${Date.now()}`;
      const foreignName = `override-foreign-${Date.now()}`;
      let created: string | undefined;

      try {
        await test.step("into a project it owns, a role-less subject is allowed", async () => {
          // Since the 2026-08-27 build, `flow:create` carries an owner override:
          // owning the destination grants the write without a role. Asserted
          // because it is the behaviour, not because it is desirable — before
          // this test the override was reachable by every spec here and named by
          // none of them, so a build that widened it would have looked like a
          // suite that had always passed (#1635).
          const response = await attemptFlowCreate(
            request,
            user.auth,
            ownName,
            ownProjectId,
          );
          expect(response.status(), await response.text()).toBe(201);
          created = ((await response.json()) as { id: string }).id;
        });

        await test.step("into a project it does not own, the same subject is refused", async () => {
          // THE assertion. Without it "role-less can create flows" is
          // indistinguishable from "authorization is off", and the override
          // would be a hole rather than a rule.
          const response = await attemptFlowCreate(
            request,
            user.auth,
            foreignName,
            foreignProjectId,
          );
          expect(response.status()).toBe(403);
          expect(((await response.json()) as { detail: string }).detail).toBe(
            "Permission denied",
          );
        });

        await test.step("and the log distinguishes the two by verdict, not by status", async () => {
          // `owner_override` is a THIRD verdict, not a flavour of `allow`. An
          // operator reviewing who may write where needs to see which rule
          // answered; folding it into `allow` would hide the override entirely,
          // and folding it into `deny` would misreport a permitted write.
          // Keyed on the DESTINATION, not merely on the actor and the action.
          // The looser version passed against a mutation that swapped
          // `owner_override` for `allow`, because a sibling test in this file
          // produces an `allow` for the same actor and `arrayContaining` found
          // it. Scoping each verdict to the project it was reached in is both
          // immune to that and a stronger statement: the same subject, the same
          // action, two destinations, two verdicts.
          const mine = (await readAuditLog(request, auth)).filter(
            (entry) => entry.actor_id === user.id && entry.action === "flow:create",
          );
          const verdictFor = (projectId: string) =>
            mine.find((entry) => entry.details?.domain === `project:${projectId}`)?.result;

          expect(
            verdictFor(ownProjectId),
            "no audit entry for the write into the subject's own project",
          ).toBe("owner_override");
          expect(
            verdictFor(foreignProjectId),
            "no audit entry for the write into the project it does not own",
          ).toBe("deny");
        });
      } finally {
        if (created) {
          await request
            .delete(`/api/v1/flows/${created}`, { headers: { Authorization: auth } })
            .catch(() => undefined);
        }
      }
    },
  );
});
