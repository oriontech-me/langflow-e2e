// Unit tests for the API-surface baseline writer (#1692).
// Run with: npm run test:units
//
// The writer is the only piece that needs the instance's own process: the hidden
// half of the router table (137 of 249 operations on `1.13.0.dev0`) is not
// readable over HTTP. Everything decidable without Docker lives in the pure
// functions below.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_SCOPE_EXCLUSIONS,
  buildBaseline,
  dockerExecArgv,
  parseArgs,
  parseRouteDump,
  ROUTE_DUMP_MARKER,
} from "./update-api-surface-baseline";
import {
  describeBaselineDefect,
  inScopeOperations,
  opKey,
} from "../tests/helpers/other/api-surface-drift";

const ROUTES = [
  { method: "GET", path: "/api/v2/files", inSchema: true },
  { method: "GET", path: "/api/v2/files/", inSchema: true },
  { method: "POST", path: "/api/v2/files/batch/", inSchema: true },
  { method: "GET", path: "/api/v1/variables/", inSchema: false },
  { method: "GET", path: "/api/v1/authz/shares/", inSchema: false },
  { method: "GET", path: "/api/v1/store/tags", inSchema: false },
];

// ---------------------------------------------------------------------------
// parseRouteDump — reading the extractor's output
// ---------------------------------------------------------------------------

test("parseRouteDump lifts the marked line out of noisy stdout", () => {
  // Real stdout: the image prints a transformers warning before anything else,
  // so the payload has to be marked rather than assumed to be the whole output.
  const stdout = [
    "[transformers] PyTorch was not found. Models won't be available",
    `${ROUTE_DUMP_MARKER}[["GET","/api/v2/files",true]]`,
    "",
  ].join("\n");
  assert.deepEqual(parseRouteDump(stdout), [
    { method: "GET", path: "/api/v2/files", inSchema: true },
  ]);
});

test("parseRouteDump refuses an empty table instead of writing one", () => {
  // The measured trap this guards: FastAPI defers included routers, so a naive
  // read of `router.routes` yields 2 `_IncludedRouter` entries with
  // `methods=None` and the walk returns []. An empty baseline would silently
  // shrink the denominator to zero and read as a clean 0/0.
  assert.throws(
    () => parseRouteDump(`${ROUTE_DUMP_MARKER}[]`),
    /no routes/i,
  );
});

test("parseRouteDump names what it got when the marker is missing or broken", () => {
  assert.throws(() => parseRouteDump("Traceback (most recent call last):"), /marker/i);
  assert.throws(() => parseRouteDump(""), /marker/i);
  assert.throws(
    () => parseRouteDump(`${ROUTE_DUMP_MARKER}{not json`),
    /could not be parsed/i,
  );
  assert.throws(
    () => parseRouteDump(`${ROUTE_DUMP_MARKER}{"routes": 1}`),
    /array/i,
  );
});

// ---------------------------------------------------------------------------
// dockerExecArgv — how the extraction reaches the instance
// ---------------------------------------------------------------------------

test("dockerExecArgv passes the walker as an argument, never through a shell", () => {
  const argv = dockerExecArgv("langflow-e2e-runner");
  assert.equal(argv[0], "exec");
  assert.ok(argv.includes("langflow-e2e-runner"));
  assert.deepEqual(argv.slice(-2, -1), ["-c"]);
  const walker = argv[argv.length - 1];
  // The walk MUST recurse: the two things that make this table unreadable by a
  // plain loop are the lazy include wrapper and its prefix.
  assert.match(walker, /_IncludedRouter/);
  assert.match(walker, /original_router/);
  assert.match(walker, /include_context/);
  assert.match(walker, new RegExp(ROUTE_DUMP_MARKER.replace(/[:]/g, "[:]")));
});

// ---------------------------------------------------------------------------
// The exclusions
// ---------------------------------------------------------------------------

test("every scope exclusion carries a prefix and a real reason", () => {
  assert.ok(API_SCOPE_EXCLUSIONS.length > 0);
  for (const e of API_SCOPE_EXCLUSIONS) {
    assert.ok(e.prefix.startsWith("/api/"), `prefix: ${e.prefix}`);
    assert.ok(
      e.reason.length > 20,
      `${e.prefix} needs a reason a reader can act on, got: ${e.reason}`,
    );
  }
});

