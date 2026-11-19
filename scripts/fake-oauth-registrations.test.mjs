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
// Four of the providers (Jira, Confluence, Salesforce, ServiceNow, #2498) are bound to a
// deployment site the operator names in its own server setting, and the server refuses
// their registration without it. Those four settings travel with the registrations:
// canonical copy scripts/lib/fake-integration-sites.json, carried by the same lanes and
// starters, and pinned below the same way.
//
// One value, eight copies. The canonical one is scripts/lib/fake-oauth-registrations.json.
// The three workflows carry it in their Langflow service env, which starts before any
// checkout and so cannot read a file; the five starters carry it inlined, because the
// VM lane pipes a starter to `bash -s` on the target, where no file of this repo
// exists (the instance-migration starter is never piped, and inlines it for parity). A copy that drifted would configure a different instance per lane, so every
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
const SITES_PATH = "scripts/lib/fake-integration-sites.json";
const sites = JSON.parse(read(SITES_PATH));

// The site each site-bound provider reads, and the scope set its OAuth adapter demands.
// Mirrored from the adapters' validate_registration (services/triggers/providers/<p>/oauth.py)
// and the bundles' schema.py on release-1.14.0, and measured on 1.14.0.dev29: a registration
// that misses either is OMITTED from GET /oauth/registrations, never reported.
const SITE_BOUND = {
  jira: {
    site: "LANGFLOW_JIRA_CLOUD_ID",
    scopes: { exactly: ["offline_access", "read:jira-user", "read:jira-work", "write:jira-work"] },
  },
  confluence: {
    site: "LANGFLOW_CONFLUENCE_CLOUD_ID",
    scopes: { exactly: ["offline_access", "read:confluence-user", "read:page:confluence", "write:page:confluence"] },
  },
  salesforce: { site: "LANGFLOW_SALESFORCE_ORIGIN", scopes: { exactly: ["api", "id", "refresh_token"] } },
  // ServiceNow accepts a subset of these two, as long as the read scope is in it.
  servicenow: {
    site: "LANGFLOW_SERVICENOW_ORIGIN",
    scopes: { within: ["langflow_table_read", "langflow_table_write"], including: "langflow_table_read" },
  },
};

// Every workflow that starts a Langflow service for a spec run — the same list
// a2a-flag-lanes.test.mjs keeps, for the same reason.
const LANES = ["daily-stable.yml", "manual.yml", "pr-validation.yml"];
// Every starter whose environment block is meant to match the lanes'.
// start-langflow-enterprise.sh is deliberately absent: it does not mirror that block
// (it carries no A2A flag either), and the Enterprise lane has its own surface.
const STARTERS = {
  "scripts/start-langflow-docker.sh": "docker",
  "scripts/start-langflow-serving-identity.sh": "docker",
  "scripts/start-langflow-instance-migration.sh": "docker",
  "scripts/start-langflow-pip.sh": "prefix",
  "scripts/start-langflow-source.sh": "prefix",
};

test("the canonical file holds one fake registration per provider and Slack profile", () => {
  assert.deepEqual(
    Object.entries(canonical)
      .map(([, r]) => `${r.provider}:${r.profile ?? "user"}`)
      .sort(),
    [
      "confluence:user",
      "google:user",
      "jira:user",
      "microsoft:user",
      "salesforce:user",
      "servicenow:user",
      "slack:bot",
      "slack:user",
    ],
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
    assert.ok(
      ["google", "microsoft", "slack", ...Object.keys(SITE_BOUND)].includes(r.provider),
      `${id}: unknown provider ${r.provider}`,
    );
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
    const bound = SITE_BOUND[r.provider];
    if (bound) {
      // The adapters accept only the user profile on a confidential, self-managed client.
      assert.equal(r.profile ?? "user", "user", `${id}: a site-bound provider has only the user profile`);
      // The registration's tenant must be the site the server names, character for character.
      assert.equal(r.tenant, sites[bound.site], `${id}: tenant is not ${bound.site} (${SITES_PATH})`);
      const { exactly, within, including } = bound.scopes;
      if (exactly) assert.deepEqual([...r.scopes].sort(), [...exactly].sort(), `${id}: the adapter demands exactly these scopes`);
      if (within) {
        for (const scope of r.scopes) assert.ok(within.includes(scope), `${id}: scope ${scope} is outside ${within}`);
        assert.ok(r.scopes.includes(including), `${id}: ${including} is required`);
      }
    }
  }
});

test("every site-bound provider has exactly one registration, and every site is used", () => {
  const providers = Object.values(canonical).map((r) => r.provider);
  for (const provider of Object.keys(SITE_BOUND)) {
    assert.equal(providers.filter((p) => p === provider).length, 1, `${provider}: expected one registration`);
  }
  assert.deepEqual(Object.keys(sites).sort(), Object.values(SITE_BOUND).map((b) => b.site).sort());
});

test("each fake site is a value the server accepts, and visibly fake", () => {
  // The bundles' own readers (lfx_<provider>/schema.py): a value they refuse is the same as
  // no site at all — the registration is dropped and nothing says so.
  const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(sites.LANGFLOW_JIRA_CLOUD_ID, canonicalUuid, "Jira wants a canonical lowercase UUID");
  assert.match(sites.LANGFLOW_CONFLUENCE_CLOUD_ID, canonicalUuid, "Confluence wants a canonical lowercase UUID");
  const salesforceHost =
    /^[a-z0-9][a-z0-9-]*(?:--[a-z0-9-]+)?\.(?:(?:demo|develop|patch|sandbox|scratch|trailblaze)\.)?my\.salesforce\.com$/;
  const serviceNowHost = /^[a-z0-9][a-z0-9-]*\.service-now\.com$/;
  for (const [name, host] of [
    ["LANGFLOW_SALESFORCE_ORIGIN", salesforceHost],
    ["LANGFLOW_SERVICENOW_ORIGIN", serviceNowHost],
  ]) {
    const url = new URL(sites[name]);
    assert.equal(url.protocol, "https:", `${name}: HTTPS only`);
    assert.match(url.hostname, host, `${name}: host`);
    // An origin, exactly: no port, path, query or fragment, and no trailing slash, since the
    // registration's tenant is compared with the origin the server rebuilds from the host.
    assert.equal(sites[name], `https://${url.hostname}`, `${name}: not a bare origin`);
  }
  for (const [name, value] of Object.entries(sites)) assert.match(value, /e2e/, `${name}: does not look fake`);
  for (const value of Object.values(sites)) assert.doesNotMatch(value, /['"\s$`\\{}]/);
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

for (const lane of LANES) {
  test(`${lane} names the deployment site of every site-bound provider on its Langflow service`, () => {
    const env = readServiceEnv(read(`.github/workflows/${lane}`));
    for (const [name, value] of Object.entries(sites)) {
      assert.ok(env.has(name), `${lane}: the Langflow service does not set ${name}`);
      assert.equal(evaluateWorkflowValue(env.get(name), {}), value, `${lane}: ${name} drifted from ${SITES_PATH}`);
    }
  });
}

for (const [starter, shape] of Object.entries(STARTERS)) {
  test(`${starter} passes the deployment sites, overridable`, () => {
    const lines = stripComments(read(starter)).split("\n");
    for (const [name, value] of Object.entries(sites)) {
      const passed = `${name}="\${${name}:-${value}}" \\`;
      const line = shape === "docker" ? `  -e ${passed}` : passed;
      assert.ok(lines.includes(line), `${starter}: the launch does not pass ${name} as \`${line}\``);
    }
  });

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
