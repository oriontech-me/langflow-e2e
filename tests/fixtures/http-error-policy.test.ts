// Unit tests for the base fixture's HTTP-error classification (#1084).
// Run with: npm run test:units
//
// Why these exist: the classification used to live inside `fixtures.ts`, where it
// only ran in a live browser session — so "does the monitor see a 403?" could be
// answered only by running the suite and reading a terminal. It did not, for two
// years, while `CLAUDE.md` advertised 4xx/5xx coverage. Every URL/status pair
// below was observed against Langflow Nightly 1.12.0.dev9 while resolving #1084.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHttpError } from "./http-error-policy";

const BASE = "http://localhost:7860";

test("the four codes the old filter matched are still monitored", () => {
  for (const status of [400, 404, 422, 500]) {
    assert.equal(
      classifyHttpError({ url: `${BASE}/api/v1/flows/`, status }).monitored,
      true,
      `${status} must stay monitored — widening the filter must not drop coverage`,
    );
  }
});

test("the codes the old filter missed are now monitored", () => {
  // Each of these was measured invisible before the fix:
  //   405 — an in-page `DELETE /api/v1/version` (probe C)
  //   403 — `GET /api/v1/flows/` with no credentials, the shape seen under
  //         contention in #773 and the #1052 review
  //   502/503 — a wedged or restarting backend (#1030/#1048), and the 503 the
  //         `execution-error-notification` spec mocks on purpose
  const cases: Array<[number, string]> = [
    [401, "/api/v1/flows/"],
    [403, "/api/v1/flows/"],
    [405, "/api/v1/version"],
    [409, "/api/v1/mcp/servers"],
    [502, "/api/v1/flows/"],
    [503, "/api/v2/workflows"],
    [504, "/api/v1/build/abc"],
  ];
  for (const [status, path] of cases) {
    assert.equal(
      classifyHttpError({ url: `${BASE}${path}`, status }).monitored,
      true,
      `${status} ${path} must be monitored — "4xx/5xx" is what the docs promise`,
    );
  }
});

test("a successful or redirect response is never an error", () => {
  for (const status of [200, 201, 204, 302, 304, 399]) {
    const verdict = classifyHttpError({ url: `${BASE}/api/v1/flows/`, status });
    assert.equal(verdict.monitored, false);
  }
});

test("auth endpoints stay ignored, including the ones specs mock into 500", () => {
  // Real routes from the suite: `login-invalid-credentials`, `session-expired`,
  // `logout-flow`, `admin-password-change` and
  // `general-bugs-component-webhook-api-key-display` all fulfil these with 500
  // deliberately. Reporting those would be reporting the test's own fixture.
  for (const path of [
    "/api/v1/login",
    "/api/v1/auto_login",
    "/api/v1/refresh",
    "/api/v1/logout",
  ]) {
    const verdict = classifyHttpError({ url: `${BASE}${path}`, status: 500 });
    assert.equal(verdict.monitored, false, `${path} must stay ignored`);
    assert.match(
      verdict.monitored === false ? verdict.ignoreReason : "",
      /auth endpoint/,
    );
  }
});

test("the external Langflow Store is ignored, with the reason recorded", () => {
  // The concrete trigger for #1084: a container with no outbound DNS answers
  // `500 [Errno -2] Name or service not known`, three times per test.
  const verdict = classifyHttpError({
    url: `${BASE}/api/v1/store/tags`,
    status: 500,
  });
  assert.equal(verdict.monitored, false);
  assert.match(
    verdict.monitored === false ? verdict.ignoreReason : "",
    /external/,
  );
  assert.equal(
    classifyHttpError({ url: `${BASE}/api/v1/store/components`, status: 500 })
      .monitored,
    false,
    "the whole Store prefix, not just /tags",
  );
});

test("the ambient DELETE /api/v1/flows/ 500 stays VISIBLE", () => {
  // Measured twice in one 48-test run, in two unrelated specs, both green. It is
  // a real Langflow 500 on bulk delete, not an environmental artefact, so the
  // one thing it must not become is an allowlist entry — this test is here to
  // fail if someone silences it to quieten the log.
  assert.equal(
    classifyHttpError({ url: `${BASE}/api/v1/flows/`, status: 500 }).monitored,
    true,
  );
});

test("non-API traffic is ignored", () => {
  for (const url of [
    `${BASE}/assets/index-CSJ7TV2F.js`,
    `${BASE}/favicon.ico`,
    "https://cdn.example.com/font.woff2",
  ]) {
    const verdict = classifyHttpError({ url, status: 404 });
    assert.equal(verdict.monitored, false, `${url} must be ignored`);
  }
});

test("an unparseable URL is ignored instead of throwing", () => {
  // This runs inside a `page.on("response")` handler: a throw there would break
  // the very test the monitor is supposed to be observing.
  assert.doesNotThrow(() =>
    classifyHttpError({ url: "not-a-url", status: 500 }),
  );
  const verdict = classifyHttpError({ url: "not-a-url", status: 500 });
  assert.equal(verdict.monitored, false);
  assert.match(
    verdict.monitored === false ? verdict.ignoreReason : "",
    /unparseable URL/,
  );
});

test("every ignore verdict carries a reason", () => {
  const ignored = [
    { url: `${BASE}/api/v1/flows/`, status: 200 },
    { url: `${BASE}/api/v1/login`, status: 401 },
    { url: `${BASE}/api/v1/store/tags`, status: 500 },
    { url: `${BASE}/favicon.ico`, status: 404 },
    { url: "://broken", status: 500 },
  ];
  for (const facts of ignored) {
    const verdict = classifyHttpError(facts);
    assert.equal(verdict.monitored, false, `${facts.url} ${facts.status}`);
    assert.ok(
      verdict.monitored === false && verdict.ignoreReason.length > 0,
      `an ignore without a reason cannot be reviewed: ${facts.url}`,
    );
  }
});
