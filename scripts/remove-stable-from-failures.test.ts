// Unit tests for the @stable auto-removal script (issue #1017).
// Run with: npm run test:units
//
// This is the only script in the repo that EDITS SPEC FILES AND COMMITS THEM TO
// `main` with no human review (leadership decision — restoring a tag is the
// human-gated step, removing one is not). Its mass-failure guard is the last
// thing between an infra-red day and the whole stable suite being quarantined
// at once, and until now nothing asserted that the guard fires.
//
// The tests drive the REAL script as a subprocess, through the contract
// `.github/actions/auto-remove-stable/action.yml` uses (`PLAYWRIGHT_JSON` +
// `MAX_AUTO_REMOVE` in, one JSON object on stdout), against throwaway spec
// files in a temp dir. Anything less would test a reimplementation of the guard
// rather than the guard: `main()` reads its threshold at module scope and writes
// to disk, so the file mutation IS the behaviour under test.
//
// The "path resolution (#476)" block at the bottom absorbs
// `tests/scripts/remove-stable-from-failures.spec.ts`, deleted with this file's
// arrival. Those three cases were Playwright specs, so running three assertions
// over a pure function booted a Langflow container and waited on the credential
// pre-flight — the cost #1017's lane exists to remove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectHardFailures, lastFailureError } from "./remove-stable-from-failures";
import { classifyInfraError } from "./lib/infra-signatures";

const SCRIPT = path.join(__dirname, "remove-stable-from-failures.ts");

interface Result {
  status: "removed" | "none" | "guard_tripped";
  threshold: number;
  hardFailures: number;
  attributableFailures: number;
  removed: Array<{ file: string; title: string; line: number; soleTag: boolean }>;
  skipped: Array<{ file: string; title: string; line: number; reason: string }>;
  exempt: Array<{
    file: string;
    title: string;
    line: number;
    signature: string;
    why: string;
    error: string;
  }>;
  backendWedged: string;
}

/** Real signatures, copied from `reports/daily-history.jsonl`. */
const INFRA_ERROR = "TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.";
const PRODUCT_ERROR = "TimeoutError: locator.click: Timeout 20000ms exceeded.";

/** A minimal spec carrying one `@stable` test per title, plus decoy prose. */
function specSource(titles: string[]): string {
  return [
    "import { test } from '../fixtures/fixtures';",
    "",
    "// Promoted to @stable in the 1.10.x cycle — this comment is not a tag.",
    ...titles.flatMap((t) => [
      `test("${t}", { tag: ["@stable", "@regression"] }, async ({ page }) => {`,
      "  await page.goto('/');",
      "});",
      "",
    ]),
  ].join("\n");
}

/**
 * Run the real script over a temp workspace. `specs` maps a spec filename to
 * the titles it declares; `failures` names the (file, title) pairs the report
 * marks `unexpected`. Returns the parsed stdout plus the on-disk sources after,
 * so a test can assert that NOTHING was rewritten.
 */
