import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  cleanupRbacUser,
  createRbacUser,
  readAuditLog,
  requireRbacInstance,
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

      const user = await createRbacUser(request, auth, "rbac-lifecycle");
      const roles = await builtinRoleIds(request, auth);
      const deniedName = `rbac-denied-${Date.now()}`;
      const allowedName = `rbac-allowed-${Date.now()}`;
      const assignments: string[] = [];
      let flowId: string | undefined;

      try {
        await test.step("with no role, the write is refused", async () => {
          const attempt = await request.post("/api/v1/flows/", {
            headers: { Authorization: user.auth },
            data: scratchFlow(deniedName),
          });
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

          const after = await request.post("/api/v1/flows/", {
            headers: { Authorization: user.auth },
            data: scratchFlow(allowedName),
          });
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
        await cleanupRbacUser(request, auth, user, assignments);
      }
    },
  );
});
