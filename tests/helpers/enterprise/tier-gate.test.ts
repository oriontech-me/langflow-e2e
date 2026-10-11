import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertNotTierGated,
  LICENCE_UNAVAILABLE_DETAIL,
  TIER_GATE_FLAG,
  tierGateCause,
} from "./tier-gate";

const GATED_BODY = JSON.stringify({ detail: LICENCE_UNAVAILABLE_DETAIL });

describe("tierGateCause", () => {
  it("names the flag for the licence 503", () => {
    const cause = tierGateCause(503, GATED_BODY);
    assert.ok(cause, "a licence 503 must be classified");
    assert.match(cause, new RegExp(TIER_GATE_FLAG));
  });

  it("leaves every other 503 alone", () => {
    // A wedged backend, an unconfigured Control Plane and the tier module's own
    // counting failure all answer 503 too — none of them is fixed by the flag.
    for (const detail of [
      "Tier limit enforcement is unavailable",
      "Control Plane deployment is not configured",
      "Service Unavailable",
    ]) {
      assert.equal(tierGateCause(503, JSON.stringify({ detail })), undefined, detail);
    }
    assert.equal(tierGateCause(503, ""), undefined);
  });

  it("only classifies a 503, whatever the body says", () => {
    // The SSO entitlement routes reuse the same detail on purpose; a non-503 that
    // quotes it is still not the tier gate refusing this request.
    for (const status of [200, 201, 400, 403, 409, 500]) {
      assert.equal(tierGateCause(status, GATED_BODY), undefined, String(status));
    }
  });
});

describe("assertNotTierGated", () => {
  it("throws a named error for the licence 503", () => {
    assert.throws(
      () => assertNotTierGated("POST /api/v1/users/", 503, GATED_BODY),
      (error: Error) =>
        error.message.startsWith("POST /api/v1/users/ answered 503.") &&
        error.message.includes(TIER_GATE_FLAG),
    );
  });

  it("returns for anything else, so the caller's own assertion still runs", () => {
    assert.doesNotThrow(() => assertNotTierGated("POST /api/v1/users/", 201, "{}"));
    assert.doesNotThrow(() =>
      assertNotTierGated("POST /api/v1/users/", 503, '{"detail":"Service Unavailable"}'),
    );
  });
});