function runScript(opts: {
  specs: Record<string, string[]>;
  failures?: Array<{
    file: string;
    title: string;
    status?: string;
    error?: string;
    /** Raw `tests[].results` override, for shapes `error` alone cannot express. */
    results?: unknown[];
  }>;
  maxAutoRemove?: string;
  reportPath?: string;
  reportBody?: string;
  /** The #1030 liveness verdict the action forwards; "" when unmeasured. */
  backendWedged?: string;
}): { result: Result; after: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-"));
  try {
    for (const [file, titles] of Object.entries(opts.specs)) {
      fs.writeFileSync(path.join(dir, file), specSource(titles));
    }

    // Playwright's JSON reporter emits `spec.file` relative to its rootDir, and
    // records the absolute rootDir in `config` — the shape #476 taught the
    // script to resolve. Reproduce it rather than shortcutting to absolute paths.
    const report = {
      config: { rootDir: dir },
      suites: (opts.failures ?? []).map((f, i) => ({
        title: f.file,
        file: f.file,
        specs: [
          {
            title: f.title,
            file: f.file,
            line: 4 + i,
            tests: [
              {
                status: f.status ?? "unexpected",
                // The retry shape Playwright actually emits, so the exemption is
                // exercised through `results[].error`, not a shortcut field.
                ...(f.results
                  ? { results: f.results }
                  : f.error
                    ? { results: [{ status: "failed", error: { message: f.error } }] }
                    : {}),
              },
            ],
          },
        ],
      })),
    };

    const reportPath = path.join(dir, opts.reportPath ?? "results.json");
    if (opts.reportBody !== undefined) {
      fs.writeFileSync(reportPath, opts.reportBody);
    } else if (opts.reportPath !== "missing.json") {
      fs.writeFileSync(reportPath, JSON.stringify(report));
    }

    const stdout = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          PLAYWRIGHT_JSON: reportPath,
          MAX_AUTO_REMOVE: opts.maxAutoRemove ?? "5",
          BACKEND_WEDGED: opts.backendWedged ?? "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const after: Record<string, string> = {};
    for (const file of Object.keys(opts.specs)) {
      after[file] = fs.readFileSync(path.join(dir, file), "utf-8");
    }
    return { result: JSON.parse(stdout) as Result, after };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── The mass-failure guard ──────────────────────────────────────────────────

test("guard trips above the threshold and rewrites NOTHING", () => {
  // A red day where everything fails is almost always infra (container did not
  // boot, provider outage) — not per-test rot. Removing @stable from all of it
  // would quarantine the stable suite in one unreviewed commit.
  const titles = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "fixture-1017-a.spec.ts", title })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  assert.equal(result.threshold, 5);
  assert.deepEqual(result.removed, []);
  // The assertion that matters: the file on disk is byte-identical.
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

test("exactly at the threshold still proceeds (the guard is strictly greater-than)", () => {
  const titles = ["t1", "t2", "t3", "t4", "t5"];
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "fixture-1017-a.spec.ts", title })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "removed");
  assert.equal(result.removed.length, 5);
  // No `tag` array still holds it. (The prose mention in the header comment is
  // expected to survive — that is the point of the AST-located edit.)
  assert.equal(after["fixture-1017-a.spec.ts"].includes('"@stable"'), false);
  assert.match(after["fixture-1017-a.spec.ts"], /Promoted to @stable in the 1\.10\.x cycle/);
  // Every other tag survives — removal is per-element, not per-array.
  assert.equal(after["fixture-1017-a.spec.ts"].match(/@regression/g)?.length, 5);
});

test("the threshold is read from MAX_AUTO_REMOVE, not hardcoded", () => {
  // The workflow passes it as an input (default 5); a stricter day can lower it.
  const titles = ["t1", "t2"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "fixture-1017-a.spec.ts", title })),
    maxAutoRemove: "1",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.threshold, 1);
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

test("guard counts failures ACROSS files, not per file", () => {
  // Three files failing twice each is still a six-failure day.
  const titles = ["t1", "t2"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": titles, "fixture-1017-b.spec.ts": titles, "fixture-1017-c.spec.ts": titles },
    failures: ["fixture-1017-a.spec.ts", "fixture-1017-b.spec.ts", "fixture-1017-c.spec.ts"].flatMap((file) =>
      titles.map((title) => ({ file, title })),
    ),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  for (const file of ["fixture-1017-a.spec.ts", "fixture-1017-b.spec.ts", "fixture-1017-c.spec.ts"]) {
    assert.equal(after[file], before);
  }
});

// ─── The infra-signature exemption (#1031) ───────────────────────────────────
//
// The mass-failure guard above only covers the WIDE wedge. The hole these cases
// close is the NARROW one: on run 30374528125 the backend wedged and 14 of 19
// hard failures described that one backend — we escaped by luck, because 19 > 5
// tripped the guard. A wedge costing FIVE tests would have stripped five
// innocent tags in an unreviewed commit to `main`.

test("a narrow wedge (at the threshold) exempts every collateral spec and rewrites NOTHING", () => {
  const titles = ["t1", "t2", "t3", "t4", "t5"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "fixture-1031-a.spec.ts", title, error: INFRA_ERROR })),
    maxAutoRemove: "5",
  });

  // Pre-#1031 this exact report returned "removed" with five removals.
  assert.equal(result.status, "none");
  assert.equal(result.hardFailures, 5);
  assert.equal(result.attributableFailures, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.exempt.length, 5);
  assert.deepEqual([...new Set(result.exempt.map((e) => e.signature))], ["api-request-timeout"]);
  assert.equal(after["fixture-1031-a.spec.ts"], before);
});

