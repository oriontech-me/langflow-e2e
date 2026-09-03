// Unit tests for the API-surface drift detector (#1692).
// Run with: npm run test:units
//
// Every fixture below is shaped after the real surface measured on Langflow
// Nightly `1.13.0.dev0` and `1.13.0.dev1`: 86 schema paths / 120 schema
// operations, against 249 operations in the instance's own router table (137 of
// them `include_in_schema=False`).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  apiSurfaceVerdict,
  collapseSlashPairs,
  describeBaselineDefect,
  inScopeOperations,
  normalizeRouteTable,
  opKey,
  schemaOperations,
  type ApiSurfaceBaseline,
} from "./api-surface-drift";

const BASELINE_PATH = path.join(
  __dirname,
  "../../assets/api/api-surface-baseline.json",
);

/** A baseline holding exactly the operations given, with no exclusions. */
const baselineOf = (
  operations: Array<[string, string, boolean]>,
  exclusions: Array<{ prefix: string; reason: string }> = [],
): ApiSurfaceBaseline => ({
  version: "1.13.0.dev0",
  exclusions,
  operations: operations.map(([method, p, inSchema]) => ({
    method,
    path: p,
    inSchema,
  })),
});

/** An OpenAPI document exposing exactly the operations given. */
const openapiOf = (operations: Array<[string, string]>): unknown => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, p] of operations) {
    paths[p] = paths[p] ?? {};
    paths[p][method.toLowerCase()] = { responses: {} };
  }
  return { openapi: "3.1.0", paths };
};

// ---------------------------------------------------------------------------
// schemaOperations — what the live /openapi.json contributes
// ---------------------------------------------------------------------------

test("schemaOperations lifts method+path pairs and upper-cases the verb", () => {
  const ops = schemaOperations(
    openapiOf([
      ["get", "/api/v2/files"],
      ["post", "/api/v2/files"],
    ]),
  );
  assert.deepEqual(ops, [
    { method: "GET", path: "/api/v2/files" },
    { method: "POST", path: "/api/v2/files" },
  ]);
});

test("schemaOperations ignores keys that are not HTTP methods", () => {
  // A path item legally carries `parameters`, `summary`, `servers` and `$ref`
  // beside its operations. Counting them would inflate the denominator with
  // entries no client can call.
  const ops = schemaOperations({
    paths: {
      "/api/v1/files/list/{flow_id}": {
        get: { responses: {} },
        parameters: [{ name: "flow_id", in: "path" }],
        summary: "List files",
        servers: [],
      },
    },
  });
  assert.deepEqual(ops, [
    { method: "GET", path: "/api/v1/files/list/{flow_id}" },
  ]);
});

test("schemaOperations returns null for a body that is not an OpenAPI document", () => {
  // `null` means "no signal", which the verdict turns into UNKNOWN. An empty
  // array would mean "the schema has no operations" — a different claim, and the
  // one that produced 36 phantom removals on a still-building catalog (#1012).
  for (const notADoc of [null, undefined, 42, "ok", [], { detail: "Not authenticated" }]) {
    assert.equal(schemaOperations(notADoc), null, JSON.stringify(notADoc));
  }
});

test("schemaOperations distinguishes an empty schema from an absent one", () => {
  assert.deepEqual(schemaOperations({ paths: {} }), []);
});

// ---------------------------------------------------------------------------
// normalizeRouteTable — the router table, de-duplicated
// ---------------------------------------------------------------------------

test("normalizeRouteTable collapses a registered slash pair onto the slash-less form", () => {
  // Measured: `/api/v2/files` and `/api/v2/files/` are BOTH registered and both
  // answer directly. One operation, keyed without the slash.
  const ops = normalizeRouteTable([
    { method: "GET", path: "/api/v2/files", inSchema: true },
    { method: "GET", path: "/api/v2/files/", inSchema: true },
  ]);
  assert.deepEqual(ops, [
    { method: "GET", path: "/api/v2/files", inSchema: true },
  ]);
});

