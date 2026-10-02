// Unit tests for the page-entry barrier's attribution message (issue #1262).
// Run with: npm run test:units
//
// What rides on this function: the triage verdict a human reads off a red daily.
//
// On the 2026-08-04 daily (run 30901311395, shard 4), gunicorn logged
// `WORKER TIMEOUT (pid:37)` at 10:46:42 and SIGKILLed the worker; the backend
// was restarting from 10:47:01 to 10:48:33. Two retries of
// `language-model-regression.spec.ts` ran inside that window and both reported
//
//   TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
//     - waiting for locator('[data-testid="mainpage_title"]') to be visible
//
// which reads as "the app's main page never renders". Triage grouped the test
// into an entry-point cluster (#1262) on the strength of that string, away from
// the provider cluster it actually belonged to — and the same string on
// 2026-07-09/07-14 turned out to be a DIFFERENT observable (`text=built
// successfully`), so the "recurrent, same signature" premise was an artifact of
// the shared Playwright prefix.
//
// The barrier can therefore not just time out: it must say WHICH of the two
// states it observed, and it must never claim a clean backend it did not probe
// (#1012's rule — an unevaluated probe is unknown, not healthy).
import { test } from "node:test";
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  entryBarrierMessage,
  healthyVerdict,
  INFRA_PREFIX,
  LIVENESS_DOWN_MS,
  LIVENESS_MIN_OUTAGE_PROBES,
  PAGE_ENTRY_SURFACE,
  resolveProbeUrl,
  startLivenessSampler,
  summarizeWaitLiveness,
  waitForAttributedSelector,
  type LivenessSample,
} from "./page-entry-barrier";

const CAUSE =
  "TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.\n" +
  "Call log:\n" +
  '  - waiting for locator(\'[data-testid="mainpage_title"]\') to be visible';

const SELECTOR = '[data-testid="mainpage_title"]';

// Liveness samples as the sampler records them: `ok` is the recorder's notion of
// up — answered 2xx inside LIVENESS_DOWN_MS.
const ok = (ms: number): LivenessSample => ({ ok: true, ms });
const down = (ms = LIVENESS_DOWN_MS): LivenessSample => ({ ok: false, ms });

test("an unreachable backend is named as the cause, with the infra prefix", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: CAUSE,
  });

  assert.ok(
    msg.startsWith(INFRA_PREFIX),
    `expected the infra prefix so triage can classify it, got: ${msg}`,
  );
  assert.match(msg, /did not answer GET \/api\/v1\/version/);
  assert.match(msg, /apiRequestContext\.get: Timeout 5000ms exceeded\./);
  // The barrier that failed must still be identifiable, and the original
  // Playwright error must survive — the trace/screenshot is read against it.
  assert.match(msg, /mainpage_title/);
  assert.match(msg, /page\.waitForSelector: Timeout 30000ms exceeded/);
});

test("a non-2xx answer is reported as an application failure, not as the wedge", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "http_error",
      ms: 42,
      status: 502,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.ok(msg.startsWith(INFRA_PREFIX));
  assert.match(msg, /answered GET \/api\/v1\/version with HTTP 502/);
  // 502 is the backend failing to serve, which is still not this spec's fault —
  // but it must not be described as unreachable, because it answered.
  assert.doesNotMatch(msg, /did not answer/);
});

test("a backend that answered throughout the wait keeps the failure attributed to the UI", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "healthy",
      ms: 21,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    during: summarizeWaitLiveness([ok(12), ok(9), ok(15)]),
    cause: CAUSE,
  });

  // This is the case where the spec IS the right place to look, so the message
  // must NOT carry the infra prefix — otherwise a genuine entry-point
  // regression would be filed as an outage (and, once the prefix reaches
  // `scripts/lib/infra-signatures.ts`, would stop being quarantined at all).
  assert.ok(
    !msg.startsWith(INFRA_PREFIX),
    `a healthy probe must not be labelled infra, got: ${msg}`,
  );
  assert.match(msg, /answered GET \/api\/v1\/version with HTTP 200/);
  // Corroborated by the samples, so — and only so — the settled verdict stands.
  assert.match(msg.split("\n")[0], /this IS a product\/UI failure/);
});