test("collateral is exempted while the attributable failure in the same run is still removed", () => {
  // The mixed shape of a real wedged day. The exemption must not become a blanket
  // amnesty: a spec that failed on its own error still loses the tag.
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": ["wedged", "broken"] },
    failures: [
      { file: "fixture-1031-a.spec.ts", title: "wedged", error: INFRA_ERROR },
      { file: "fixture-1031-a.spec.ts", title: "broken", error: PRODUCT_ERROR },
    ],
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "removed");
  assert.equal(result.hardFailures, 2);
  assert.equal(result.attributableFailures, 1);
  assert.deepEqual(result.removed.map((r) => r.title), ["broken"]);
  assert.deepEqual(result.exempt.map((e) => e.title), ["wedged"]);
  const after1 = after["fixture-1031-a.spec.ts"];
  assert.match(after1, /test\("wedged", \{ tag: \["@stable", "@regression"\] \}/);
  assert.match(after1, /test\("broken", \{ tag: \["@regression"\] \}/);
});

test("an ambiguous error does NOT exempt — the list must stay narrow", () => {
  // `locator.click: Timeout` is the single most common signature in
  // reports/daily-history.jsonl and a wedge produces plenty of it. Exempting it
  // would switch auto-removal off for most genuine regressions too.
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": ["t1"] },
    failures: [{ file: "fixture-1031-a.spec.ts", title: "t1", error: PRODUCT_ERROR }],
  });

  assert.equal(result.status, "removed");
  assert.deepEqual(result.exempt, []);
  // Quoted: `specSource` also plants the tag in prose, which must survive.
  assert.equal(after["fixture-1031-a.spec.ts"].includes('"@stable"'), false);
});

test("a failure with NO error at all is treated as attributable, not exempt", () => {
  // Fail-closed in the direction that keeps the mechanism working: an absent
  // error is not evidence of a wedge. (`error_signature: "unknown"` appears 13
  // times in the history file.)
  const { result } = runScript({
    specs: { "fixture-1031-a.spec.ts": ["t1"] },
    failures: [{ file: "fixture-1031-a.spec.ts", title: "t1" }],
  });

  assert.equal(result.status, "removed");
  assert.equal(result.attributableFailures, 1);
  assert.deepEqual(result.exempt, []);
});

