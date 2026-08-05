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
import {
  classifyHttpError,
  type KnownHttpDefect,
} from "./http-error-policy";

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

// ---------------------------------------------------------------------------
// Per-test declared known defects (#1008)
// ---------------------------------------------------------------------------
//
// The narrow alternative to `page.allowHttpErrors()`. Every case below guards a
// way this could quietly become the blunt hatch it exists to avoid: a declaration
// that widens past the one response it names is the same class of mistake as an
// `IGNORED` entry added because something was noisy.

/** The real declaration made by `folder-deletion-integrity.spec.ts`, test 4. */
const PROJECTS_UNDEFINED: KnownHttpDefect = {
  pathname: "/api/v1/projects/undefined",
  status: 422,
  reason: "#1008 — frontend queries the flows page with an undefined project id",
};

test("a declared defect is not reported, and carries the declaration back", () => {
  const verdict = classifyHttpError(
    {
      // The real URL, query string and all: the match is on the pathname, so the
      // page/size/is_component params the frontend appends must not defeat it.
      url: `${BASE}/api/v1/projects/undefined?page=1&size=12&is_component=false&is_flow=true&search=`,
      status: 422,
    },
    [PROJECTS_UNDEFINED],
  );
  assert.equal(verdict.monitored, false);
  assert.equal(
    verdict.monitored === false && "knownDefect" in verdict
      ? verdict.knownDefect
      : undefined,
    PROJECTS_UNDEFINED,
    "the fixture needs the declaration itself back, to count the hit against it",
  );
});

test("a declaration narrows to its exact status and pathname", () => {
  // The whole value of declaring over `allowHttpErrors()`: everything else this
  // test could hit is still reported. A 500 on the SAME path especially — that
  // would be a new defect wearing the old one's URL.
  const stillReported: Array<[string, number, string]> = [
    ["/api/v1/projects/undefined", 500, "same path, different status"],
    ["/api/v1/projects/undefined", 404, "same path, different status"],
    [
      "/api/v1/projects/70af1547-0bd1-4799-be28-41f738b6e6dc",
      500,
      "the DELETE 500 of #965/LE-2020, which test 4's own delete loop can produce",
    ],
    ["/api/v1/flows/", 422, "same status, different path"],
    ["/api/v2/projects/undefined", 422, "a different API version"],
    ["/api/v1/projects/undefined/", 422, "a trailing slash is a different path"],
  ];
  for (const [pathname, status, why] of stillReported) {
    assert.equal(
      classifyHttpError({ url: `${BASE}${pathname}`, status }, [
        PROJECTS_UNDEFINED,
      ]).monitored,
      true,
      `${status} ${pathname} must still be reported — ${why}`,
    );
  }
});

test("declarations are consulted last: they cannot widen monitoring", () => {
  // Ordering matters. A declaration is only ever allowed to quieten something
  // this policy would otherwise report — never to pull a non-API URL, a 2xx or a
  // globally-exempt endpoint INTO the error list.
  const cases: Array<[string, number]> = [
    // Not an `/api/` call at all. Note the path really must not contain the
    // segment: the policy tests `pathname.includes("/api/")`, so a bundled asset
    // served from `/assets/api/…` would count as one — pre-existing #1084
    // behaviour, and the reason this case uses a plain asset path.
    ["/assets/index-CSJ7TV2F.js", 422],
    ["/api/v1/login", 401], // globally exempt
    ["/api/v1/store/tags", 500], // globally exempt
  ];
  for (const [pathname, status] of cases) {
    const verdict = classifyHttpError({ url: `${BASE}${pathname}`, status }, [
      { pathname, status, reason: "an attempt to un-ignore this response" },
    ]);
    assert.equal(verdict.monitored, false, `${status} ${pathname}`);
    assert.ok(
      verdict.monitored === false && !("knownDefect" in verdict),
      `${status} ${pathname} must be ignored for its OWN reason, not matched as a declared defect`,
    );
  }

  // A 2xx never reaches the declaration check either.
  const ok = classifyHttpError({ url: `${BASE}/api/v1/projects/x`, status: 200 }, [
    { pathname: "/api/v1/projects/x", status: 200, reason: "not an error" },
  ]);
  assert.ok(ok.monitored === false && !("knownDefect" in ok));
});

test("no declarations behaves exactly as before", () => {
  // The overwhelming majority of tests declare nothing, and the parameter is
  // optional — both spellings must classify identically.
  for (const facts of [
    { url: `${BASE}/api/v1/projects/undefined`, status: 422 },
    { url: `${BASE}/api/v1/flows/`, status: 500 },
    { url: `${BASE}/api/v1/login`, status: 401 },
  ]) {
    assert.deepEqual(
      classifyHttpError(facts),
      classifyHttpError(facts, []),
      `${facts.status} ${facts.url}`,
    );
  }
  assert.equal(
    classifyHttpError({ url: `${BASE}/api/v1/projects/undefined`, status: 422 })
      .monitored,
    true,
    "without a declaration the 422 stays a reported backend error",
  );
});

test("the first matching declaration wins and every ignore still has a reason", () => {
  const first: KnownHttpDefect = {
    pathname: "/api/v1/projects/undefined",
    status: 422,
    reason: "first",
  };
  const second: KnownHttpDefect = { ...first, reason: "second" };
  const verdict = classifyHttpError(
    { url: `${BASE}/api/v1/projects/undefined`, status: 422 },
    [first, second],
  );
  assert.ok(verdict.monitored === false && "knownDefect" in verdict);
  assert.equal(
    verdict.monitored === false && "knownDefect" in verdict
      ? verdict.knownDefect.reason
      : "",
    "first",
  );
  // The reason string is what a reviewer reads in the debug breakdown; a
  // declared match must not be the one verdict that arrives without one.
  assert.match(
    verdict.monitored === false ? verdict.ignoreReason : "",
    /first/,
  );
});
