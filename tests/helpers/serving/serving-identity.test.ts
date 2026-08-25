// Unit tests for the serving-identity configuration classifier.
// Run with: npm run test:units
//
// The classifier decides which of Langflow's four serving-identity
// configurations an instance is in, from two probe runs. It is the only thing
// standing between a spec and asserting a contract against the wrong container:
// the configuration is NOT readable through any API (`GET /api/v1/config`
// carries no `serving`/`end_user`/`trust` key — measured on 1.12.0.dev38), so
// behaviour is the only signal there is.
//
// Every case below is asserted on the STATE, never on the reason text, with one
// exception noted at the bottom: the reason has to carry both readings, because
// a guard that says "wrong container" without saying what it saw sends the
// reader back to re-run the probe by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyServingConfiguration,
  type ServingProbeReadings,
} from "./serving-identity";

const SESSION = "probe-session-1";
const IDENTITY = "probe-identity";

function readings(
  identified: ServingProbeReadings["identified"],
  anonymous: ServingProbeReadings["anonymous"],
): ServingProbeReadings {
  return { sentSessionId: SESSION, probeIdentity: IDENTITY, identified, anonymous };
}

const ok = (sessionId: string) => ({ status: 200, sessionId });
const refused = { status: 401, detailCode: "END_USER_IDENTITY_REQUIRED" };
const scoped = ok(`${IDENTITY}::${SESSION}`);
const verbatim = ok(SESSION);
const anon = ok("anon::5cc7904c-ba7a-4ee3-873e-df7cf68bbc72");

test("a header that changes nothing is the default configuration", () => {
  const { state } = classifyServingConfiguration(readings(verbatim, verbatim));
  assert.equal(state, "default");
});

test("a scoped identity plus an anonymised identity-less run is the trusted configuration", () => {
  const { state } = classifyServingConfiguration(readings(scoped, anon));
  assert.equal(state, "trusted");
});

test("an anonymised identified run is the untrusted configuration", () => {
  // Named but not trusted: the header is not honoured AND the request does not
  // fall back to the plain session either.
  const { state } = classifyServingConfiguration(readings(anon, anon));
  assert.equal(state, "untrusted");
});

test("a scoped identity plus a refused identity-less run is the required configuration", () => {
  const { state } = classifyServingConfiguration(readings(scoped, refused));
  assert.equal(state, "required");
});

test("the identified and identity-less readings are BOTH needed to separate trusted from required", () => {
  // The whole reason the probe costs two runs. An identified request is 200 and
  // scoped under trusted AND under required; only the identity-less run differs.
  // A classifier that read the identified run alone would answer the same for
  // both, and a `required` spec would then assert its 401s against a container
  // that never refuses anything.
  const trusted = classifyServingConfiguration(readings(scoped, anon)).state;
  const required = classifyServingConfiguration(readings(scoped, refused)).state;
  assert.notEqual(trusted, required);
});

test("an identity whose value is a prefix of the session is not read as scoped", () => {
  // `alice` sent against session `alice-1` reports `alice-1` verbatim on a
  // default instance. A substring or startsWith test would read that as scoped
  // and classify a stock instance as trusted — the exact inversion that makes a
  // guard worse than none.
  const r: ServingProbeReadings = {
    sentSessionId: "alice-1",
    probeIdentity: "alice",
    identified: ok("alice-1"),
    anonymous: ok("alice-1"),
  };
  assert.equal(classifyServingConfiguration(r).state, "default");
});

test("a scope belonging to a DIFFERENT identity is not a recognised configuration", () => {
  // Reading back someone else's scope is not a configuration, it is a leak.
  // Answering `trusted` here would let a spec proceed against it.
  const { state } = classifyServingConfiguration(readings(ok(`someone-else::${SESSION}`), anon));
  assert.equal(state, "unknown");
});

test("a refused identified run is not a recognised configuration", () => {
  // No specified configuration refuses an identified request. Under `required`
  // it is exactly the request that succeeds.
  const { state } = classifyServingConfiguration(readings(refused, refused));
  assert.equal(state, "unknown");
});

test("a scoped identity with an unscoped identity-less run is not a recognised configuration", () => {
  // Half-configured: the header is honoured but the identity-less path still
  // persists to the plain session. Not a row of the contract, so not a pass.
  const { state } = classifyServingConfiguration(readings(scoped, verbatim));
  assert.equal(state, "unknown");
});

test("an unscoped identity with a refused identity-less run is not a recognised configuration", () => {
  const { state } = classifyServingConfiguration(readings(verbatim, refused));
  assert.equal(state, "unknown");
});

test("a refusal without the contracted code is not the required configuration", () => {
  // A 401 from authentication is not a 401 from the identity guard, and treating
  // any 401 as `required` would classify an instance whose credentials expired.
  const { state } = classifyServingConfiguration(
    readings(scoped, { status: 401, detailCode: "AUTH_EXPIRED" }),
  );
  assert.equal(state, "unknown");
});

test("a reading with no session id at all is unknown rather than a crash", () => {
  // A non-JSON body, a 500, a shape change upstream: the classifier is the
  // guard's only decision point and must reach a verdict, never throw.
  const cases: ServingProbeReadings[] = [
    readings({ status: 200 }, { status: 200 }),
    readings({ status: 500 }, { status: 500 }),
    readings({ status: 200, sessionId: "" }, anon),
  ];
  for (const r of cases) {
    const { state } = classifyServingConfiguration(r);
    assert.equal(state, "unknown", `expected unknown for ${JSON.stringify(r)}`);
  }
});

test("the verdict never throws, for any pair of readings", () => {
  // Property, not an example: the classifier is called from a guard whose job is
  // to produce a NAMED failure. A throw there reports as an unattributed error
  // and costs the reader the diagnosis the guard exists to give (#1012).
  const values = [
    { status: 200, sessionId: SESSION },
    { status: 200, sessionId: `${IDENTITY}::${SESSION}` },
    { status: 200, sessionId: "anon::x" },
    { status: 200, sessionId: undefined },
    { status: 401, detailCode: "END_USER_IDENTITY_REQUIRED" },
    { status: 401 },
    { status: 500, sessionId: "" },
  ];
  for (const identified of values) {
    for (const anonymous of values) {
      assert.doesNotThrow(() => classifyServingConfiguration(readings(identified, anonymous)));
    }
  }
});

test("the reason names both readings, so a wrong container is diagnosable from the message", () => {
  // The one assertion on the text. Without both readings in it, the guard's
  // failure says "not the container this spec needs" and the reader has to
  // re-run the probe by hand to learn which one it is.
  const { reason } = classifyServingConfiguration(readings(anon, refused));
  assert.match(reason, /anon::/);
  assert.match(reason, /401/);
});