test("the guard still counts collateral — and still labels it", () => {
  // Deliberate: netting the exempt failures out of the count would make the
  // guard fire LESS often than before #1031 and remove tags a pre-#1031 run
  // would have left alone. The removal set stays a subset. The labelling,
  // though, has to survive the early return — the wide wedge is the run that
  // most needs the issue body to name the cause.
  const titles = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": titles },
    failures: titles.map((title, i) => ({
      file: "fixture-1031-a.spec.ts",
      title,
      error: i < 4 ? INFRA_ERROR : PRODUCT_ERROR,
    })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  assert.equal(result.attributableFailures, 2);
  assert.equal(result.exempt.length, 4);
  assert.equal(after["fixture-1031-a.spec.ts"], before);
});

test("the exemption does not depend on the liveness verdict", () => {
  // BACKEND_WEDGED is wording only. It has to be, or the exemption would fold
  // on exactly the run where the recorder produced nothing — the run whose
  // backend state is least known.
  for (const backendWedged of ["", "false", "true"]) {
    const { result } = runScript({
      specs: { "fixture-1031-a.spec.ts": ["t1"] },
      failures: [{ file: "fixture-1031-a.spec.ts", title: "t1", error: INFRA_ERROR }],
      backendWedged,
    });
    assert.equal(result.exempt.length, 1, `wedged=${JSON.stringify(backendWedged)}`);
    assert.equal(result.backendWedged, backendWedged);
    assert.equal(result.removed.length, 0);
  }
});

test("the signature is matched anywhere in the error, not only on line one", () => {
  // A wedge frequently surfaces as an assertion header whose CAUSE line is the
  // transport error. Matching the first line only (what build-run-payload.mjs
  // stores as `error_signature`) would miss it.
  const { result } = runScript({
    specs: { "fixture-1031-a.spec.ts": ["t1"] },
    failures: [
      {
        file: "fixture-1031-a.spec.ts",
        title: "t1",
        error: "Error: flow build failed\nCause: connect ECONNREFUSED 127.0.0.1:7860",
      },
    ],
  });

  assert.equal(result.exempt.length, 1);
  assert.equal(result.exempt[0].signature, "connection-refused");
});

test("a transport cause DEEP in the message still exempts — truncation is display-only", () => {
  // The regression this pins: the error was cut to ERROR_MAX chars BEFORE being
  // classified, so an assertion header plus a Playwright call log pushed the
  // `Cause:` line out of range and the innocent spec lost its tag anyway — the
  // exact harm #1031 exists to prevent.
  const deepCause =
    "Error: expect(received).toBeVisible() failed\n\n" +
    "Locator: getByTestId('chat-message-ai-response')\nExpected: visible\n" +
    "Received: <element(s) not found>\nTimeout: 30000ms\n\nCall log:\n" +
    Array.from(
      { length: 6 },
      (_, i) => `  - waiting for getByTestId('chat-message-ai-response') attempt ${i}`,
    ).join("\n") +
    "\nCause: connect ECONNREFUSED 127.0.0.1:7860";
  assert.ok(
    deepCause.indexOf("ECONNREFUSED") > 240,
    "fixture must push the cause past the display limit to be meaningful",
  );

  const titles = ["t1"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": titles },
    failures: [{ file: "fixture-1031-a.spec.ts", title: "t1", error: deepCause }],
  });

  assert.equal(result.exempt.length, 1);
  assert.equal(result.exempt[0].signature, "connection-refused");
  assert.equal(after["fixture-1031-a.spec.ts"], before);
  // The issue body still carries a bounded excerpt, not the whole call log.
  assert.ok(result.exempt[0].error.length <= 241, String(result.exempt[0].error.length));
  assert.match(result.exempt[0].error, /…$/);
});

