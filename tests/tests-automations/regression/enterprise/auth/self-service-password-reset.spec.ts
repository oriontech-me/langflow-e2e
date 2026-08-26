import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  cleanupRbacUser,
  createRbacUser,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The OTHER password-change path.
 *
 * `credential-lifecycle` covers the forced rotation — the gate that holds a
 * bootstrapped superuser, the minimum it enforces, and the token it invalidates.
 * `PATCH /api/v1/users/{user_id}/reset-password` is the path a user calls for
 * themselves, and nothing covered it. It is OSS (`langflow/api/v1/users.py`),
 * unchanged by Enterprise, and it makes exactly THREE refusals: a wrong current
 * password, the current password offered as the new one, and a reset aimed at
 * somebody else. All three are asserted here.
 *
 * Two things are measured and asserted in NEITHER direction, because pinning
 * either would settle a product question by assertion.
 *
 * The first is the absent length minimum. This route accepts a ONE-CHARACTER
 * password with 200 while the forced path declares `minLength: 8`, and that was
 * filed as a defect (#1558) on the reading that the minimum had been added to one
 * model and not the other. The product's own source refutes that reading: EE's
 * `ForcePasswordChangeRequest` carries a comment stating the floor is deliberate
 * and scoped to that flow, "not inherited from an existing convention", and
 * recording that OSS's reset-password "validates nothing beyond 'differs from the
 * current password'". It is the only password minimum in the Enterprise tree, and
 * a THIRD path has none either — the CLI `langflow admin reset-password` refuses
 * only an EMPTY password. The spec doc carries the measurement, including the
 * part worth putting to the product rather than asserting: the declared rationale
 * names an admin/break-glass recovery flow, and the CLI IS that flow.
 *
 * The second is token lifetime. The forced rotation invalidates the token that
 * performed it; this path does not. Keeping the current session alive while
 * revoking others is a legitimate product choice, so the assertion below states
 * only what is true today and is never the reason a build fails.
 *
 * The target of the cross-user attempt is a second throwaway account, never the
 * superuser. An earlier version of this measurement aimed it at the lane's own
 * principal: the product refused, but a test that has to be right about the
 * product in order to be safe is the wrong shape.
 */

const RESET_PATH = (id: string) => `/api/v1/users/${id}/reset-password`;

test.describe("Enterprise — the self-service password reset", () => {
  let superuserAuth: string;
  /** The acting user — the only login this spec spends. */
  let actor: RbacUser;
  /** The reset target. Never logs in until the final check. */
  let target: { id: string; username: string; password: string };

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    actor = await createRbacUser(request, superuserAuth, "self-reset-actor");

    const password = "ResetTarget123!";
    const username = `self-reset-target-${Date.now()}`;
    const created = await request.post("/api/v1/users/", {
      headers: { Authorization: superuserAuth },
      data: { username, password },
    });
    expect(created.status(), await created.text()).toBe(201);
    target = {
      id: ((await created.json()) as { id: string }).id,
      username,
      password,
    };
  });

  test.afterAll(async ({ request }) => {
    await cleanupRbacUser(request, superuserAuth, actor);
    await request
      .delete(`/api/v1/users/${target.id}`, {
        headers: { Authorization: superuserAuth },
      })
      .catch(() => undefined);
  });

  test(
    "changing your own password requires the current one, and the session survives it",
    { tag: ["@enterprise", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const headers = { Authorization: actor.auth };

      const wrong = await request.patch(RESET_PATH(actor.id), {
        headers,
        data: { current_password: "definitely-not-it", password: "Rotated123!" },
      });
      expect(wrong.status()).toBe(400);
      expect(((await wrong.json()) as { detail: string }).detail).toBe(
        "Current password is incorrect",
      );

      const changed = await request.patch(RESET_PATH(actor.id), {
        headers,
        data: { current_password: actor.password, password: "Rotated123!" },
      });
      expect(changed.status(), await changed.text()).toBe(200);
      actor.password = "Rotated123!";

      // Recorded, NOT asserted as correct: the forced rotation invalidates the
      // token that performed it and this path does not. Which of the two the
      // product means is #1558's open question, so this assertion states only
      // what is true today and would be updated with the answer — never used as
      // the reason a build fails.
      const stillValid = await request.get("/api/v1/users/whoami", { headers });
      expect(stillValid.status()).toBe(200);
    },
  );

  test(
    "the current password cannot be offered as the new one",
    { tag: ["@enterprise", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      // The route's only CONTENT rule, and the one nothing covered until
      // #1558's re-measurement — which is what replaced the minimum-length
      // assertion this test used to carry. Deliberately order-independent: it
      // reads `actor.password`, which `beforeAll` seeds and the test above keeps
      // in sync, so neither declaration order nor a worker split can change
      // what it measures.
      const reuse = await request.patch(RESET_PATH(actor.id), {
        headers: { Authorization: actor.auth },
        data: { current_password: actor.password, password: actor.password },
      });
      expect(reuse.status()).toBe(400);
      expect(((await reuse.json()) as { detail: string }).detail).toBe(
        "You can't use your current password",
      );
    },
  );

  test(
    "a user cannot reset another user's password, and the attempt leaves it untouched",
    { tag: ["@enterprise", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const attempt = await request.patch(RESET_PATH(target.id), {
        headers: { Authorization: actor.auth },
        // A VALID body: this route validates before it authorizes, so an
        // incomplete one answers 422 to anybody and would read as an open route.
        data: { current_password: actor.password, password: "Hijacked123!" },
      });
      // Absent rather than forbidden, the convention this instance uses — the
      // refusal does not confirm that the other account exists.
      expect(attempt.status()).toBe(404);
      expect(((await attempt.json()) as { detail: string }).detail).toBe(
        "You can't change another user's password",
      );

      // The half that makes the refusal complete rather than partially applied.
      // A 404 that had already written the new password would look identical
      // from the response alone.
      const login = await request.post("/api/v1/login", {
        form: { username: target.username, password: target.password },
      });
      expect(
        login.status(),
        "the target's original password still authenticates",
      ).toBe(200);
    },
  );
});