test("normalizeRouteTable keeps a slash that is the only registered spelling", () => {
  // The measured trap this whole rule exists for: `POST /api/v2/files/batch/` is
  // registered ONLY with the slash. Stripping it emits `/api/v2/files/batch`,
  // which falls through to `/api/v2/files/{file_id}` and answers 405 — a key no
  // client can call.
  const ops = normalizeRouteTable([
    { method: "POST", path: "/api/v2/files/batch/", inSchema: true },
    { method: "DELETE", path: "/api/v2/files/batch/", inSchema: true },
  ]);
  assert.deepEqual(ops.map((o) => opKey(o.method, o.path)).sort(), [
    "DELETE /api/v2/files/batch/",
    "POST /api/v2/files/batch/",
  ]);
});

test("normalizeRouteTable collapses per method, not per path", () => {
  // `GET /x` + `GET /x/` is one operation; a `POST` registered only at `/x/`
  // keeps its slash even though the GET pair resolved to the slash-less form.
  const ops = normalizeRouteTable([
    { method: "GET", path: "/api/v1/flows", inSchema: true },
    { method: "GET", path: "/api/v1/flows/", inSchema: true },
    { method: "POST", path: "/api/v1/flows/", inSchema: true },
  ]);
  assert.deepEqual(ops.map((o) => opKey(o.method, o.path)).sort(), [
    "GET /api/v1/flows",
    "POST /api/v1/flows/",
  ]);
});

test("normalizeRouteTable sorts its output", () => {
  // The baseline is a committed file: insertion order would make every refresh a
  // reviewable diff of nothing. Sorted keys are also what makes a phantom change
  // impossible when two routers register in a different order across builds.
  const ops = normalizeRouteTable([
    { method: "POST", path: "/api/v2/files", inSchema: true },
    { method: "GET", path: "/api/v1/version", inSchema: true },
    { method: "GET", path: "/api/v2/files", inSchema: true },
  ]);
  assert.deepEqual(ops.map((o) => opKey(o.method, o.path)), [
    "GET /api/v1/version",
    "GET /api/v2/files",
    "POST /api/v2/files",
  ]);
});

test("normalizeRouteTable throws on a malformed entry, naming it", () => {
  // This runs in the baseline refresh, never in globalSetup. A silently skipped
  // entry is an operation missing from the denominator forever, so the refresh
  // must die instead — the same reason `--min-categories` exists on the catalog
  // writer.
  assert.throws(
    () => normalizeRouteTable([{ method: "GET" }]),
    /malformed route entry/i,
  );
  assert.throws(() => normalizeRouteTable("not a table"), /route table/i);
});

// ---------------------------------------------------------------------------
// inScopeOperations — the exclusions, applied
// ---------------------------------------------------------------------------

test("inScopeOperations drops the excluded prefixes and keeps everything else", () => {
  const baseline = baselineOf(
    [
      ["GET", "/api/v1/authz/shares/", false],
      ["GET", "/api/v1/store/tags", false],
      ["GET", "/api/v2/files", true],
    ],
    [
      { prefix: "/api/v1/authz/", reason: "OSS authorization is pass-through" },
      { prefix: "/api/v1/store/", reason: "external service, unreachable in CI" },
    ],
  );
  assert.deepEqual(
    inScopeOperations(baseline).map((o) => opKey(o.method, o.path)),
    ["GET /api/v2/files"],
  );
});

test("inScopeOperations keeps a family nobody classified", () => {
  // A new upstream family lands IN scope, so it shows up as uncovered in the
  // report. Defaulting it out would hide a whole surface behind a decision
  // nobody made (`--mode=check`'s rule in watch-upstream-areas.mjs).
  const baseline = baselineOf(
    [["GET", "/api/v1/brand_new_family/", false]],
    [{ prefix: "/api/v1/authz/", reason: "pass-through" }],
  );
  assert.deepEqual(
    inScopeOperations(baseline).map((o) => o.path),
    ["/api/v1/brand_new_family/"],
  );
});

// ---------------------------------------------------------------------------
// describeBaselineDefect — what makes a baseline unusable
// ---------------------------------------------------------------------------

test("describeBaselineDefect names each unusable shape and passes a real one", () => {
  assert.match(String(describeBaselineDefect(null)), /not an object|unreadable/i);
  assert.match(String(describeBaselineDefect({})), /operations/i);
  assert.match(
    String(describeBaselineDefect({ operations: {} })),
    /operations/i,
  );
  assert.match(
    String(describeBaselineDefect({ operations: [] })),
    /no operations/i,
  );
  assert.match(
    String(describeBaselineDefect({ operations: [{ method: "GET" }] })),
    /path/i,
  );
  assert.equal(
    describeBaselineDefect(baselineOf([["GET", "/api/v2/files", true]])),
    null,
  );
});