test("the documented exclusions are the ones the code applies", () => {
  // docs/api/api-surface-coverage-gauge.md lists five families. Drifting apart
  // from the doc is how an exclusion loses its justification silently (#1084's
  // class of failure).
  const prefixes = API_SCOPE_EXCLUSIONS.map((e) => e.prefix).sort();
  assert.deepEqual(prefixes, [
    "/api/v1/agentic/",
    "/api/v1/authz/",
    "/api/v1/extensions/",
    "/api/v1/predict/",
    "/api/v1/process/",
    "/api/v1/store/",
    "/api/v1/task/",
    "/api/v1/upload/",
    "/api/v1/voice/",
  ]);
});

// ---------------------------------------------------------------------------
// buildBaseline — what gets committed
// ---------------------------------------------------------------------------

test("buildBaseline writes a baseline the gate accepts, de-duplicated and sorted", () => {
  const baseline = buildBaseline({
    version: "1.13.0.dev0",
    routes: ROUTES,
  });
  assert.equal(describeBaselineDefect(baseline), null);
  // `/api/v2/files` + `/api/v2/files/` collapse; `batch/` keeps its slash.
  const keys = baseline.operations.map((o) => opKey(o.method, o.path));
  assert.ok(keys.includes("GET /api/v2/files"));
  assert.ok(!keys.includes("GET /api/v2/files/"));
  assert.ok(keys.includes("POST /api/v2/files/batch/"));
  assert.deepEqual(keys, [...keys].sort());
});

test("buildBaseline records the exclusions so the report can print them", () => {
  const baseline = buildBaseline({
    version: "1.13.0.dev0",
    routes: ROUTES,
  });
  // The excluded operations stay IN the file — the denominator is derived, so a
  // family can be re-scoped without re-extracting, and the report can say what
  // it left out and why.
  const keys = baseline.operations.map((o) => opKey(o.method, o.path));
  assert.ok(keys.includes("GET /api/v1/authz/shares/"));
  assert.deepEqual(
    inScopeOperations(baseline).map((o) => opKey(o.method, o.path)),
    ["GET /api/v1/variables/", "GET /api/v2/files", "POST /api/v2/files/batch/"],
  );
});

test("buildBaseline carries the liveness probe result, including what looked dead", () => {
  const baseline = buildBaseline({
    version: "1.13.0.dev0",
    routes: ROUTES,
    liveness: { probed: 3, dead: ["GET /api/v1/variables/"] },
  });
  assert.equal(baseline.liveness?.probed, 3);
  assert.deepEqual(baseline.liveness?.dead, ["GET /api/v1/variables/"]);
});

test("buildBaseline refuses a route table that lost the schema half", () => {
  // A run where `/openapi.json` was unreachable but the router walk succeeded
  // would write `inSchema: false` for all 249 operations, and the gate would
  // then compare nothing at all while reporting `clean`.
  assert.throws(
    () =>
      buildBaseline({
        version: "1.13.0.dev0",
            routes: ROUTES.map((r) => ({ ...r, inSchema: false })),
      }),
    /schema/i,
  );
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs defaults to the container and base URL the suite uses", () => {
  const args = parseArgs([]);
  assert.equal(args.container, "langflow-e2e-runner");
  assert.equal(args.baseUrl, "http://localhost:7860");
});

test("parseArgs takes an explicit container, base URL and output path", () => {
  const args = parseArgs([
    "--container",
    "langflow-1643-113",
    "--base-url",
    "http://localhost:7880/",
    "--out",
    "/tmp/baseline.json",
  ]);
  assert.equal(args.container, "langflow-1643-113");
  // Trailing slash trimmed: every probe concatenates a path onto this.
  assert.equal(args.baseUrl, "http://localhost:7880");
  assert.equal(args.out, "/tmp/baseline.json");
});

test("parseArgs rejects an unknown flag instead of ignoring it", () => {
  assert.throws(() => parseArgs(["--containr", "x"]), /unknown/i);
  assert.throws(() => parseArgs(["--container"]), /--container/);
});

test("buildBaseline is reproducible — the file carries no clock", () => {
  // The committed diff IS the review, so a field that changes on every refresh
  // makes every refresh a diff of nothing and trains the reader to skip it. When
  // the baseline was last refreshed is a question git history answers better than
  // a timestamp inside the artifact.
  const first = buildBaseline({ version: "1.13.0.dev0", routes: ROUTES });
  const second = buildBaseline({ version: "1.13.0.dev0", routes: ROUTES });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(
    !JSON.stringify(first).includes("generatedAt"),
    "the baseline must not carry a generation timestamp",
  );
});