test("a probe that could not run is reported as unknown, never as healthy", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "unknown",
      ms: 0,
      url: "http://localhost:7860/api/v1/version",
      detail: "probe threw: browser closed",
    },
    cause: CAUSE,
  });

  assert.match(msg, /could not be probed/);
  assert.match(msg, /probe threw: browser closed/);
  // Unknown must not be dressed up as either verdict.
  assert.doesNotMatch(msg, /answered GET/);
  assert.ok(
    !msg.startsWith(INFRA_PREFIX),
    "an unproven outage must not claim the infra prefix",
  );
});

test("the message names the barrier's own budget so a raised timeout is visible", () => {
  const msg = entryBarrierMessage({
    selector: '[id="new-project-btn"]',
    timeoutMs: 15000,
    probe: {
      state: "healthy",
      ms: 8,
      status: 200,
      url: "http://langflow:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.match(msg, /15000ms/);
  assert.match(msg, /new-project-btn/);
  assert.match(msg, /http:\/\/langflow:7860/);
});

// --- the `surface` label (#1265) --------------------------------------------
//
// The barrier stopped being home-page-only when the SAME ambiguity cost the same
// mis-triage one navigation later: `modelInputComponent.spec.ts` waited 30s for
// the component sidebar's `sidebar-search-input` with a bare `locator.waitFor`,
// timed out inside two measured shard-2 outages on the 2026-08-04 daily, and was
// filed as a test-local flake about the model selector — the surface the message
// named was neither the sidebar nor the backend.

test("the surface defaults to page-entry, so #1262's callers read identically", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: {
      state: "healthy",
      ms: 9,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });

  assert.match(msg, new RegExp(`^${PAGE_ENTRY_SURFACE} barrier `));
  // A blank label must not degrade into `" barrier"` — that is worse than the
  // default, because it names nothing while looking deliberate.
  const blank = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    surface: "   ",
    probe: {
      state: "healthy",
      ms: 9,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: CAUSE,
  });
  assert.match(blank, new RegExp(`^${PAGE_ENTRY_SURFACE} barrier `));
});

test("a named surface appears in the barrier line AND in the product verdict", () => {
  const msg = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "healthy",
      ms: 12,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause:
      "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n" +
      "  - waiting for getByTestId('sidebar-search-input') to be visible",
  });

  assert.match(msg, /^component-sidebar barrier "\[data-testid="sidebar-search-input"\]"/);
  // The verdict sentence is the one a reader acts on, so it must name the same
  // surface — "a product/UI failure at the page entry point" is what sent #1265
  // to the wrong cluster.
  assert.match(msg, /failure at the component-sidebar entry point/);
  assert.doesNotMatch(msg, new RegExp(`${PAGE_ENTRY_SURFACE} entry point`));
});

test("attribution is surface-independent: a wedge behind any barrier is infra", () => {
  const msg = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.",
  });

  // This is the whole point of #1265: `locator.waitFor: Timeout` can never join
  // `scripts/lib/infra-signatures.ts` (a real UI regression emits it too), so the
  // prefix is the only route by which a sidebar wait killed by a wedge becomes
  // classifiable — and it must not depend on which barrier reported it.
  assert.ok(
    msg.startsWith(INFRA_PREFIX),
    `a wedge behind a non-page-entry barrier must still be infra, got: ${msg}`,
  );
  assert.match(msg, /component-sidebar barrier/);
});

test("under a wedge the attributed message is classified by the EXISTING infra list", () => {
  // The payoff, asserted against the real classifier rather than described in a
  // comment. `locator.waitFor: Timeout` is not (and must not be) an infra
  // signature, so today's bare message is unclassifiable — the barrier embeds the
  // probe's own transport error, and THAT is what `infra-signatures.ts` already
  // matches. No entry has to be added there for a wedge-killed sidebar wait to
  // stop reading like a broken spec.
  const bare =
    "TimeoutError: locator.waitFor: Timeout 30000ms exceeded.\n" +
    "Call log:\n  - waiting for getByTestId('sidebar-search-input') to be visible";

  assert.equal(
    classifyInfraError(bare),
    null,
    "the bare Playwright message must stay unclassifiable — that is the problem",
  );

  const wedged = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "unreachable",
      ms: 5001,
      url: "http://localhost:7860/api/v1/version",
      // What a wedged backend actually produces: it accepts the connection and
      // never answers, so the probe times out (#922/#927).
      detail: "apiRequestContext.get: Timeout 5000ms exceeded.",
    },
    cause: bare,
  });
  assert.equal(classifyInfraError(wedged)?.id, "api-request-timeout");

  // And the healthy case must NOT become classifiable, or a real entry-point
  // regression would be exempted as an outage.
  const healthy = entryBarrierMessage({
    selector: '[data-testid="sidebar-search-input"]',
    timeoutMs: 30000,
    surface: "component-sidebar",
    probe: {
      state: "healthy",
      ms: 21,
      status: 200,
      url: "http://localhost:7860/api/v1/version",
    },
    cause: bare,
  });
  assert.equal(classifyInfraError(healthy), null);
});

