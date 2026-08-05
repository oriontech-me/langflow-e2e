// Unit tests for the shared flow-cleanup tracker (issue #1108).
// Run with: npm run test:units
//
// What rides on this helper: it is the only thing standing between the suite and a
// database that accumulates every flow every test creates. A defect here surfaces
// as someone else's random failure — a `/flows` list slow enough to time out, a
// name-scoped lookup matching a leftover — never as a failing test of its own,
// which is exactly the class `CONTRIBUTING.md` → *Unit tests* says to cover here.
//
// The four behaviours these tests pin are the four axes on which the 51 hand-copied
// versions had drifted. Each one is a real leak or a real silence:
//
//   1. bodies are settled before cleanup — 50 of the 51 copies dropped an id that
//      resolved a tick late, and the last test in a worker has no later hook;
//   2. the URL match is the exact creation endpoint — `/flows/batch/` and
//      `/flows/upload/` also answer 201;
//   3. the page leaves the canvas BEFORE the delete — a mounted editor 404s on the
//      flow it is polling (#1023/#1103);
//   4. a failed delete is reported, not swallowed — the copies that wrote
//      `.catch(() => {})` buried the one signal `deleteFlow` exists to raise. That
//      axis is three-way, though (swallow / log / throw), and no count for it is
//      restated here — see the implementation's header. `{ strict: true }` is what
//      keeps a spec that used to FAIL on a failed cleanup failing.
//
// The fakes below are the whole point of the narrow `TrackedPage` /
// `TrackedResponse` types: the tracker drives real `deleteFlow` and real
// `getAuthToken` against a fake `APIRequestContext`, so the integration is covered
// without a browser or a backend.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import {
  flowIdFrom,
  isFlowCreateUrl,
  trackCreatedFlows,
  type TrackedPage,
  type TrackedResponse,
} from "./track-created-flows";
import { resetAttributedFlows } from "./token-attribution";

// One mechanism, not two (round-1 review): a per-test reset line is a line
// someone forgets when adding test number ten, and a test reusing an
// already-claimed flow id becomes a silent no-op that stays green, because the
// guard's short-circuit produces a result byte-identical to what the test
// already expected. `token-attribution.test.ts` and `delete-flow.test.ts` both
// made this same fix; this converts to the identical single-`beforeEach` shape
// rather than repeating the per-test line.
beforeEach(() => {
  resetAttributedFlows();
});

const BASE = "http://localhost:7860";

/** A `page` that records what the tracker does to it. */
function fakePage() {
  let listener: ((response: TrackedResponse) => void) | undefined;
  const navigations: string[] = [];
  let detached = false;
  const page = {
    on: (event: string, fn: unknown) => {
      if (event === "response") listener = fn as typeof listener;
      return page;
    },
    off: (event: string, fn: unknown) => {
      if (event === "response" && fn === listener) detached = true;
      return page;
    },
    goto: async (url: string) => {
      navigations.push(url);
      return null;
    },
  };
  return {
    page: page as unknown as TrackedPage,
    navigations,
    isDetached: () => detached,
    emit: (response: TrackedResponse) => listener?.(response),
  };
}

/** A 201 response for `POST /api/v1/flows/`, with a controllable body delay. */
function creationResponse(
  id: string | undefined,
  {
    url = `${BASE}/api/v1/flows/`,
    method = "POST",
    status = 201,
    delayTicks = 0,
    body,
  }: {
    url?: string;
    method?: string;
    status?: number;
    delayTicks?: number;
    body?: unknown;
  } = {},
): TrackedResponse {
  return {
    url: () => url,
    status: () => status,
    statusText: () => (status === 201 ? "Created" : "Internal Server Error"),
    request: () => ({ method: () => method }),
    json: async () => {
      for (let i = 0; i < delayTicks; i++) await Promise.resolve();
      return body !== undefined ? body : { id };
    },
  };
}