test("the transport error is found past errors[0] — the timedOut wrapper shape", () => {
  // A test that times out while an API call hangs: Playwright puts the timeout
  // wrapper in `error` and the pending call in a later `errors[]` entry. Reading
  // only `error`/`errors[0]` would classify this as attributable.
  const { result } = runScript({
    specs: { "fixture-1031-a.spec.ts": ["t1"] },
    failures: [
      {
        file: "fixture-1031-a.spec.ts",
        title: "t1",
        results: [
          {
            status: "timedOut",
            error: { message: "Test timeout of 300000ms exceeded." },
            errors: [
              { message: "Test timeout of 300000ms exceeded." },
              { message: INFRA_ERROR },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.exempt.length, 1);
  assert.equal(result.exempt[0].signature, "api-request-timeout");
});

test("a wide wedge with NO attributable failure still reports guard_tripped", () => {
  // `status` has to keep meaning "would the guard have tripped". The triage
  // skill's own detectGuard recomputes the guard from totals.failed, so an
  // all-collateral mass-failure day reported as "none" would contradict it.
  const titles = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "fixture-1031-a.spec.ts": titles },
    failures: titles.map((title) => ({
      file: "fixture-1031-a.spec.ts",
      title,
      error: INFRA_ERROR,
    })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  assert.equal(result.attributableFailures, 0);
  assert.equal(result.exempt.length, 6);
  assert.equal(after["fixture-1031-a.spec.ts"], before);
});

test("classifyInfraError covers the transport signatures and rejects product ones", () => {
  const infra: Array<[string, string]> = [
    ["TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.", "api-request-timeout"],
    ["TimeoutError: apiRequestContext.post: Timeout 30000ms exceeded.", "api-request-timeout"],
    [
      "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms",
      "preflight-unreachable",
    ],
    ["Error: connect ECONNREFUSED 127.0.0.1:7860", "connection-refused"],
    ["Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:7860/", "connection-refused"],
    ["Error: socket hang up", "connection-dropped"],
    ["Error: read ECONNRESET", "connection-dropped"],
    ["Error: getaddrinfo EAI_AGAIN localhost", "host-unresolvable"],
  ];
  for (const [error, id] of infra) {
    assert.equal(classifyInfraError(error)?.id, id, error);
  }

  const product = [
    "TimeoutError: locator.click: Timeout 20000ms exceeded.",
    "TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.",
    "Error: expect(locator).toBeVisible() failed",
    "Error: Playground must show a 'Called tool' indicator",
    "",
    null,
    undefined,
  ];
  for (const error of product) {
    assert.equal(classifyInfraError(error), null, String(error));
  }
});

test("lastFailureError reads the LAST failed attempt, ANSI stripped", () => {
  // Retries are what a wedge burns; the final attempt is the one that decided
  // the verdict, so a first-attempt product error must not mask a wedge (or the
  // other way round).
  const test0 = {
    results: [
      { status: "failed", error: { message: PRODUCT_ERROR } },
      { status: "failed", error: { message: INFRA_ERROR } },
    ],
  };
  assert.equal(lastFailureError(test0), INFRA_ERROR);

  // The escape-stripped form the history file actually carries.
  assert.equal(
    lastFailureError({ results: [{ status: "failed", error: { message: "Error: [2mexpect([22mx)" } }] }),
    "Error: expect(x)",
  );

  // `errors[]` instead of `error`, and the no-result case.
  assert.equal(
    lastFailureError({ results: [{ status: "failed", errors: [{ message: INFRA_ERROR }] }] }),
    INFRA_ERROR,
  );
  assert.equal(lastFailureError({}), "");

  // Every error of the attempt is kept, and the `error === errors[0]` duplication
  // Playwright normally emits is collapsed rather than repeated.
  assert.equal(
    lastFailureError({
      results: [
        {
          status: "timedOut",
          error: { message: PRODUCT_ERROR },
          errors: [{ message: PRODUCT_ERROR }, { message: INFRA_ERROR }],
        },
      ],
    }),
    `${PRODUCT_ERROR}\n${INFRA_ERROR}`,
  );

  // No truncation here — the classifier needs the full text (#1031 review).
  const long = `${"x".repeat(400)} ECONNREFUSED`;
  assert.equal(
    lastFailureError({ results: [{ status: "failed", error: { message: long } }] }),
    long,
  );
});

// ─── Nothing to do ───────────────────────────────────────────────────────────

test("a green report removes nothing", () => {
  const before = specSource(["t1"]);
  const { result, after } = runScript({ specs: { "fixture-1017-a.spec.ts": ["t1"] }, failures: [] });

  assert.equal(result.status, "none");
  assert.equal(result.hardFailures, 0);
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

test("a missing report removes nothing", () => {
  // The suite never really ran — same conclusion as the guard, reached earlier.
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": ["t1"] },
    reportPath: "missing.json",
  });

  assert.equal(result.status, "none");
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

test("an unparseable report removes nothing", () => {
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": ["t1"] },
    reportBody: "{ this is not json",
  });

  assert.equal(result.status, "none");
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

test("a FLAKY test keeps @stable", () => {
  // Triage policy: passing on a retry is a flake, tracked by an issue, not a
  // reason to drop the tag. Only status "unexpected" counts.
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "fixture-1017-a.spec.ts": ["t1"] },
    failures: [{ file: "fixture-1017-a.spec.ts", title: "t1", status: "flaky" }],
  });

  assert.equal(result.status, "none");
  assert.equal(result.hardFailures, 0);
  assert.equal(after["fixture-1017-a.spec.ts"], before);
});

// ─── Splicing ────────────────────────────────────────────────────────────────

test("removes only the @stable element, preserving comments and the other tags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-splice-"));
  try {
    const source = [
      "import { test } from '../fixtures/fixtures';",
      "",
      "/**",
      " * Promoted to @stable after the 1.10.x validation run.",
      " */",
      'test("middle", { tag: ["@release", "@stable", "@agents"] }, async () => {});',
      "",
      '// tag: ["@stable"] <- do not touch',
      'test("last", { tag: ["@release", "@stable"] }, async () => {});',
      "",
      'test("sole", { tag: ["@stable"] }, async () => {});',
      "",
      'test("untouched", { tag: ["@stable"] }, async () => {});',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "fixture-1017-a.spec.ts"), source);
    const report = {
      config: { rootDir: dir },
      suites: [
        {
          file: "fixture-1017-a.spec.ts",
          specs: ["middle", "last", "sole"].map((title, i) => ({
            title,
            file: "fixture-1017-a.spec.ts",
            line: 6 + i,
            tests: [{ status: "unexpected" }],
          })),
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(report));

    const stdout = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON: path.join(dir, "results.json"), MAX_AUTO_REMOVE: "5" },
      },
    );
    const result = JSON.parse(stdout) as Result;
    const after = fs.readFileSync(path.join(dir, "fixture-1017-a.spec.ts"), "utf-8");

    assert.equal(result.status, "removed");
    assert.equal(result.removed.length, 3);
    assert.match(after, /test\("middle", \{ tag: \["@release", "@agents"\] \}/);
    assert.match(after, /test\("last", \{ tag: \["@release"\] \}/);
    assert.match(after, /test\("sole", \{ tag: \[\] \}/);
    // The prose survives untouched — the edit is AST-located, not textual.
    assert.match(after, / \* Promoted to @stable after the 1\.10\.x validation run\./);
    assert.match(after, /\/\/ tag: \["@stable"\] <- do not touch/);
    // A test that did not fail keeps its tag.
    assert.match(after, /test\("untouched", \{ tag: \["@stable"\] \}/);
    // `soleTag` is reported so the caller can flag an emptied array for review.
    // Sorted by title on purpose: the script splices back-to-front, so
    // `removed[]` comes out in reverse source order — an ordering the issue body
    // does not depend on and this test should not freeze.
    assert.deepEqual(
      result.removed
        .map((r) => ({ title: r.title, soleTag: r.soleTag }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      [
        { title: "last", soleTag: false },
        { title: "middle", soleTag: false },
        { title: "sole", soleTag: true },
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolvable spec path is reported, not silently swallowed", () => {
  // The #476 failure mode: every failure skipped as "spec file not found" while
  // the script exits with a clean `none`. It must surface a warning annotation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-missing-"));
  try {
    const report = {
      config: { rootDir: dir },
      suites: [
        {
          file: "fixture-1017-ghost.spec.ts",
          specs: [
            { title: "t1", file: "fixture-1017-ghost.spec.ts", line: 4, tests: [{ status: "unexpected" }] },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(report));

    const proc = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON: path.join(dir, "results.json"), MAX_AUTO_REMOVE: "5" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(proc) as Result;

    assert.equal(result.status, "none");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "spec file not found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── The report parser (exported, so tested directly) ────────────────────────

test("collectHardFailures reads nested suites and counts only 'unexpected'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-parse-"));
  try {
    fs.writeFileSync(path.join(dir, "fixture-1017-deep.spec.ts"), specSource(["hard", "flaky"]));
    const reportPath = path.join(dir, "results.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        config: { rootDir: dir },
        suites: [
          {
            file: "fixture-1017-deep.spec.ts",
            suites: [
              {
                file: "fixture-1017-deep.spec.ts",
                specs: [
                  { title: "hard", file: "fixture-1017-deep.spec.ts", line: 4, tests: [{ status: "unexpected" }] },
                  { title: "flaky", file: "fixture-1017-deep.spec.ts", line: 8, tests: [{ status: "flaky" }] },
                  { title: "ok", file: "fixture-1017-deep.spec.ts", line: 12, tests: [{ status: "expected" }] },
                ],
              },
            ],
          },
        ],
      }),
    );

    const failures = collectHardFailures(reportPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].title, "hard");
    assert.equal(failures[0].file, path.join(dir, "fixture-1017-deep.spec.ts"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectHardFailures returns [] for a missing or unparseable report", () => {
  assert.deepEqual(collectHardFailures(path.join(os.tmpdir(), "does-not-exist-1017.json")), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-bad-"));
  try {
    const bad = path.join(dir, "results.json");
    fs.writeFileSync(bad, "{ nope");
    assert.deepEqual(collectHardFailures(bad), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Path resolution (#476) ──────────────────────────────────────────────────
//
// Absorbed from `tests/scripts/remove-stable-from-failures.spec.ts`, deleted
// with this block's arrival. These cases need a fixture UNDER `<repo>/tests`,
// not in a temp dir, because the behaviour under test is precisely the base the
// script falls back to: the Playwright JSON reporter emits `spec.file` relative
// to its rootDir (`<repo>/tests`, from `testDir: "./tests"`), and the original
// code resolved against REPO_ROOT — so every hard failure was skipped as "spec
// file not found" and the auto-remove feature never removed a single tag.
//
// The fixture name matches `tests/scripts/.auto-remove-fixture-*.ts`, which is
// git-ignored (`.gitignore:32`); the leading dot also keeps `tsc` from compiling
// it if a crash ever leaks one, since TypeScript's include globs skip dotfiles.

const TESTS_ROOT = path.join(__dirname, "..", "tests");
const FIXTURE_DIR = path.join(TESTS_ROOT, "scripts");
const FIXTURE_TITLE = "auto-remove fixture: sample stable test";
const FIXTURE_SOURCE = `import { test } from "@playwright/test";

test(
  "${FIXTURE_TITLE}",
  { tag: ["@release", "@stable"] },
  async () => {
    // Fixture for scripts/remove-stable-from-failures — never run as a real test.
  },
);
`;

/**
 * Write the throwaway fixture under `tests/scripts/` and hand back both paths:
 * `abs` to read it, `rel` in the reporter's own form (relative to `tests/`).
 * `label` keys the filename so two cases never share a file.
 */
function withTestsRootFixture<T>(
  label: string,
  fn: (paths: { abs: string; rel: string }) => T,
): T {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const abs = path.join(FIXTURE_DIR, `.auto-remove-fixture-${label}.ts`);
  fs.writeFileSync(abs, FIXTURE_SOURCE);
  try {
    return fn({ abs, rel: path.relative(TESTS_ROOT, abs) });
  } finally {
    fs.rmSync(abs, { force: true });
  }
}

/** A one-hard-failure report for the fixture, optionally carrying a rootDir. */
function fixtureReport(specFile: string, rootDir?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-476-"));
  const reportPath = path.join(dir, "results.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      config: rootDir ? { rootDir } : {},
      suites: [
        {
          specs: [
            { title: FIXTURE_TITLE, file: specFile, line: 3, tests: [{ status: "unexpected" }] },
          ],
          suites: [],
        },
      ],
    }),
  );
  return reportPath;
}

test("resolves a rootDir-relative report path against tests/, not the repo root", () => {
  withTestsRootFixture("no-rootdir", ({ abs, rel }) => {
    // No `config.rootDir` at all — the exact shape that regressed in #476, where
    // REPO_ROOT was the only base tried and nothing ever resolved.
    const failures = collectHardFailures(fixtureReport(rel));

    assert.equal(failures.length, 1);
    assert.ok(path.isAbsolute(failures[0].file));
    assert.equal(failures[0].file, abs);
    assert.ok(fs.existsSync(failures[0].file));
  });
});

test("prefers the report's own config.rootDir when it is present", () => {
  withTestsRootFixture("with-rootdir", ({ abs, rel }) => {
    const failures = collectHardFailures(fixtureReport(rel, TESTS_ROOT));

    assert.equal(failures.length, 1);
    assert.equal(failures[0].file, abs);
  });
});

test("end-to-end through the tests/-relative path: @stable out, @release kept", () => {
  // The two above prove resolution; this one proves the script ACTS on it, which
  // is what #476 broke — resolution failing looked exactly like "nothing to do".
  withTestsRootFixture("end-to-end", ({ abs, rel }) => {
    const stdout = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON: fixtureReport(rel), MAX_AUTO_REMOVE: "5" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(stdout) as Result;

    assert.equal(result.status, "removed");
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].title, FIXTURE_TITLE);
    assert.deepEqual(result.skipped, []);

    const after = fs.readFileSync(abs, "utf-8");
    assert.equal(after.includes("@stable"), false);
    assert.ok(after.includes("@release"));
  });
});
