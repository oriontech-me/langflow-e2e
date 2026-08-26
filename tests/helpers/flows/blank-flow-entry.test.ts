// Unit tests for the blank-flow entry point's stall handling (issue #1126).
// Run with: npm run test:units
//
// What rides on these functions: whether a `201`-without-navigation costs a
// month of coverage, and whether a wedged backend can be repaired into a green
// test.
//
// The failure they exist for cost `mcp-client-regression.spec.ts` its `@stable`
// on three dailies (2026-07-16, 2026-07-20, 2026-07-30) with the same call log —
// `waiting for navigation until "load"` and no `navigated to` line — and, because
// the file is `mode: "serial"`, also skipped the two tests after it on 07-30.
//
// Two properties are load-bearing and pull in opposite directions, which is why
// both are pinned here rather than left to the caller:
//
//  - the repair must be reachable ONLY when Langflow answered, so an outage can
//    never be turned into a pass (#1012);
//  - the abort must stay classifiable as infra, which it is not by virtue of a
//    prefix but by EMBEDDING the probe's own transport error — that embedded text
//    is what `scripts/lib/infra-signatures.ts` matches, and it is what keeps a
//    wedge out of the `@stable` auto-removal path (#1031).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import { entryBarrierMessage, INFRA_PREFIX } from "../other/page-entry-barrier";
import {
  BLANK_FLOW_ENTRY_SURFACE,
  FLOW_ROUTE_BUDGET_MS,
  MEASURED_ROUTE_P95_MS,
  REPAIR_MARKER,
  flowRouteStallVerdict,
  repairedEntryNotice,
} from "./blank-flow-entry";

const FLOW_ID = "0c5779ff-f5d8-4f4d-a5fc-a758c575a943";
const PROBE_URL = "http://localhost:7860/api/v1/version";

const CAUSE =
  "TimeoutError: page.waitForURL: Timeout 10000ms exceeded.\n" +
  "=========================== logs ===========================\n" +
  'waiting for navigation until "load"\n' +
  "============================================================";

const abortMessage = (probe: Parameters<typeof repairedEntryNotice>[0]["probe"]) =>
  entryBarrierMessage({
    selector: `URL /flow/${FLOW_ID}`,
    timeoutMs: FLOW_ROUTE_BUDGET_MS,
    probe,
    surface: BLANK_FLOW_ENTRY_SURFACE,
    cause: CAUSE,
  });

test("a backend that answered earns the repair", () => {
  assert.equal(
    flowRouteStallVerdict({ state: "healthy", ms: 12, status: 200, url: PROBE_URL }),
    "repair",
  );
});

test("every state that is not a healthy answer aborts instead of repairing", () => {
  // The asymmetry is the point: repairing against a backend we could not reach
  // would turn an outage into a green test.
  assert.equal(
    flowRouteStallVerdict({
      state: "unreachable",
      ms: 5001,
      url: PROBE_URL,
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    }),
    "abort",
  );
  assert.equal(
    flowRouteStallVerdict({ state: "http_error", ms: 8, status: 503, url: PROBE_URL }),
    "abort",
  );
  // UNKNOWN is the probe that could not run at all. It is not evidence of health.
  assert.equal(
    flowRouteStallVerdict({
      state: "unknown",
      ms: 1,
      url: PROBE_URL,
      detail: "probe could not run: Target page, context or browser has been closed",
    }),
    "abort",
  );
});

test("a wedged backend aborts with a message triage can classify as infra", () => {
  const msg = abortMessage({
    state: "unreachable",
    ms: 5001,
    url: PROBE_URL,
    detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
  });

  assert.ok(msg.startsWith(INFRA_PREFIX), `expected the infra prefix, got: ${msg}`);
  // Not the prefix that classifies it — the EMBEDDED transport error does.
  assert.equal(classifyInfraError(msg)?.id, "api-request-timeout");
  // The surface must be named, or the reader cannot tell WHICH entry broke.
  assert.match(msg, /blank-flow-entry barrier/);
  // The original Playwright log stays readable against the trace.
  assert.match(msg, /waiting for navigation until "load"/);
});

test("the abort names the flow it could not reach", () => {
  const msg = abortMessage({ state: "http_error", ms: 8, status: 503, url: PROBE_URL });
  assert.ok(msg.startsWith(INFRA_PREFIX));
  assert.match(msg, new RegExp(`URL /flow/${FLOW_ID}`));
  assert.match(msg, /HTTP 503/);
});

test("the repair notice carries everything an occurrence report needs", () => {
  const notice = repairedEntryNotice({
    flowId: FLOW_ID,
    budgetMs: FLOW_ROUTE_BUDGET_MS,
    probe: { state: "healthy", ms: 12, status: 200, url: PROBE_URL },
  });

  // The marker is the greppable contract against a daily's results[].stdout.
  assert.ok(notice.startsWith(REPAIR_MARKER), `notice must start with the marker: ${notice}`);
  assert.match(notice, new RegExp(`/flow/${FLOW_ID}`));
  assert.match(notice, new RegExp(`${FLOW_ROUTE_BUDGET_MS}ms`));
  assert.match(notice, /HTTP 200/);
  assert.match(notice, /#1126/);
  // It must say the 201 already happened — that is what separates this stall
  // from a creation that simply failed.
  assert.match(notice, /already answered 201/);
});

test("the repair notice is NOT an infra signature", () => {
  // It is not a failure at all; if it ever leaked into a failure message it must
  // not exempt that test from @stable auto-removal.
  const notice = repairedEntryNotice({
    flowId: FLOW_ID,
    budgetMs: FLOW_ROUTE_BUDGET_MS,
    probe: { state: "healthy", ms: 12, status: 200, url: PROBE_URL },
  });
  assert.equal(classifyInfraError(notice), null);
});

test("the route budget stays far above the measured p95", () => {
  // The repair must never be reachable merely because the wait was trimmed: at
  // 48/48 the route's p95 was 337ms, so anything under ~20x that would start
  // repairing healthy-but-loaded runs and hide the real rate of #1126.
  assert.ok(
    FLOW_ROUTE_BUDGET_MS >= 20 * MEASURED_ROUTE_P95_MS,
    `budget ${FLOW_ROUTE_BUDGET_MS}ms is not >= 20x the measured p95 (${MEASURED_ROUTE_P95_MS}ms)`,
  );
});
