import { expect, test } from "../../../../fixtures/fixtures";
import {
  EE_PASSWORD,
  EE_USERNAME,
  loginWithPassword,
} from "../../../../helpers/enterprise/enterprise-auth";

/**
 * What Enterprise does to a credential that OSS does not do at all (see
 * docs/enterprise/auth/credential-lifecycle.md).
 *
 * ONE-SHOT PER CONTAINER. The state under test — a superuser that has not yet
 * rotated — exists exactly once per instance, and this spec consumes it. An
 * admin cannot recreate it for a throwaway user either: resetting someone
 * else's password is refused. So the spec asserts what is reachable once,
 * honestly, and skips afterwards rather than pretending to be repeatable.
 *
 * It also leaves the instance on the lane's password, which is the state every
 * other `@enterprise` spec expects — running this one first sets the lane up.
 */
const BOOTSTRAP_PASSWORD = process.env.LANGFLOW_SUPERUSER_PASSWORD || "langflow123";

/**
 * Reachable while the rotation is pending: identity plus what a login screen
 * reads. A client that cannot discover the requirement cannot satisfy it, so
 * these staying open is a property, not a leak.
 */
const ALLOWED_WHILE_PENDING = [
  "/api/v1/users/whoami",
  "/api/v1/account/password-status",
  "/api/v1/auth/methods",
  "/api/v1/config",
];

/**
 * Refused while the rotation is pending. `api_key/` is the one that matters:
 * an account under a forced rotation must not be able to mint an API key and
 * walk around the gate.
 */
const BLOCKED_WHILE_PENDING = [
  "/api/v1/flows/",
  "/api/v1/projects/",
  "/api/v1/variables/",
  "/api/v1/all",
  "/api/v1/catalog-policy/components",
  "/api/v1/policy-bundle",
  "/api/v1/sso/settings",
  "/api/v1/api_key/",
];

test.describe.configure({ mode: "serial" });

test.describe("Enterprise — credential lifecycle", () => {
  let bootstrapToken: string;

  test(
    "the forced-rotation gate is an allowlist, not a blanket refusal",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      test.skip(
        BOOTSTRAP_PASSWORD === EE_PASSWORD,
        `The bootstrap and rotated passwords are identical ('${BOOTSTRAP_PASSWORD}'), so there is nothing to rotate to. ` +
          "Start the instance with LANGFLOW_EE_PASSWORD=langflow123 ./scripts/start-langflow-enterprise.sh and leave LANGFLOW_EE_PASSWORD unset here.",
      );

      // One of the two logins this spec is allowed to spend — and the first
      // signal of whether the state still exists. It is attempted directly
      // rather than through the throwing helper because a refused bootstrap
      // login IS the one-shot condition: on a container that already rotated,
      // that password is gone. Letting the helper throw here produced a red
      // reading "login failed", which is a statement about the environment and
      // not about the product.
      const login = await request.post("/api/v1/login", {
        form: { username: EE_USERNAME, password: BOOTSTRAP_PASSWORD },
      });

      test.skip(
        login.status() === 401,
        `The bootstrap password is no longer accepted, so ${EE_USERNAME} has already rotated on this instance. ` +
          "The state is reachable once per container — start a fresh one with: " +
          "LANGFLOW_EE_PASSWORD=langflow123 ./scripts/start-langflow-enterprise.sh",
      );

      // Not a skip: a 429 means the lane spent its per-IP login budget, which
      // hides the product behind an environment condition the run can fix by
      // waiting. Failing names it instead of reporting a green all-skip.
      expect(
        login.status(),
        "login was rate-limited (429) — this lane's budget is per IP; re-run after the window",
      ).not.toBe(429);
      expect(login.status()).toBe(200);
      bootstrapToken = `Bearer ${(await login.json()).access_token}`;

      const status = await request.get("/api/v1/account/password-status", {
        headers: { Authorization: bootstrapToken },
      });
      expect(status.status()).toBe(200);
      const pending = (await status.json()).must_change_password;

      test.skip(
        pending !== true,
        `${EE_USERNAME} has already rotated on this instance, and the state is reachable once per container. ` +
          "Start a fresh one with: LANGFLOW_EE_PASSWORD=langflow123 ./scripts/start-langflow-enterprise.sh",
      );

      await test.step("identity and discovery stay reachable", async () => {
        for (const path of ALLOWED_WHILE_PENDING) {
          const response = await request.get(path, {
            headers: { Authorization: bootstrapToken },
          });
          expect(response.status(), `${path} must stay reachable`).toBe(200);
        }
      });

      await test.step("product and admin surfaces are refused, api_key included", async () => {
        for (const path of BLOCKED_WHILE_PENDING) {
          const response = await request.get(path, {
            headers: { Authorization: bootstrapToken },
          });
          expect(response.status(), `${path} must be refused`).toBe(403);
          // The reason, not just the status: a 403 for any other cause would
          // satisfy the assertion above while meaning something else entirely.
          expect(await response.text()).toContain("must_change_password");
        }
      });
    },
  );

  test(
    "rotating requires the current password and a long enough new one",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      test.skip(!bootstrapToken, "the gate test did not run");
      const headers = { Authorization: bootstrapToken };

      await test.step("a wrong current password is refused", async () => {
        const response = await request.post("/api/v1/account/force-password-change", {
          headers,
          data: { current_password: `not-${BOOTSTRAP_PASSWORD}`, new_password: EE_PASSWORD },
        });
        expect(response.ok()).toBe(false);
      });

      await test.step("a new password below the minimum is refused", async () => {
        const response = await request.post("/api/v1/account/force-password-change", {
          headers,
          data: { current_password: BOOTSTRAP_PASSWORD, new_password: "short" },
        });
        expect(response.ok()).toBe(false);
      });

      await test.step("the correct rotation is accepted", async () => {
        const response = await request.post("/api/v1/account/force-password-change", {
          headers,
          data: { current_password: BOOTSTRAP_PASSWORD, new_password: EE_PASSWORD },
        });
        expect(response.status()).toBe(200);
      });
    },
  );

  test(
    "after rotating, the status agrees and the old token is dead",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      test.skip(!bootstrapToken, "the gate test did not run");

      await test.step("the token that performed the rotation is rejected", async () => {
        const response = await request.get("/api/v1/users/whoami", {
          headers: { Authorization: bootstrapToken },
        });
        expect(response.status()).toBe(401);
      });

      // The second and last login this spec spends.
      const rotatedToken = await loginWithPassword(request, EE_PASSWORD);

      await test.step("the status no longer reports a pending rotation", async () => {
        const status = await request.get("/api/v1/account/password-status", {
          headers: { Authorization: rotatedToken },
        });
        expect(status.status()).toBe(200);
        expect((await status.json()).must_change_password).toBe(false);
      });

      await test.step("a surface the gate refused now answers", async () => {
        const response = await request.get("/api/v1/api_key/", {
          headers: { Authorization: rotatedToken },
        });
        expect(response.status()).toBe(200);
      });
    },
  );
});
