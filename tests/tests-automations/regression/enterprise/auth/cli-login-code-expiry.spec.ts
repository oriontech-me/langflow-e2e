import { expect, test } from "../../../../fixtures/fixtures";
import {
  authorizeCliLogin,
  exchangeCliCode,
} from "../../../../helpers/enterprise/cli-login";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";

/**
 * The one property `cli-login-pkce` left open: an authorization code EXPIRES.
 *
 * The TTL is 120 seconds by default (EE `auth/cli_login.py`, capped at 300,
 * overridable through `LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS` with a floor of one
 * second). No special container is needed — the cost is about two minutes of
 * waiting, which is the entire reason this stayed uncovered.
 *
 * THE PROPERTY IS INDISTINGUISHABILITY, not the word "expired". The § 22.3 line
 * this closes said the refusal names expiry, and it does — as one of three
 * possibilities. An expired code, a code that was never issued, and a code
 * already spent all answer `400` with the identical body:
 *
 *   {"detail": "Invalid, expired, or already used CLI authorization code"}
 *
 * That is correct: an attacker holding a candidate learns nothing about WHY it
 * failed, so the endpoint is not an oracle separating "never existed" from
 * "lapsed" from "already used". Splitting those into distinct messages — the sort
 * of change that reads as better developer experience — would hand out exactly
 * that oracle, and nothing else in the suite would notice. So both halves are
 * asserted in one test: the refusal, AND that it is byte-identical to the
 * unknown-code refusal. Either alone is satisfied by the wrong behaviour.
 */

/** Measured default. Overridden by the instance's own setting when present. */
const DEFAULT_TTL_SECONDS = 120;

function configuredTtlSeconds(): number {
  const raw = Number(process.env.LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 300 ? raw : DEFAULT_TTL_SECONDS;
}

test.describe("Enterprise — an expired CLI authorization code", () => {
  test(
    "an expired code is refused, and indistinguishably from one that never existed",
    { tag: ["@enterprise", "@api", "@regression", "@auth"] },
    async ({ request }) => {
      const ttl = configuredTtlSeconds();
      // The wait dominates; the suite default is five minutes and the TTL alone
      // can be two. Set LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS on the instance to
      // make this finish in seconds.
      test.setTimeout((ttl + 90) * 1000);

      const auth = await getEnterpriseAuthToken(request);

      await test.step("the control: a fresh code exchanges successfully", async () => {
        const authorization = await authorizeCliLogin(request, auth, {
          state: "expiry-control",
        });
        const exchanged = await exchangeCliCode(request, auth, authorization);
        // Without this, the refusal below would be equally consistent with "the
        // CLI flow does not work on this instance at all".
        expect(exchanged.status(), await exchanged.text()).toBe(200);
        expect(((await exchanged.json()) as { access_token: string }).access_token)
          .toBeTruthy();
      });

      const unknownBody = await test.step("a code that was never issued is refused", async () => {
        const authorization = await authorizeCliLogin(request, auth, {
          state: "expiry-unknown",
        });
        const refused = await exchangeCliCode(request, auth, authorization, {
          code: "this-code-was-never-issued",
        });
        expect(refused.status()).toBe(400);
        return await refused.text();
      });

      await test.step(`a real code exchanged after its ${ttl}s TTL is refused the same way`, async () => {
        const authorization = await authorizeCliLogin(request, auth, {
          state: "expiry-lapsed",
        });

        // Clock-based on purpose. The code does not change state and nothing can
        // be polled: its lapse is defined by wall time, and an `expect.poll`
        // would pass on the FIRST failed exchange — including one that failed
        // for an unrelated reason.
        await new Promise((resolve) =>
          setTimeout(resolve, (ttl + 6) * 1000),
        );

        const refused = await exchangeCliCode(request, auth, authorization);
        expect(refused.status()).toBe(400);
        // The security half: identical, so the endpoint cannot be used to tell
        // a lapsed code from one that never existed.
        expect(await refused.text()).toBe(unknownBody);
      });
    },
  );
});