// ---------------------------------------------------------------------------
// apiSurfaceVerdict — the whole comparison
// ---------------------------------------------------------------------------

test("apiSurfaceVerdict is UNKNOWN when the baseline cannot be used", () => {
  const verdict = apiSurfaceVerdict(null, openapiOf([["get", "/api/v2/files"]]));
  assert.equal(verdict.kind, "unknown");
  assert.match(String(verdict.reason), /baseline/i);
  assert.deepEqual(verdict.lines, []);
});

test("apiSurfaceVerdict is UNKNOWN when the live schema could not be read", () => {
  const verdict = apiSurfaceVerdict(
    baselineOf([["GET", "/api/v2/files", true]]),
    { detail: "Not authenticated" },
  );
  assert.equal(verdict.kind, "unknown");
  assert.match(String(verdict.reason), /schema|openapi/i);
});

test("apiSurfaceVerdict is UNKNOWN when the live schema carries no operations", () => {
  // A 200 is not a surface. Diffing an empty schema against the baseline would
  // report every schema-visible operation as removed — 109 lines each claiming a
  // family vanished, on an instance that is merely still starting (#1012).
  const verdict = apiSurfaceVerdict(baselineOf([["GET", "/api/v2/files", true]]), {
    paths: {},
  });
  assert.equal(verdict.kind, "unknown");
  assert.match(String(verdict.reason), /no operations/i);
});

test("apiSurfaceVerdict is clean when the schema half matches, and says how many are carried", () => {
  const verdict = apiSurfaceVerdict(
    baselineOf([
      ["GET", "/api/v2/files", true],
      ["GET", "/api/v1/variables/", false],
      ["GET", "/api/v1/api_key/", false],
    ]),
    openapiOf([["get", "/api/v2/files"]]),
  );
  assert.equal(verdict.kind, "clean");
  assert.equal(verdict.schemaCount, 1);
  // The hidden half is not readable over HTTP: it is carried from the baseline,
  // and the count is printed so a reader never mistakes the comparison for the
  // whole surface.
  assert.equal(verdict.hiddenCarried, 2);
});