/** A `request` that answers auto_login and records the DELETEs it receives. */
function fakeRequest({
  failFor = new Set<string>(),
  status = 500,
  token = "tok-123",
}: { failFor?: Set<string>; status?: number; token?: string | null } = {}) {
  const deletes: Array<{ url: string; auth?: string }> = [];
  const request = {
    get: async (url: string) => {
      assert.equal(url, "/api/v1/auto_login", "the tracker must not call other GETs");
      return {
        ok: () => token !== null,
        status: () => (token === null ? 500 : 200),
        json: async () => ({ access_token: token }),
      };
    },
    delete: async (url: string, options?: { headers?: Record<string, string> }) => {
      deletes.push({ url, auth: options?.headers?.Authorization });
      const id = url.split("/").pop() ?? "";
      const failed = failFor.has(id);
      return {
        ok: () => !failed,
        status: () => (failed ? status : 204),
        statusText: () => (failed ? "Server Error" : "No Content"),
        text: async () => (failed ? "boom" : ""),
      };
    },
  };
  return { request: request as unknown as APIRequestContext, deletes };
}

// ─── The URL match (axis 2) ──────────────────────────────────────────────────

test("only the exact creation endpoint is a flow creation", () => {
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows/`), true);
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows`), true);
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows/?folder_id=x`), true, "a query string is not part of the path");
  // These answer 201 too, with a list body carrying no top-level id.
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows/batch/`), false);
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows/upload/`), false);
  assert.equal(isFlowCreateUrl(`${BASE}/api/v1/flows/abc-123`), false);
  assert.equal(isFlowCreateUrl("not a url"), false);
});

test("a body without a usable id yields no id", () => {
  assert.equal(flowIdFrom({ id: "abc" }), "abc");
  for (const body of [undefined, null, {}, { id: "" }, { id: 7 }, [{ id: "a" }]]) {
    assert.equal(flowIdFrom(body), undefined, `unexpected id for ${JSON.stringify(body)}`);
  }
});

// ─── Capture ─────────────────────────────────────────────────────────────────

test("captures the created flow ids, ignoring everything else", async () => {
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);

  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-2"));
  emit(creationResponse("ignored", { method: "GET" }));
  emit(creationResponse("ignored", { url: `${BASE}/api/v1/flows/batch/` }));
  emit(creationResponse("ignored", { status: 200 }));
  await flows.settle();

  assert.deepEqual(flows.ids(), ["flow-1", "flow-2"]);
});

test("the same id observed twice is captured once", async () => {
  // A replayed or redirected response would otherwise queue two DELETEs; the
  // second one 404s, which `deleteFlow` treats as done — hiding a real double
  // creation behind noise instead of surfacing it.
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-1"));
  await flows.settle();
  assert.deepEqual(flows.ids(), ["flow-1"]);
});

test("a failed creation POST is recorded synchronously, without its body", async () => {
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit(creationResponse(undefined, { status: 500 }));
  // No settle: the point is that this is available immediately, before the setup
  // step that consults it (#1114).
  assert.deepEqual(flows.failedCreations(), ["500 Internal Server Error"]);
  assert.deepEqual(flows.ids(), []);
});

// ─── Axis 1: settle before cleanup — the permanent-leak case ─────────────────

test("cleanup settles a body that resolves AFTER teardown starts", async () => {
  // The defect in 50 of the 51 copies: `resp.json()` resolves a tick later, so an
  // id could land after `afterEach` had already read the array — and the flow leaks
  // for good, because the last test in a worker has no later hook.
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest();
  const flows = trackCreatedFlows(page);

  emit(creationResponse("slow-flow", { delayTicks: 5 }));
  assert.deepEqual(flows.ids(), [], "precondition: the id has not landed yet");

  const result = await flows.cleanup(request);
  assert.deepEqual(result.deleted, ["slow-flow"]);
  assert.deepEqual(
    deletes.map((d) => d.url),
    ["/api/v1/flows/slow-flow"],
  );
});

// ─── Axis 3: leave the canvas before deleting ───────────────────────────────

test("navigates to about:blank BEFORE issuing any delete", async () => {
  const { page, emit, navigations } = fakePage();
  const flows = trackCreatedFlows(page);
  const order: string[] = [];
  const request = {
    get: async () => ({ ok: () => true, status: () => 200, json: async () => ({ access_token: "t" }) }),
    delete: async (url: string) => {
      order.push(`delete:${url}`);
      return { ok: () => true, status: () => 204, statusText: () => "", text: async () => "" };
    },
  } as unknown as APIRequestContext;

  const trackedPage = page as unknown as { goto: (url: string) => Promise<null> };
  const originalGoto = trackedPage.goto.bind(trackedPage);
  trackedPage.goto = async (url: string) => {
    order.push(`goto:${url}`);
    return originalGoto(url);
  };

  emit(creationResponse("flow-1"));
  await flows.cleanup(request);

  assert.deepEqual(navigations, ["about:blank"]);
  assert.deepEqual(order, ["goto:about:blank", "delete:/api/v1/flows/flow-1"]);
});

test("nothing was created, so nothing is navigated away from", async () => {
  const { page, navigations } = fakePage();
  const { request, deletes } = fakeRequest();
  const result = await trackCreatedFlows(page).cleanup(request);
  assert.deepEqual(result, { deleted: [], failed: [] });
  assert.deepEqual(navigations, [], "a teardown with no flows must add no navigation");
  assert.deepEqual(deletes, [], "and no auth call or DELETE");
});

test("a failed unmount still deletes every flow, and is reported rather than swallowed", async () => {
  // Issue #1288. What THIS test owns is that a failed unmount does not cost the
  // deletes: letting the failure propagate would abort the teardown before them,
  // and since `captured` has already been taken out of the tracker by then, those
  // flows would be neither deleted nor tracked — a permanent leak, for a navigation
  // whose only job was to reduce log noise. The warning itself, and the shape of
  // the message, belong to `unmount-editor-for-cleanup.test.ts`, which is where the
  // `console.warn` is asserted (a review of #1289 deleted that warn and the whole
  // lane stayed green — hence a test that pins it, once, next to its code).
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest();
  const trackedPage = page as unknown as { goto: (url: string) => Promise<null> };
  trackedPage.goto = async () => {
    throw new Error("net::ERR_ABORTED at http://localhost:7860/\nsecond line dropped");
  };

  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-2"));
  const result = await flows.cleanup(request);

  // The load-bearing half ran regardless.
  assert.deepEqual(result.deleted, ["flow-1", "flow-2"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    deletes.map((d) => d.url),
    ["/api/v1/flows/flow-1", "/api/v1/flows/flow-2"],
  );

  // And the failure is visible on the result, the way `authError` is — first line
  // only, so a multi-line Playwright error stays one readable line.
  assert.match(String(result.unmountError), /ERR_ABORTED/);
  assert.ok(
    !String(result.unmountError).includes("second line dropped"),
    "only the first line of the error is carried",
  );
});

// ─── Axis 4: a failed delete is reported, never swallowed ───────────────────

test("a failed delete is reported and does not stop the other deletes", async () => {
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest({ failFor: new Set(["flow-2"]), status: 403 });
  const flows = trackCreatedFlows(page);

  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-2"));
  emit(creationResponse("flow-3"));
  const result = await flows.cleanup(request);

  assert.deepEqual(result.deleted, ["flow-1", "flow-3"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "flow-2");
  assert.match(result.failed[0].error, /403/);
  assert.equal(deletes.length, 3, "one failure must not abort the sweep");
});

test("cleanup never throws, so it cannot fail an otherwise-green test", async () => {
  const { page, emit } = fakePage();
  const { request } = fakeRequest({ failFor: new Set(["flow-1"]), status: 422 });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  await flows.cleanup(request); // must not reject
});

// ─── Auth, idempotence, lifecycle ───────────────────────────────────────────

test("the delete carries the bearer token, not just browser cookies", async () => {
  // `page.request` alone answers 401 on the flows API — the reason every copy
  // fetched a token in its teardown.
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest({ token: "abc" });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  await flows.cleanup(request);
  assert.equal(deletes[0].auth, "Bearer abc");
});

test("a second cleanup is a no-op instead of a second round of deletes", async () => {
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  await flows.cleanup(request);
  await flows.cleanup(request);
  assert.equal(deletes.length, 1);
});

test("reset clears both lists for the next test", async () => {
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  emit(creationResponse(undefined, { status: 500 }));
  await flows.settle();
  flows.reset();
  assert.deepEqual(flows.ids(), []);
  assert.deepEqual(flows.failedCreations(), []);
});

test("dispose detaches the listener it attached", () => {
  const { page, isDetached } = fakePage();
  trackCreatedFlows(page).dispose();
  assert.equal(isDetached(), true);
});

// ─── strict mode: the third shape of the failed-delete axis ─────────────────

test("strict re-throws a failed delete, for a spec whose teardown used to fail", () => {
  // 13 of the 51 copies let `deleteFlow` throw, which fails the teardown — the
  // strongest of the three signals, and chosen deliberately in some files
  // ("Cleanup is load-bearing here … so the throw is intentionally NOT swallowed").
  // Migrating one of those onto the default would trade a red test for a warning
  // line nothing asserts on.
  const { page, emit } = fakePage();
  const { request } = fakeRequest({ failFor: new Set(["flow-1"]), status: 422 });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  return assert.rejects(() => flows.cleanup(request, { strict: true }), /422/);
});

test("strict still logs and records before re-throwing", async () => {
  const { page, emit } = fakePage();
  const { request } = fakeRequest({ failFor: new Set(["flow-1"]), status: 422 });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  await flows.cleanup(request, { strict: true }).catch(() => {});
  // The captured id is cleared either way, so a retried teardown does not re-delete.
  assert.deepEqual(flows.ids(), []);
});

test("strict finishes the sweep BEFORE throwing, so nothing leaks behind the throw", async () => {
  // The captured ids are taken out of the tracker at the top of `cleanup`, so a throw
  // on the FIRST failure leaves the rest neither deleted nor tracked — a permanent
  // leak in the mode whose entire premise is that cleanup is load-bearing. Every id
  // must be attempted; the failure is raised afterwards.
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest({ failFor: new Set(["flow-1"]), status: 422 });
  const flows = trackCreatedFlows(page);

  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-2"));
  emit(creationResponse("flow-3"));

  await assert.rejects(() => flows.cleanup(request, { strict: true }), /422/);
  assert.deepEqual(
    deletes.map((d) => d.url),
    [
      "/api/v1/flows/flow-1",
      "/api/v1/flows/flow-2",
      "/api/v1/flows/flow-3",
    ],
    "the two flows after the failing one must still be deleted",
  );
});

test("strict aggregates when more than one delete fails, naming every id", async () => {
  const { page, emit } = fakePage();
  const { request } = fakeRequest({ failFor: new Set(["flow-1", "flow-3"]), status: 403 });
  const flows = trackCreatedFlows(page);

  emit(creationResponse("flow-1"));
  emit(creationResponse("flow-2"));
  emit(creationResponse("flow-3"));

  await assert.rejects(
    () => flows.cleanup(request, { strict: true }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, "several failures aggregate");
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /flow-1/);
      assert.match(error.message, /flow-3/);
      return true;
    },
  );
});

test("strict is opt-in — the default never throws", async () => {
  const { page, emit } = fakePage();
  const { request } = fakeRequest({ failFor: new Set(["flow-1"]), status: 422 });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  const result = await flows.cleanup(request); // must not reject
  assert.equal(result.failed.length, 1);
});

// ─── An unobtainable token is named, not silently degraded ──────────────────

test("a getAuthToken failure is reported as itself, not as a flow problem", async () => {
  // `get-auth-token.ts` forbids degrading into the empty-token fallback (#1086):
  // callers would carry on unauthenticated and fail somewhere far less diagnosable.
  // `cleanup` still may not throw, so the failure has to be NAMED on the result —
  // otherwise a backend wedged during teardown (#1077) produces one 401 per flow and
  // a report that blames the flows.
  //
  // `authRetryDelaysMs: []` for the reason the option exists: `getAuthToken` retries a
  // THROWN request on the real `[2000, 8000, 20000]` backoff, so without it this one
  // test sleeps 30 s and becomes the critical path of a lane that gates every PR.
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  const request = {
    get: async () => {
      throw new Error("apiRequestContext.get: Timeout 20000ms exceeded.");
    },
    delete: async () => ({
      ok: () => false,
      status: () => 401,
      statusText: () => "Unauthorized",
      text: async () => "",
    }),
  } as unknown as APIRequestContext;

  emit(creationResponse("flow-1"));
  const result = await flows.cleanup(request, { authRetryDelaysMs: [] });

  assert.match(String(result.authError), /Timeout 20000ms/);
  assert.equal(result.failed.length, 1, "the delete was still attempted");
});

test("the auth backoff is getAuthToken's own unless a test overrides it", async () => {
  // The override must stay opt-in: a spec that does not pass it has to keep the full
  // budget, which is what survives a backend wedged during teardown (#1077).
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  let attempts = 0;
  const request = {
    get: async () => {
      attempts++;
      throw new Error("apiRequestContext.get: Timeout 20000ms exceeded.");
    },
    delete: async () => ({
      ok: () => true,
      status: () => 204,
      statusText: () => "No Content",
      text: async () => "",
    }),
  } as unknown as APIRequestContext;

  emit(creationResponse("flow-1"));
  await flows.cleanup(request, { authRetryDelaysMs: [] });
  assert.equal(attempts, 1, "an empty budget means one attempt, no sleeping");
});

test("no token in an auth-less environment is not an auth ERROR", async () => {
  // `getAuthToken` RETURNS "" when the endpoint answers non-ok — that is an
  // environment without auth, not an outage, and it must not be reported as one.
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest({ token: null });
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  const result = await flows.cleanup(request);
  assert.equal(result.authError, undefined);
  assert.equal(deletes[0].auth, undefined, "no Authorization header is sent");
});

// ─── The remaining unpinned guards ──────────────────────────────────────────

test("a successful capture leaves failedCreations EMPTY", async () => {
  // `failedCreations()` is what a setup step reads to attribute its own failure
  // (#1114). A false positive there makes a spec blame a 5xx that never happened.
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  await flows.settle();
  assert.deepEqual(flows.failedCreations(), []);
});

test("a 4xx creation is recorded too, not only a 5xx", async () => {
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit({
    url: () => `${BASE}/api/v1/flows/`,
    status: () => 422,
    statusText: () => "Unprocessable Entity",
    request: () => ({ method: () => "POST" }),
    json: async () => ({}),
  });
  assert.deepEqual(flows.failedCreations(), ["422 Unprocessable Entity"]);
});

test("failedCreations hands out a copy, not the live array", async () => {
  const { page, emit } = fakePage();
  const flows = trackCreatedFlows(page);
  emit(creationResponse(undefined, { status: 500 }));
  flows.failedCreations().push("injected");
  assert.deepEqual(flows.failedCreations(), ["500 Internal Server Error"]);
});

test("a page that is already gone does not break the teardown", async () => {
  // The teardown-after-crash path: `page.goto` on a closed page REJECTS.
  const { page, emit } = fakePage();
  (page as unknown as { goto: () => Promise<never> }).goto = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  const { request, deletes } = fakeRequest();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1"));
  const result = await flows.cleanup(request);
  assert.deepEqual(result.deleted, ["flow-1"], "the delete must still happen");
  assert.equal(deletes.length, 1);
});

test("a body that cannot be parsed drops that id instead of breaking the sweep", async () => {
  const { page, emit } = fakePage();
  const { request } = fakeRequest();
  const flows = trackCreatedFlows(page);
  emit({
    url: () => `${BASE}/api/v1/flows/`,
    status: () => 201,
    statusText: () => "Created",
    request: () => ({ method: () => "POST" }),
    json: async () => {
      throw new Error("Response body is unavailable for redirect responses");
    },
  });
  emit(creationResponse("flow-2"));
  const result = await flows.cleanup(request);
  assert.deepEqual(result.deleted, ["flow-2"]);
});

test("settle() drains the queue, so a later cleanup does not re-await it", async () => {
  const { page, emit } = fakePage();
  const { request, deletes } = fakeRequest();
  const flows = trackCreatedFlows(page);
  emit(creationResponse("flow-1", { delayTicks: 3 }));
  await flows.settle();
  assert.deepEqual(flows.ids(), ["flow-1"]);
  await flows.cleanup(request);
  assert.deepEqual(deletes.map((d) => d.url), ["/api/v1/flows/flow-1"]);
});

// ─── Token attribution sidecar (#1197) ───────────────────────────────────────

test("cleanup records token attribution BEFORE deleting", async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-attrib-")), "a.jsonl");
  const order: string[] = [];
  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();

  const request = {
    get: async (url: string) => {
      order.push(`GET ${url.split("?")[0]}`);
      return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1" }] }) };
    },
    delete: async (url: string) => {
      order.push(`DELETE ${url}`);
      return { ok: () => true, status: () => 200, json: async () => ({}) };
    },
  } as unknown as APIRequestContext;

  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);

  const result = await tracker.cleanup(request, {
    attribution: { test: "agent suite", file: "x.spec.ts" },
  });

  assert.equal(result.attribution?.recorded, 1);
  const traceIndex = order.findIndex((o) => o.includes("/monitor/traces"));
  const deleteIndex = order.findIndex((o) => o.startsWith("DELETE"));
  // The whole point: the trace is read while the flow still exists.
  assert.ok(traceIndex >= 0 && traceIndex < deleteIndex);
  assert.deepEqual(result.deleted, ["f1"]);
});

test("with neither an explicit attribution NOR an ambient test, nothing is attributed", async () => {
  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();
  let sawTraceCall = false;
  const request = {
    get: async (url: string) => {
      if (url.includes("/monitor/traces")) sawTraceCall = true;
      return { ok: () => true, status: () => 200, json: async () => ({}) };
    },
    delete: async () => ({ ok: () => true, status: () => 200, json: async () => ({}) }),
  } as unknown as APIRequestContext;
  // Explicit about WHY nothing is derived, so this stays a real assertion rather
  // than an accident of the lane: under `node --test` there is no Playwright test
  // running, so `test.info()` throws and the resolver returns null. Passing `info`
  // is what the tests below use to simulate a real spec.
  const result = await tracker.cleanup(request, {
    info: () => {
      throw new Error("test.info() can only be called while test is running");
    },
  });
  assert.equal(sawTraceCall, false);
  assert.equal(result.attribution, undefined);
  assert.deepEqual(result.deleted, ["f1"]);
});

test("a throwing attribution never fails the cleanup", async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-attrib-")), "a.jsonl");
  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();
  const request = {
    get: async (url: string) => {
      if (url.includes("/monitor/traces")) throw new Error("backend wedged");
      return { ok: () => true, status: () => 200, json: async () => ({}) };
    },
    delete: async () => ({ ok: () => true, status: () => 200, json: async () => ({}) }),
  } as unknown as APIRequestContext;
  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);
  const result = await tracker.cleanup(request, { attribution: { test: "t", file: "f" } });
  assert.equal(result.attribution?.skipped.length, 1);
  assert.deepEqual(result.deleted, ["f1"]);
});

test("the attribution GET carries the same bearer the deletes use, not just cookies", async (t) => {
  // Measured against a real Langflow (langflowai/langflow-nightly 1.12.0.dev10):
  // an unauthenticated `GET /monitor/traces` answers 403. Pinning this so the
  // sidecar cannot silently regress back to running on cookies alone.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-attrib-")), "a.jsonl");
  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();

  let tracesAuthHeader: string | undefined;
  const request = {
    get: async (url: string, options?: { headers?: Record<string, string> }) => {
      if (url === "/api/v1/auto_login") {
        return { ok: () => true, status: () => 200, json: async () => ({ access_token: "tok-abc" }) };
      }
      tracesAuthHeader = options?.headers?.Authorization;
      return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1" }] }) };
    },
    delete: async () => ({ ok: () => true, status: () => 200, json: async () => ({}) }),
  } as unknown as APIRequestContext;

  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);

  const result = await tracker.cleanup(request, { attribution: { test: "t", file: "f" } });

  assert.equal(tracesAuthHeader, "Bearer tok-abc");
  assert.equal(result.attribution?.recorded, 1);
});

// §1.1: the 30 specs using this helper pass no `attribution` today, and two of
// 180 pass one. Deriving it is what arms the other 28 without touching them.
test("cleanup() attributes without being asked, deriving from the ambient test (§1.1)", async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-derived-")), "a.jsonl");
  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);

  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();

  const request = {
    get: async (url: string) => {
      if (url.includes("auto_login")) {
        return { ok: () => true, status: () => 200, json: async () => ({ access_token: "tok" }) };
      }
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 42 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
    delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
  } as unknown as APIRequestContext;

  const result = await tracker.cleanup(request, {
    info: () => ({
      title: "derived, not passed",
      file: "/repo/tests/tests-automations/regression/y.spec.ts",
      project: { testDir: "/repo/tests" },
    }),
  });

  assert.equal(result.attribution?.recorded, 1);
  const line = JSON.parse(fs.readFileSync(out, "utf8").trim().split("\n")[0]);
  assert.equal(line.test, "derived, not passed");
  assert.equal(line.file, "tests-automations/regression/y.spec.ts");
});

// The two call sites that pass `attribution` explicitly must keep working
// unchanged, and an explicit value must WIN -- a spec with a reason to override
// still has one.
test("an explicit attribution still takes precedence over the derived one (§1.1)", async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-explicit-")), "a.jsonl");
  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);

  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();

  const request = {
    get: async (url: string) => {
      if (url.includes("auto_login")) {
        return { ok: () => true, status: () => 200, json: async () => ({ access_token: "tok" }) };
      }
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 42 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
    delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
  } as unknown as APIRequestContext;

  await tracker.cleanup(request, {
    attribution: { test: "explicit wins", file: "explicit.spec.ts" },
    info: () => ({ title: "derived loses", file: "/repo/tests/z.spec.ts", project: { testDir: "/repo/tests" } }),
  });

  const line = JSON.parse(fs.readFileSync(out, "utf8").trim().split("\n")[0]);
  assert.equal(line.test, "explicit wins");
  assert.equal(line.file, "explicit.spec.ts");
});

// THE test that matters most in this plan (§2.1). cleanup() attributes the batch
// and then calls deleteFlow per id, and deleteFlow now carries its own hook. One
// trace must produce ONE line -- a second would be a plausible number, twice as
// large, with nothing marking it.
test("one trace produces exactly one line, through cleanup AND deleteFlow (§2.1)", async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-once-")), "a.jsonl");
  process.env.TOKENS_ATTRIB = out;
  t.after(() => delete process.env.TOKENS_ATTRIB);

  const { page, emit } = fakePage();
  const tracker = trackCreatedFlows(page);
  emit(creationResponse("f1"));
  await tracker.settle();

  let listCalls = 0;
  const request = {
    get: async (url: string) => {
      if (url.includes("auto_login")) {
        return { ok: () => true, status: () => 200, json: async () => ({ access_token: "tok" }) };
      }
      if (url.includes("?flow_id=")) {
        listCalls += 1;
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 42 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
    delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
  } as unknown as APIRequestContext;

  await tracker.cleanup(request, {
    info: () => ({ title: "counted once", file: "/repo/tests/w.spec.ts", project: { testDir: "/repo/tests" } }),
  });

  const records = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lines = records.filter((r) => r.kind !== "attrib_cost");
  assert.equal(lines.length, 1, "cleanup's batch call and deleteFlow's per-id hook must not both record");
  // ONE cost record, on the real tracked path (§4.3, fix round 3). Both calls happen —
  // cleanup() attributes the captured batch, then deleteFlow re-calls per id — but the
  // second claims nothing, issues no request and costs approximately zero, so it writes
  // no record. This is what keeps `attrib_calls` counting teardowns that did work: with
  // a record per CALL, a 4-flow spec reported 5 calls for one teardown and the derived
  // average understated the real cost 5x.
  assert.equal(
    records.filter((r) => r.kind === "attrib_cost").length,
    1,
    "cleanup's batch call did the work; deleteFlow's repeat must not pad attrib_calls",
  );
  assert.equal(lines[0].total_tokens, 42);
  // And the request side of the same guarantee: one list request per flow, ever
  // (Global Constraints). Asserting only on the line count would pass even if the
  // second pass made the request and then discarded the result.
  assert.equal(listCalls, 1, "the flow's traces must be listed exactly once");
});