test("the probed URL comes from the page's own origin, not from the environment", () => {
  const onLangflow = { url: () => "http://127.0.0.1:7861/flow/abc" } as any;
  const blank = { url: () => "about:blank" } as any;
  const previous = process.env.PLAYWRIGHT_BASE_URL;
  process.env.PLAYWRIGHT_BASE_URL = "http://localhost:7860";
  try {
    // The page IS the authority: a spec driving a Langflow on another port must
    // not be told the one named in the environment answered for it.
    assert.equal(
      resolveProbeUrl(onLangflow),
      "http://127.0.0.1:7861/api/v1/version",
    );
    // No page origin to read (about:blank) ⇒ fall back to the environment.
    assert.equal(resolveProbeUrl(blank), "http://localhost:7860/api/v1/version");
    // An explicit override wins over both (used by the force-fail harness).
    assert.equal(
      resolveProbeUrl(onLangflow, "http://127.0.0.1:9"),
      "http://127.0.0.1:9/api/v1/version",
    );
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
    else process.env.PLAYWRIGHT_BASE_URL = previous;
  }
});

// --- liveness DURING the wait (#1549) ---------------------------------------
//
// The probe above runs once, AFTER the wait's budget is spent. Measured against
// the in-run liveness recorder (#1030) that was not an edge case: 23 occurrences
// of the healthy-probe verdict over 8 dailies (2026-08-05 → 09-03), every one on
// a day with a measured mid-run wedge, and attempts sitting 72–93 % inside an
// outage window still wrote "the backend was reachable and this IS a product/UI
// failure" — because the worker had restarted by the time the probe ran. The
// 2026-09-03 case is the clearest: 7 of the 9 recorder probes in that attempt's
// window failed, and the barrier's one probe answered 200 in 93 ms.
//
// So the barrier now samples liveness WHILE it waits, with the recorder's own
// definitions, and the healthy verdict has three states instead of one. The
// prefix rules above are untouched: none of the three carries INFRA_PREFIX, so
// nothing here widens which failures are exempt from `@stable` auto-removal.

const HEALTHY = {
  state: "healthy" as const,
  ms: 347,
  status: 200,
  url: "http://localhost:7860/api/v1/version",
};

const lineOne = (msg: string) => msg.split("\n")[0];

test("the wait's samples are summarised the way the recorder counts an outage", () => {
  const s = summarizeWaitLiveness([ok(8), down(), down(), ok(1023), down(), ok(31)]);
  assert.equal(s.samples, 6);
  assert.equal(s.failed, 3);
  // Two consecutive failures is the recorder's outage; the third is a blip.
  assert.equal(s.longestFailedRun, 2);
  assert.equal(s.slowestOkMs, 1023);

  const none = summarizeWaitLiveness([]);
  assert.deepEqual(none, { samples: 0, failed: 0, longestFailedRun: 0, slowestOkMs: 0 });
});

test("the verdict is corroborated only when the backend answered throughout", () => {
  assert.equal(healthyVerdict(HEALTHY, summarizeWaitLiveness([ok(8), ok(12)])), "corroborated");
  // An isolated failed probe is a blip by the recorder's definition (a floor of
  // the runner, ~24 a day), not an outage — it must not unsettle the verdict.
  assert.equal(
    healthyVerdict(HEALTHY, summarizeWaitLiveness([ok(8), down(), ok(12)])),
    "corroborated",
  );
  assert.equal(
    healthyVerdict(HEALTHY, summarizeWaitLiveness([down(), down(), ok(12)])),
    "degraded",
  );
});

