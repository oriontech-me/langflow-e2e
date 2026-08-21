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
 * themselves, and nothing covered it. Two paths onto one credential is how a
 * policy ends up applying to one of them, and here it does: the forced path
 * declares `new_password` with `minLength: 8` and enforces it, while this one
 * declares no minimum and accepts a ONE-CHARACTER password (#1558).
 *
 * The behaviours it gets right are asserted alongside, so a fix cannot regress
 * them: proof of possession, and a cross-user attempt that is refused AND leaves
 * the target's credential untouched.
 *
 * One asymmetry is deliberately asserted in NEITHER direction. The forced
 * rotation invalidates the token that performed it; this path does not. Keeping
 * the current session alive while revoking others is a legitimate product choice,
 * so pinning today's answer would settle a product question by assertion — and
 * asserting the opposite would fail a build that never claimed otherwise. It is
 * recorded in #1558 and in the spec doc.
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
    "the minimum length applies here as it does to the forced rotation",
    { tag: ["@enterprise", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      // EXPECTED RED (#1558). `account/force-password-change` declares
      // `minLength: 8` and refuses anything shorter; this route declares no
      // minimum and answers 200, leaving the account on a one-character
      // password. Any user can downgrade their own credential below the policy
      // every bootstrapped account is put through.
      const tooShort = await request.patch(RESET_PATH(actor.id), {
        headers: { Authorization: actor.auth },
        data: { current_password: actor.password, password: "x" },
      });
      expect(tooShort.status()).toBeGreaterThanOrEqual(400);

      // Leave the account usable whatever the answer was, so the ordering of
      // these two tests cannot change what the other one measures.
      if (tooShort.ok()) {
        const restore = await request.patch(RESET_PATH(actor.id), {
          headers: { Authorization: actor.auth },
          data: { current_password: "x", password: actor.password },
        });
        expect(restore.status(), await restore.text()).toBe(200);
      }
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
