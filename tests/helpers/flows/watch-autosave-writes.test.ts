// Unit tests for watchAutosaveWrites (issue #1695).
// Run with: npm run test:units
//
// What this watcher exists to answer cannot be observed from the graph itself:
// when the persisted flow is behind the canvas, "the write failed" and "the
// write succeeded and an older one was committed after it" (#988) leave the
// SAME database row. Only the wire tells them apart, and the daily's own
// artifacts are the sole record of it — so a missed or mis-attributed write is
// invisible on a green run and is exactly what made #1695 read as a product
// defect. Hence assertions on which writes are recorded, per flow, rather than
// an E2E run that could only ever show the happy path.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { watchAutosaveWrites } from "./watch-autosave-writes";

const FLOW = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const BASE = "http://localhost:7860";

type Handler = (event: unknown) => void;

/** A Page stand-in exposing only the two events the watcher listens on. */
function fakePage() {
  const handlers = new Map<string, Set<Handler>>();
  const page = {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return {
    page: page as unknown as Page,
    get listeners() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    failed(method: string, url: string, errorText: string) {
      emit("requestfailed", {
        method: () => method,
        url: () => url,
        failure: () => ({ errorText }),
      });
    },
    requested(method: string, url: string) {
      emit("request", { method: () => method, url: () => url });
    },
    responded(method: string, url: string, status: number, statusText: string) {
      emit("response", {
        status: () => status,
        statusText: () => statusText,
        ok: () => status >= 200 && status < 300,
        request: () => ({ method: () => method, url: () => url }),
      });
    },
  };
}

test("records an autosave PATCH that never reached the backend", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.failed("PATCH", `${BASE}/api/v1/flows/${FLOW}`, "net::ERR_CONNECTION_RESET");

  assert.deepEqual(watcher.evidence().failures, [
    `PATCH /api/v1/flows/${FLOW} → net::ERR_CONNECTION_RESET`,
  ]);
});

test("records an autosave PATCH answered with a non-2xx status", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.responded("PATCH", `${BASE}/api/v1/flows/${FLOW}`, 500, "Internal Server Error");

  assert.deepEqual(watcher.evidence().failures, [
    `PATCH /api/v1/flows/${FLOW} → 500 Internal Server Error`,
  ]);
});

test("a successful autosave is not a failure", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.responded("PATCH", `${BASE}/api/v1/flows/${FLOW}`, 200, "OK");

  assert.deepEqual(watcher.evidence().failures, []);
});

test("a failed write for ANOTHER flow is ignored", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.failed("PATCH", `${BASE}/api/v1/flows/${OTHER}`, "net::ERR_CONNECTION_RESET");
  fake.responded("PATCH", `${BASE}/api/v1/flows/${OTHER}`, 500, "Internal Server Error");

  assert.deepEqual(
    watcher.evidence().failures,
    [],
    "workers share a backend — attributing another flow's write here would blame this flow for a neighbour's outage",
  );
});

test("only writes count — the cleanup DELETE and the gate's own GET are not autosaves", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.responded("GET", `${BASE}/api/v1/flows/${FLOW}`, 502, "Bad Gateway");
  fake.failed("DELETE", `${BASE}/api/v1/flows/${FLOW}`, "net::ERR_CONNECTION_RESET");

  assert.deepEqual(watcher.evidence().failures, []);
});

test("a query string on the write URL does not hide it", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.responded("PATCH", `${BASE}/api/v1/flows/${FLOW}?flow_id=${FLOW}`, 503, "Service Unavailable");

  assert.deepEqual(watcher.evidence().failures, [
    `PATCH /api/v1/flows/${FLOW} → 503 Service Unavailable`,
  ]);
});

test("failures are reported oldest first and the array cannot be mutated from outside", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.responded("PATCH", `${BASE}/api/v1/flows/${FLOW}`, 500, "Internal Server Error");
  fake.failed("PATCH", `${BASE}/api/v1/flows/${FLOW}`, "socket hang up");

  const snapshot = watcher.evidence().failures;
  assert.deepEqual(snapshot, [
    `PATCH /api/v1/flows/${FLOW} → 500 Internal Server Error`,
    `PATCH /api/v1/flows/${FLOW} → socket hang up`,
  ]);

  snapshot.push("not a real failure");
  assert.equal(watcher.evidence().failures.length, 2);
});

test("dispose() detaches both listeners and stops recording", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);
  assert.equal(fake.listeners, 3, "one request, one response and one requestfailed listener");

  watcher.dispose();
  assert.equal(fake.listeners, 0);

  fake.failed("PATCH", `${BASE}/api/v1/flows/${FLOW}`, "socket hang up");
  assert.deepEqual(
    watcher.evidence().failures,
    [],
    "24 specs go through this helper — a listener left attached leaks into every later test in the worker",
  );
});

test("dispose() is safe to call twice", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  watcher.dispose();
  watcher.dispose();

  assert.equal(fake.listeners, 0);
});

// --- the in-flight distinction (#1695) ----------------------------------
//
// The first version of this watcher reported only failures, and the caller read
// "no failures" as "every write answered 2xx". A frozen backend refutes that:
// the PATCH is ISSUED and then hangs, so it neither fails nor answers, and the
// gate went on to blame #988 — a race between two writes that had both
// completed — for a wedge in which none had. Absence of failure is three states,
// not two, and only one of them is evidence for #988.

test("a write that was issued and never answered is counted as in flight", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.requested("PATCH", `${BASE}/api/v1/flows/${FLOW}`);

  const evidence = watcher.evidence();
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.issued, 1);
  assert.equal(evidence.settled, 0);
});

test("a write that answered is settled, not in flight", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.requested("PATCH", `${BASE}/api/v1/flows/${FLOW}`);
  fake.responded("PATCH", `${BASE}/api/v1/flows/${FLOW}`, 200, "OK");

  const evidence = watcher.evidence();
  assert.equal(evidence.issued, 1);
  assert.equal(evidence.settled, 1);
});

test("a write that failed is settled too — it is not still pending", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.requested("PATCH", `${BASE}/api/v1/flows/${FLOW}`);
  fake.failed("PATCH", `${BASE}/api/v1/flows/${FLOW}`, "socket hang up");

  const evidence = watcher.evidence();
  assert.equal(evidence.issued, 1);
  assert.equal(evidence.settled, 1);
  assert.equal(evidence.failures.length, 1);
});

test("a flow with no autosave at all reports zero issued", () => {
  const fake = fakePage();
  const watcher = watchAutosaveWrites(fake.page, FLOW);

  fake.requested("GET", `${BASE}/api/v1/flows/${FLOW}`);
  fake.requested("PATCH", `${BASE}/api/v1/flows/${OTHER}`);

  assert.equal(watcher.evidence().issued, 0);
});