test("apiSurfaceVerdict names what drifted, removals first", () => {
  const verdict = apiSurfaceVerdict(
    baselineOf([
      ["GET", "/api/v2/files", true],
      ["DELETE", "/api/v1/files/delete/{flow_id}/{file_name}", true],
    ]),
    openapiOf([
      ["get", "/api/v2/files"],
      ["get", "/api/v1/brand_new/"],
    ]),
  );
  assert.equal(verdict.kind, "drift");
  assert.equal(verdict.lines.length, 2);
  assert.match(verdict.lines[0], /REMOVED\s+DELETE \/api\/v1\/files\/delete/);
  assert.match(verdict.lines[1], /ADDED\s+GET \/api\/v1\/brand_new\//);
});

test("apiSurfaceVerdict compares only the schema-visible half", () => {
  // The hidden operations are absent from /openapi.json BY CONSTRUCTION. Diffing
  // them against it would report all 90 as removed on every single run.
  const verdict = apiSurfaceVerdict(
    baselineOf([
      ["GET", "/api/v2/files", true],
      ["POST", "/api/v1/login", false],
    ]),
    openapiOf([["get", "/api/v2/files"]]),
  );
  assert.equal(verdict.kind, "clean");
});

test("apiSurfaceVerdict never throws, whatever it is handed", () => {
  // The property that matters: this runs in globalSetup, where a throw aborts the
  // run with zero tests executed — a day of coverage lost to a reporting feature
  // (#980, and the TypeError the inline catalog comparison actually shipped).
  const garbage: unknown[] = [
    null,
    undefined,
    0,
    "",
    [],
    {},
    { operations: [{ method: "GET", path: "/x", inSchema: "yes" }] },
    { operations: [null] },
    { operations: [{ method: 1, path: 2, inSchema: true }] },
    { exclusions: "none", operations: [{ method: "GET", path: "/x", inSchema: true }] },
  ];
  for (const b of garbage) {
    for (const live of garbage) {
      const verdict = apiSurfaceVerdict(b, live);
      assert.ok(
        ["clean", "drift", "unknown"].includes(verdict.kind),
        `${JSON.stringify(b)} / ${JSON.stringify(live)} -> ${verdict.kind}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The committed baseline itself
// ---------------------------------------------------------------------------

test("the committed baseline is usable and its in-scope set is non-empty", () => {
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  assert.equal(
    describeBaselineDefect(raw),
    null,
    "the committed baseline must satisfy the same shape guard as any other",
  );
  const inScope = inScopeOperations(raw as ApiSurfaceBaseline);
  assert.ok(
    inScope.length > 100,
    `expected a three-figure in-scope surface, got ${inScope.length}`,
  );
  // Every exclusion carries a reason — the report prints them, and an unexplained
  // exclusion is how a family quietly leaves the denominator.
  for (const e of (raw as ApiSurfaceBaseline).exclusions) {
    assert.ok(e.prefix.startsWith("/"), `exclusion prefix: ${e.prefix}`);
    assert.ok(
      typeof e.reason === "string" && e.reason.length > 20,
      `exclusion ${e.prefix} needs a reason, got: ${e.reason}`,
    );
  }
});

// ---------------------------------------------------------------------------
// collapseSlashPairs — applied to BOTH sides of the comparison
// ---------------------------------------------------------------------------

test("collapseSlashPairs is the same rule normalizeRouteTable uses", () => {
  const collapsed = collapseSlashPairs([
    { method: "POST", path: "/api/v2/files" },
    { method: "POST", path: "/api/v2/files/" },
    { method: "POST", path: "/api/v2/files/batch/" },
  ]);
  assert.deepEqual(collapsed.map((o) => opKey(o.method, o.path)).sort(), [
    "POST /api/v2/files",
    "POST /api/v2/files/batch/",
  ]);
});

test("apiSurfaceVerdict collapses the LIVE side too", () => {
  // Found by the gate on its first real run: `/openapi.json` exposes BOTH
  // `/api/v2/files` and `/api/v2/files/`, while the baseline collapses the pair
  // onto one key — so the twin was reported as ADDED on a surface that had not
  // changed at all. A drift warning that fires on every run is the noise #1084
  // was raised about.
  const verdict = apiSurfaceVerdict(
    baselineOf([["POST", "/api/v2/files", true]]),
    openapiOf([
      ["post", "/api/v2/files"],
      ["post", "/api/v2/files/"],
    ]),
  );
  assert.equal(verdict.kind, "clean");
  assert.equal(verdict.schemaCount, 1);
});

test("apiSurfaceVerdict still reports a slash-only route the baseline lacks", () => {
  // The collapse must not swallow a real addition: `batch/` is registered only
  // with the slash, so it is its own operation and its absence is drift.
  const verdict = apiSurfaceVerdict(
    baselineOf([["POST", "/api/v2/files", true]]),
    openapiOf([
      ["post", "/api/v2/files"],
      ["post", "/api/v2/files/batch/"],
    ]),
  );
  assert.equal(verdict.kind, "drift");
  assert.match(verdict.lines.join("\n"), /ADDED\s+POST \/api\/v2\/files\/batch\//);
});

test("the committed baseline covers every operation /openapi.json exposes", () => {
  // The invariant that catches a router the walk never reached. It failed on the
  // first real run: the walk only visited `langflow.api.router.router`, so the
  // app-level health and log routers (/health, /health_check, /healthz, /logs,
  // /logs-stream) were missing from the baseline and the gate reported five
  // phantom additions on every single run.
  const raw = JSON.parse(
    fs.readFileSync(BASELINE_PATH, "utf8"),
  ) as ApiSurfaceBaseline;
  const known = new Set(
    collapseSlashPairs(raw.operations).map((o) => opKey(o.method, o.path)),
  );
  for (const p of ["/health", "/health_check", "/healthz", "/logs", "/logs-stream"]) {
    assert.ok(
      known.has(`GET ${p}`),
      `the baseline is missing GET ${p} — the router walk did not reach every app-level router`,
    );
  }
});
