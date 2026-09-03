/**
 * The recorder half of the API-coverage gauge (#1692).
 *
 * A spec declares the operations it drives; this records the ones it actually
 * issued, so the declaration is verified rather than trusted. The policy that
 * decides a match lives next door in `api-coverage-policy.ts`; the wiring that
 * fails the test lives in `fixtures.ts`, and its behaviour is pinned by
 * `api-coverage-gate.spec.ts`.
 *
 * Only the **test-scoped `APIRequestContext`** is instrumented — never the
 * browser page. That is the definition of *covered*, implemented rather than
 * commented: traffic a page emits on its own is incidental, and a spec that
 * merely passes through an endpoint has asserted no contract. Playwright creates
 * the context per test, so patching its methods here touches nothing outside the
 * test that asked for the fixture.
 */

import type { APIRequestContext, TestInfo } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  describeDeclarationDefect,
  matchesOperation,
  recordFromUrl,
  unfulfilledDeclarations,
  type RecordedRequest,
} from "./api-coverage-policy";

/** What a spec calls to declare the operations it covers. */
export interface ApiCoverage {
  /**
   * Declare operations as `"METHOD /path"`, e.g. `"PUT /api/v2/files/{file_id}"`.
   *
   * Path parameters keep their `{name}` form — the declaration is a key into the
   * committed surface baseline, not a URL. Each declared operation MUST be issued
   * by the test, or its teardown fails naming it.
   */
  declare(operations: string[]): void;
}

/**
 * Where a test's coverage lands, for `npm run api:coverage` to aggregate.
 *
 * Deliberately NOT under `test-results/`: Playwright wipes its output directory
 * at the start of every run, and the `@destructive` lane is by definition a
 * second run — measured, the destructive pass deleted the normal pass's records
 * and the report read 3/204 where the truth was 15. Records therefore accumulate
 * across runs, and the report drops any whose spec file no longer exists so a
 * renamed or deleted test cannot keep holding coverage.
 *
 * Git-ignored: it is per-machine measurement, not an artifact.
 */
export const COVERAGE_DIR = path.join(__dirname, "../../.api-coverage");

const VERBS = ["get", "post", "put", "patch", "delete", "head", "fetch"] as const;

/**
 * Patch the context so every call is keyed and kept, and hand back the
 * declaration surface plus the live arrays the teardown reads.
 *
 * The wrapper records **before** delegating, so a request that throws still
 * counts as an attempt at the operation. The alternative fails the test twice —
 * once on the connection, once on an unfulfilled declaration — with the second
 * message burying the first.
 */
export function installApiCoverage(request: APIRequestContext): {
  coverage: ApiCoverage;
  recorded: RecordedRequest[];
  declared: string[];
} {
  const recorded: RecordedRequest[] = [];
  const declared: string[] = [];
  const target = request as unknown as Record<string, unknown>;

  for (const verb of VERBS) {
    const original = target[verb];
    if (typeof original !== "function") continue;
    const fallbackMethod = verb === "fetch" ? "GET" : verb.toUpperCase();
    target[verb] = function patched(
      this: unknown,
      url: unknown,
      options?: { method?: string },
    ) {
      // `request.fetch(url, { method })` is how a spec sends a DELETE with a
      // body — which is what the batch operations need.
      const method = options?.method ?? fallbackMethod;
      const entry =
        typeof url === "string" ? recordFromUrl(method, url) : null;
      if (entry) recorded.push(entry);
      return (original as (...args: unknown[]) => unknown).call(
        this,
        url,
        options,
      );
    };
  }

  const coverage: ApiCoverage = {
    declare(operations: string[]): void {
      const defect = describeDeclarationDefect(operations);
      if (defect) {
        throw new Error(`invalid API coverage declaration — ${defect}`);
      }
      for (const op of operations) {
        const trimmed = op.trim();
        if (declared.includes(trimmed)) {
          throw new Error(
            `invalid API coverage declaration — "${trimmed}" is declared twice in this test`,
          );
        }
        declared.push(trimmed);
      }
    },
  };

  return { coverage, recorded, declared };
}

/**
 * The teardown verdict: an Error naming every declaration the test never issued,
 * or `null`.
 *
 * This is the load-bearing direction. A declaration nobody verifies is a
 * comment — and a comment that says "covered" is exactly how a gauge starts
 * lying (#1084's class of failure, and the reason
 * `page.expectKnownHttpError()` is checked both ways).
 */
export function coverageTeardownError(
  declared: string[],
  recorded: RecordedRequest[],
): Error | null {
  const missing = unfulfilledDeclarations(declared, recorded);
  if (missing.length === 0) return null;
  return new Error(
    `${missing.length} declared API operation(s) were never issued by this test:\n` +
      missing.map((op) => `  - ${op}`).join("\n") +
      `\n\nEither the test stopped driving the operation, or the declaration was\n` +
      `aspirational. Both make the coverage report claim something no assertion\n` +
      `backs, so fix one of the two — re-running changes nothing.`,
  );
}

export interface CoverageRecord {
  file: string;
  title: string;
  status: string;
  declared: string[];
  /** Declared AND issued AND the test passed. */
  covered: string[];
}

/**
 * The per-test artifact.
 *
 * A test that did not pass credits **nothing**: it proves nothing about the
 * contract it declared, and counting it would let a red spec hold coverage —
 * the unevaluated-is-not-clean rule (#1012), applied to the numerator.
 */
export function buildCoverageRecord(
  meta: { file: string; title: string; status: string },
  declared: string[],
  recorded: RecordedRequest[],
): CoverageRecord {
  const passed = meta.status === "passed";
  return {
    file: meta.file,
    title: meta.title,
    status: meta.status,
    declared: [...declared],
    covered: passed
      ? declared.filter((op) => recorded.some((req) => matchesOperation(op, req)))
      : [],
  };
}

/**
 * Persist one test's record for `npm run api:coverage`.
 *
 * `dir` is injectable so a unit test can assert the written content without
 * touching the real directory — record CONTENT is asserted there rather than in
 * the behavioural gate spec, because reading a record written by a sibling test
 * made those assertions serial-dependent, and a serial-dependent test fails in
 * isolation even unmutated, turning its force-fail into a false positive.
 */
export function writeCoverageRecord(
  testInfo: Pick<TestInfo, "testId" | "titlePath" | "status" | "file">,
  declared: string[],
  recorded: RecordedRequest[],
  dir: string = COVERAGE_DIR,
): void {
  if (declared.length === 0) return;
  const record = buildCoverageRecord(
    {
      file: path.relative(path.join(__dirname, "../.."), testInfo.file),
      title: testInfo.titlePath.slice(1).join(" › "),
      status: String(testInfo.status ?? "unknown"),
    },
    declared,
    recorded,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${testInfo.testId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch {
    // Reporting must never fail a spec that passed (#980). A missing record
    // shows up in the report as an uncovered operation, which is the safe
    // direction: it under-reports coverage rather than inventing it.
  }
}