test("a 200 the recorder would have counted as down does not corroborate (#1549 branch 5)", () => {
  // The recorder aborts its probe at LIVENESS_DOWN_MS and records it as an outage;
  // the barrier's own probe allows 5000 ms. A 4500 ms answer used to read
  // "healthy" here and "down" there, on the same backend, a second apart.
  const slow = { ...HEALTHY, ms: LIVENESS_DOWN_MS + 500 };
  assert.equal(healthyVerdict(slow, summarizeWaitLiveness([ok(8), ok(12)])), "degraded");
  assert.equal(healthyVerdict(slow, undefined), "degraded");
  assert.equal(
    healthyVerdict({ ...HEALTHY, ms: LIVENESS_DOWN_MS - 1 }, summarizeWaitLiveness([ok(8)])),
    "corroborated",
  );
});

test("nothing sampled during the wait is not a corroborated verdict (#1012)", () => {
  assert.equal(healthyVerdict(HEALTHY, undefined), "unsampled");
  assert.equal(healthyVerdict(HEALTHY, summarizeWaitLiveness([])), "unsampled");

  const msg = entryBarrierMessage({ selector: SELECTOR, timeoutMs: 30000, probe: HEALTHY, cause: CAUSE });
  assert.ok(!msg.startsWith(INFRA_PREFIX));
  assert.doesNotMatch(msg, /IS a product/);
  assert.match(lineOne(msg), /NOT shown to be a product\/UI failure/);
});

test("a wedge that clears before the probe runs is reported as degraded, not as a UI failure", () => {
  // The case this issue is about: the backend is down for most of the wait, the
  // worker restarts, and the after-the-fact probe answers 200.
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: HEALTHY,
    during: summarizeWaitLiveness([down(), down(), down(), down(), down(), down(), down(), ok(40), ok(12)]),
    cause: CAUSE,
  });

  assert.doesNotMatch(msg, /IS a product/);
  assert.match(lineOne(msg), /DEGRADED during the wait/);
  assert.match(msg, /7 of 9 liveness probe\(s\) during the wait failed/);
  // The final probe is still reported — it is what a reader compares against.
  assert.match(msg, /answered GET \/api\/v1\/version with HTTP 200 in 347ms/);
  // The prefix rule is unchanged: degraded is a doubt, not a proven outage, so
  // it must not be exempted from `@stable` auto-removal…
  assert.ok(!msg.startsWith(INFRA_PREFIX), `degraded must not claim the infra prefix, got: ${msg}`);
  // …and it must not become exempt by the back door either: the samples' own
  // transport errors would match `api-request-timeout` / `connection-dropped`,
  // which is why the message carries counts and never their text.
  assert.equal(classifyInfraError(msg), null);
});

test("a wait where no sample answered does not report a 0 ms slowest answer", () => {
  const msg = entryBarrierMessage({
    selector: SELECTOR,
    timeoutMs: 30000,
    probe: HEALTHY,
    during: summarizeWaitLiveness([down(), down(), down()]),
    cause: CAUSE,
  });
  assert.match(msg, /3 of 3 liveness probe\(s\) during the wait failed/);
  assert.match(msg, /none answered in time/);
  assert.doesNotMatch(msg, /took 0ms/);
});

test("line 1 carries no run-variable figure, so one cause can recur (#1549 facet 2)", () => {
  // `error_signature` is line 1, cut at 240 characters BEFORE the recurrence key
  // masks digits — so a latency of 347 ms and one of 1023 ms shifted the cut by a
  // character, and 23 occurrences of one message read as 4 distinct heads. The
  // varying figures now live on line 2.
  const at = (probe: typeof HEALTHY, samples: LivenessSample[]) =>
    lineOne(
      entryBarrierMessage({
        selector: SELECTOR,
        timeoutMs: 30000,
        probe,
        during: summarizeWaitLiveness(samples),
        cause: CAUSE,
      }),
    );

  assert.equal(
    at(HEALTHY, [down(), down(), ok(9)]),
    at({ ...HEALTHY, ms: 1023, url: "http://10.0.0.7:7870/api/v1/version" }, [down(), down(), down(), down(), ok(3442)]),
  );
  assert.equal(
    at(HEALTHY, [ok(8)]),
    at({ ...HEALTHY, ms: 93, url: "http://10.0.0.7:7870/api/v1/version" }, [ok(212), ok(9), ok(1629)]),
  );
  // And the verdicts stay distinct objects in the history — a degraded barrier
  // and a corroborated one are not the same failure (branch 4).
  assert.notEqual(at(HEALTHY, [down(), down()]), at(HEALTHY, [ok(8)]));
});

