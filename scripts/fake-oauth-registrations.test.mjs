// The fake OAuth registrations every lane configures (issue #2301).
// Run with: npm run test:scripts
//
// The product ships no OAuth registration, so the Add/Reconnect wizard stops before
// consent and every OAuth route goes unexercised. `oauth/start` calls no provider and
// a denied callback needs none, so a fake client id with a loopback redirect reaches
// every path short of a real consent — measured on 1.14.0.dev2 for all four entries.
// The specs built on it FAIL, not skip, against an instance without them, so a lane
// that loses the variable goes red instead of passing while testing nothing (#1010).
//
// One value, seven copies. The canonical one is scripts/lib/fake-oauth-registrations.json.
// The three workflows carry it in their Langflow service env, which starts before any
// checkout and so cannot read a file; the four starters carry it inlined, because the
// VM lane pipes a starter to `bash -s` on the target, where no file of this repo
// exists. A copy that drifted would configure a different instance per lane, so every
// copy is pinned here byte for byte. That the inlined copies ARRIVE whole is proven by
// executing the starters (start-langflow-docker.test.mjs, start-langflow-source.test.mjs)
// and, for the VM lane's comparison with the daily, by scripts/check-vm-env-parity.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWorkflowValue } from "./lib/gh-expression.mjs";
import { readServiceEnv, stripComments } from "./lib/vm-env-parity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const VAR = "LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS";
const CANONICAL_PATH = "scripts/lib/fake-oauth-registrations.json";

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");
const canonical = JSON.parse(read(CANONICAL_PATH));
const compact = JSON.stringify(canonical);

// Every workflow that starts a Langflow service for a spec run — the same list
// a2a-flag-lanes.test.mjs keeps, for the same reason.
const LANES = ["daily-stable.yml", "manual.yml", "pr-validation.yml"];
// Every starter whose environment block is meant to match the lanes'.
// start-langflow-enterprise.sh is deliberately absent: it does not mirror that block
// (it carries no A2A flag either), and the Enterprise lane has its own surface.
const STARTERS = {
  "scripts/start-langflow-docker.sh": "docker",
  "scripts/start-langflow-serving-identity.sh": "docker",
  "scripts/start-langflow-pip.sh": "prefix",
  "scripts/start-langflow-source.sh": "prefix",
};

test("the canonical file holds one fake registration per provider and Slack profile", () => {
  assert.deepEqual(
    Object.entries(canonical)
      .map(([, r]) => `${r.provider}:${r.profile ?? "user"}`)
      .sort(),
    ["google:user", "microsoft:user", "slack:bot", "slack:user"],
  );
});

test("each registration passes the rules the server applies, so none is silently dropped", () => {
  // A registration the server refuses is not an error at startup: GET /oauth/registrations
  // OMITS it ("a picker must not offer consent that cannot start"). So a broken entry
  // reads as a smaller list, not a failure — these are the rules of
  // OAuthRegistration.validate_registration that this file can break.
  for (const [id, r] of Object.entries(canonical)) {
    // OAuthStartRequest.registration_id's pattern — the id a start request must name.
    assert.match(id, /^[a-z0-9][a-z0-9_-]*$/, `${id}: not a registration id oauth/start accepts`);
    assert.ok(["google", "microsoft", "slack"].includes(r.provider), `${id}: unknown provider ${r.provider}`);
    // Loopback HTTP at the provider's exact callback path. No port, deliberately: the
    // redirect is never followed (no real provider accepts the fake client), so one
    // value serves every lane whatever port its instance listens on.
    assert.equal(r.redirect_uri, `http://localhost/api/v1/connections/oauth/${r.provider}/callback`, id);
    // Confidential (the default) needs exactly one of a secret and a private key.
    assert.ok(r.client_secret && !r.private_key, `${id}: a confidential client needs a secret and no private key`);
    assert.ok(Array.isArray(r.scopes) && r.scopes.length > 0, `${id}: no scopes`);
    for (const scope of r.scopes) assert.doesNotMatch(scope, /[\s,]/, `${id}: scope "${scope}"`);
    assert.equal(new Set(r.scopes).size, r.scopes.length, `${id}: duplicate scope`);
    if (r.profile === "bot") assert.equal(r.provider, "slack", `${id}: only Slack has a bot profile`);
    if (r.provider === "microsoft") {
      assert.match(r.tenant ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `${id}: tenant`);
    }
  }
});

test("every client id and secret is visibly fake, because this repository is public", () => {
  // The day someone pastes a real registration here to "try consent", this fails.
  for (const [id, r] of Object.entries(canonical)) {
    assert.match(r.client_id, /e2e/, `${id}: client_id does not look fake`);
    assert.match(r.client_secret, /^e2e-fake-/, `${id}: client_secret does not look fake`);
  }
});

test("the compact value is safe inside a single-quoted shell literal and a YAML scalar", () => {
  // No single quote (it would end the literal) and no whitespace (docker's argument log
  // and the VM's ssh string would split on it).
  assert.doesNotMatch(compact, /['\s]/);
});

for (const lane of LANES) {
  test(`${lane} configures the canonical registrations on its Langflow service`, () => {
    const env = readServiceEnv(read(`.github/workflows/${lane}`));
    assert.ok(env.has(VAR), `${lane}: the Langflow service does not set ${VAR}`);
    assert.equal(evaluateWorkflowValue(env.get(VAR), {}), compact, `${lane}: the copy drifted from ${CANONICAL_PATH}`);
  });
}

for (const [starter, shape] of Object.entries(STARTERS)) {
  test(`${starter} inlines the canonical registrations and passes them, overridable`, () => {
    const text = stripComments(read(starter));
    const literals = [...text.matchAll(/^DEFAULT_OAUTH_REGISTRATIONS='([^']*)'$/gm)];
    assert.equal(literals.length, 1, `${starter}: expected one DEFAULT_OAUTH_REGISTRATIONS literal`);
    assert.equal(literals[0][1], compact, `${starter}: the copy drifted from ${CANONICAL_PATH}`);
    const passed = `${VAR}="\${${VAR}:-$DEFAULT_OAUTH_REGISTRATIONS}" \\`;
    const line = shape === "docker" ? `  -e ${passed}` : passed;
    assert.ok(text.split("\n").includes(line), `${starter}: the launch does not pass ${VAR} as \`${line}\``);
    // The VM lane pipes the starter to `bash -s`: a read of the canonical file would
    // find nothing there and the server would start with no registration.
    assert.doesNotMatch(text, /fake-oauth-registrations\.json/, `${starter}: reads the canonical file`);
  });
}