test("the verdict survives the history's 240-character cut on the home-page barrier", () => {
  for (const during of [[ok(8)], [down(), down()], undefined]) {
    const msg = entryBarrierMessage({
      selector: SELECTOR,
      timeoutMs: 30000,
      probe: HEALTHY,
      during: during && summarizeWaitLiveness(during),
      cause: CAUSE,
    });
    // What the appender stores: Playwright's `Error: ` prefix + line 1, sliced.
    const stored = `Error: ${lineOne(msg)}`.slice(0, 240);
    assert.match(stored, /(IS|NOT shown to be) a product\/UI failure at the page-entry entry point\.$/);
  }
});

test("the liveness thresholds agree with the in-run recorder's defaults", () => {
  // Two mechanisms that disagree on what "up" means by construction is how a
  // 4500 ms answer read as healthy here and as an outage in the same run's
  // `backend-liveness.jsonl`. Read from the recorder's source, which is plain ESM
  // the TypeScript unit lane cannot import.
  const src = fs.readFileSync(path.join(__dirname, "../../../scripts/watch-backend.mjs"), "utf8");
  const defaults = /const DEFAULTS = \{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
  assert.equal(Number(/timeoutMs:\s*(\d+)/.exec(defaults)?.[1]), LIVENESS_DOWN_MS);
  assert.equal(Number(/minProbes:\s*(\d+)/.exec(defaults)?.[1]), LIVENESS_MIN_OUTAGE_PROBES);
});

// --- the sampler and its wiring ---------------------------------------------
//
// None of these may depend on how fast the event loop runs. The first version
// slept 40 ms and expected three samples in it: green on a dev box, red on the
// PR lane, where 1773 unit tests share the runner, and 20 of 24 runs red here
// with 24 copies running at once. Each test now waits for an EVENT — the
// sampler ending, a sample starting, the N-th probe settling — and uses a
// timer only as a cap that turns a broken sampler into a failure, never a hang.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `promise`, or `"timed out"` once `ms` elapse — so a sampler that never ends
 * fails the test instead of hanging the lane. Generous on purpose: it is a cap
 * on a broken sampler, never a budget for a correct one. 2 s was not — with 48
 * copies of this file on 6 CPUs a 40 ms timer fired after 2.5 s.
 */
async function within<T>(promise: Promise<T>, ms = 20_000): Promise<T | "timed out"> {
  let cap: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timed out">((r) => (cap = setTimeout(() => r("timed out"), ms)));
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(cap);
  }
}

test("the sampler stops at a probe that could not run and keeps what it had", async () => {
  const script: (LivenessSample | null)[] = [ok(5), down(), null, ok(5)];
  let calls = 0;
  const sampler = startLivenessSampler(async () => script[calls++] ?? null, { intervalMs: 1 });
  try {
    // `null` is "the page or its context is gone" — sampling past it would record
    // a closed browser as an outage. Nothing but the null may end it here.
    assert.deepEqual(await within(sampler.done), [ok(5), down()]);
    assert.equal(calls, 3);
  } finally {
    await sampler.stop();
  }
});

test("a sampler nobody stops ends at its bound instead of probing forever", async () => {
  // A forgotten `stop()` must not turn into an unbounded stream of requests for
  // the rest of the test — nor into a unit lane that hangs instead of failing,
  // which is what this mutation did before the bound existed.
  const sampler = startLivenessSampler(async () => ok(1), { intervalMs: 1, maxMs: 30 });
  try {
    assert.notEqual(await within(sampler.done), "timed out", "the sampler kept probing past its bound");
  } finally {
    await sampler.stop();
  }
});

test("the probe in flight when the wait ends is counted", async () => {
  // The last sample is the one taken as the budget ran out — dropping it would
  // discard the most relevant observation of all.
  let begun!: () => void;
  const inFlight = new Promise<void>((r) => (begun = r));
  const sampler = startLivenessSampler(
    () => {
      begun();
      return new Promise<LivenessSample>((r) => setTimeout(() => r(down()), 40));
    },
    { intervalMs: 1 },
  );
  await inFlight;
  assert.deepEqual(await sampler.stop(), [down()]);
});

type FakeAnswer = { ok(): boolean; status(): number };
const answer = (status: number): Promise<FakeAnswer> =>
  Promise.resolve({ ok: () => status >= 200 && status < 300, status: () => status });
// What a wedged backend does to `page.request`: accepts and never answers.
const wedged = (): Promise<FakeAnswer> =>
  Promise.reject(new Error("apiRequestContext.get: Timeout 4000ms exceeded."));

/**
 * A page whose selector never renders and whose wait gives up once the
 * `failAfterProbes`-th liveness probe has settled — so the samples a test sees
 * are exactly the ones it scripted, however slowly the runner schedules them.
 * The real wait's `timeout` survives only as a cap.
 */
function fakePage(opts: {
  renderAfterMs?: number;
  failAfterProbes?: number;
  get: (call: number) => Promise<FakeAnswer>;
}) {
  const counter = { calls: 0 };
  let settled = 0;
  let onSettle = () => {};
  const page = {
    url: () => "http://127.0.0.1:7860/",
    waitForSelector: (_selector: string, { timeout }: { timeout: number }) =>
      new Promise<void>((resolve, reject) => {
        if (opts.renderAfterMs !== undefined) {
          setTimeout(resolve, opts.renderAfterMs);
          return;
        }
        const giveUp = () =>
          reject(new Error(`TimeoutError: page.waitForSelector: Timeout ${timeout}ms exceeded.`));
        const cap = setTimeout(giveUp, timeout);
        onSettle = () => {
          if (settled < (opts.failAfterProbes ?? Number.POSITIVE_INFINITY)) return;
          clearTimeout(cap);
          giveUp();
        };
      }),
    request: {
      get: () => {
        const pending = opts.get(++counter.calls);
        const tick = () => {
          settled++;
          onSettle();
        };
        pending.then(tick, tick);
        return pending;
      },
    },
  };
  return { page: page as unknown as Page, counter };
}

async function barrierError(page: Page): Promise<string> {
  try {
    await waitForAttributedSelector(page, SELECTOR, 5000, { sampleIntervalMs: 1 });
  } catch (error: unknown) {
    return String((error as Error)?.message ?? error);
  }
  assert.fail("the barrier was expected to time out");
}

test("a barrier timing out behind a wedge that cleared is reported as degraded", async () => {
  // Wedged for the first three samples, then back — exactly the shape the
  // after-the-fact probe cannot see. Probe 6 is the final one, and it answers.
  const { page, counter } = fakePage({
    failAfterProbes: 5,
    get: (n) => (n <= 3 ? wedged() : answer(200)),
  });
  const msg = await barrierError(page);

  assert.equal(counter.calls, 6, "five samples and one final probe");
  assert.ok(!msg.startsWith(INFRA_PREFIX), `degraded must not claim the infra prefix, got: ${msg}`);
  assert.match(lineOne(msg), /DEGRADED during the wait/);
  assert.match(msg, /3 of 5 liveness probe\(s\) during the wait failed \(longest run 3;/);
  assert.doesNotMatch(msg, /IS a product/);
  assert.equal(classifyInfraError(msg), null);
});

test("a barrier timing out on a backend that answered throughout blames the UI", async () => {
  const { page } = fakePage({ failAfterProbes: 3, get: () => answer(200) });
  const msg = await barrierError(page);

  assert.ok(!msg.startsWith(INFRA_PREFIX));
  assert.match(lineOne(msg), /this IS a product\/UI failure at the page-entry entry point/);
  assert.match(msg, /0 of 3 liveness probe\(s\) during the wait failed/);
});

test("a barrier timing out on a dead backend still gets the infra prefix", async () => {
  // Invariant 1 through the real wiring, samples and all: the final probe decides
  // the prefix, and the message for it is unchanged.
  const { page } = fakePage({ failAfterProbes: 2, get: () => wedged() });
  const msg = await barrierError(page);
  assert.ok(msg.startsWith(INFRA_PREFIX), `expected the infra prefix, got: ${msg}`);
  assert.equal(classifyInfraError(msg)?.id, "api-request-timeout");
});

test("a barrier that renders stops sampling — no probe outlives the wait", async () => {
  // Safe in the direction that matters: correct code issues no probe after the
  // barrier passes however slow the runner is; only a sampler left running can
  // add one in the window below.
  const { page, counter } = fakePage({ renderAfterMs: 60, get: () => answer(200) });
  await waitForAttributedSelector(page, SELECTOR, 1000, { sampleIntervalMs: 1 });
  const atRender = counter.calls;
  await sleep(80);
  assert.equal(counter.calls, atRender, "the sampler kept probing after the barrier passed");
});
