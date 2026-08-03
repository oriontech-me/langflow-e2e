// The token attribution sidecar (issue #1197).
//
// A trace 404s the moment its flow is deleted — measured, not assumed (design §2,
// S4) — so the only place a spec's token consumption can be named is INSIDE
// `cleanup()`, immediately before the DELETE. That is a hostile place for code to
// live, and the constraints below are not stylistic:
//
//   - it must NEVER throw. `cleanup()` promises to fail a teardown only under
//     `{ strict: true }`, and never over telemetry;
//   - it must not poll. One list request per captured flow, plus at most one
//     detail request per trace that flow's list turned up — never repeated,
//     never retried. A trace that has not landed yet is simply missed, and its
//     tokens fall to whatever the poller's own tick manages (or the summary's
//     `unattributed` bucket — counted and named, never hidden);
//   - it must be inert by default. With `TOKENS_ATTRIB` unset it makes no request
//     and touches no file. A LOCAL run pays nothing, unconditionally — nothing
//     outside CI sets the variable. CI is the exception, and deliberately: all
//     three lanes set it (`daily-stable.yml:579`, `pr-validation.yml:711`,
//     `manual.yml:346`). The PR lane included, because that is the one place a
//     cost regression is catchable before merge. An earlier version of this
//     comment claimed "every PR lane" was inert; it was already false when
//     written, and a later design read it as a project-wide constraint — so state
//     the lanes, not a guess about them.
//
// Making an attributed trace SELF-SUFFICIENT (#1197 re-review, finding A): a
// real daily-stable run (30647253368) proved that of 6 traces this sidecar
// attributed, only ONE also showed up in a `token-probes-*.jsonl` file — the
// poller's 15s tick lost the race against the flow (and its trace) being
// deleted seconds after this sidecar read it, and the other five contributed
// NOTHING to the run's totals. Fixed by having this sidecar build the exact
// same probe shape the poller writes — via `buildProbe()`, the ONE place the
// anti-double-count rule (design §2.1) and the total_tokens: null-not-0 rule
// (#1197 review, finding I3) are allowed to live — using the SAME list
// response it already fetches (each item carries `totalTokens`) plus one
// detail fetch per trace for the per-model spans. That shape rides ALONGSIDE
// the attribution fields (`test`/`file`) in the SAME line, so `summarize()`
// only needs to merge one file's worth of records, not two.
import fs from "node:fs";
import type { APIRequestContext } from "@playwright/test";

// §2.1: flows this process has already ATTEMPTED to attribute.
//
// Attempted, not recorded, and the distinction is the contract: one list request
// per flow, never retried. A flow whose list came back 403 has spent its single
// request, so a second pass must not issue another -- recording only successes
// would turn every failure into exactly the retry the no-polling rule forbids.
//
// Process-scoped is the right scope: Playwright runs each worker as its own
// process and a flow belongs to one test in one worker, so there is nothing to
// share across workers and nothing to synchronise.
//
// This exists because `cleanup()` attributes its whole captured batch
// (track-created-flows.ts:263) and then deletes per id (:296) through
// `deleteFlow`, which carries its own hook. Without this guard every tracked
// spec's flows are attributed twice, and two lines for one trace is not a visible
// defect downstream -- it is a plausible number, twice as large.
const attempted = new Set<string>();

// The poller's own coercion, copied rather than approximated: `num()` at
// scripts/watch-tokens.mjs:63-66. A value that is not a finite number GREATER THAN
// ZERO falls back, so neither a malformed lane value nor a literal 0 can poison a
// request with `timeout: NaN` or `timeout: 0` (Playwright reads 0 as "no
// timeout" -- unbounded, the opposite of what a bound is for).
function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Clear the attempted-flow guard. **Unit tests only** -- a spec must not call
 *  it. Production has no reason to: the set is process-scoped and a worker's
 *  flow ids are never reused. */
export function resetAttributedFlows(): void {
  attempted.clear();
}

// `buildProbe` is pure, dependency-free ESM under scripts/lib — the poller
// (scripts/watch-tokens.mjs) imports it the normal, static way. This file is
// TypeScript compiled to CommonJS (tsconfig: `module: commonjs`), and a CJS
// module cannot `require()` a plain ESM `.mjs` file (ERR_REQUIRE_ESM) — so a
// static `import` here would fail at runtime even though it type-checks. A
// dynamic `import()` is Node's documented CJS→ESM interop path and works from
// any CommonJS module, sync or async; it is resolved once and cached by
// Node's module loader, so calling it per-invocation (this function already
// runs at most once per test, inside `cleanup()`) costs nothing after the
// first call. `@ts-expect-error` is required because a plain `.mjs` file with
// no declaration makes `tsc` report TS7016 — verified to reproduce identically
// under both `ts-node` (this repo's test runner) and plain `tsc --noEmit`.
//
// Node version dependency (#1197 re-review): under Playwright's own
// transform this dynamic `import()` survives as a native ES import; under
// `tsc`/`ts-node` (`module: commonjs`, the path this file's own unit tests
// take) it compiles to `Promise.resolve().then(() => require(...))`, which
// only succeeds because Node ≥20.19 backported unflagged `require(esm)`. CI
// pins Node 20, so this holds today — but moving this lane's Node version
// below 20.19 would turn this call into a hard failure. That failure is now
// caught (see the try/catch at the call site below) rather than escaping
// `cleanup()`, but it would still mean every attributed trace silently loses
// its probe recovery — a Node downgrade is not something this guard can make
// invisible, only non-fatal.
type BuildProbeFn = (
  trace: { id?: string; flowId?: string; startTime?: string; status?: string; totalTokens?: number },
  spans: unknown,
) => {
  trace_id: string | null;
  flow_id: string | null;
  start_time: string | null;
  status: string | null;
  total_tokens: number | null;
  models: unknown[];
};

async function loadBuildProbe(): Promise<BuildProbeFn> {
  // @ts-expect-error -- dynamic import of a dependency-free ESM .mjs module; no .d.ts to resolve
  const mod = await import("../../../scripts/lib/token-spans.mjs");
  return mod.buildProbe as BuildProbeFn;
}

export interface RecordTokenAttributionOptions {
  request: APIRequestContext;
  /** The flow ids about to be deleted. */
  flowIds: string[];
  /** The test's title (leaf or full chain — the summary keys on `file` + `test`). */
  test: string;
  /** The spec file, as the run payload reports it. */
  file: string;
  /** Output JSONL path. Defaults to `process.env.TOKENS_ATTRIB`; unset ⇒ inert. */
  out?: string;
  /** Auth header, when the caller already has one. */
  headers?: Record<string, string>;
  /**
   * Override the `buildProbe` loader. **Unit tests only** — a spec must not
   * set it. Lets a test force the dynamic-import failure path (module moved,
   * fd exhaustion, a transient resolution failure) with a rejecting stub,
   * since reliably forcing a REAL `import()` failure from a test is
   * impractical. Defaults to the real loader.
   */
  loadBuildProbe?: () => Promise<BuildProbeFn>;
  /**
   * Per-request timeout in milliseconds, applied to EVERY request this sidecar
   * makes. Falls back to `TOKENS_TIMEOUT_MS`, then to 8000 -- the same default the
   * poller uses (`scripts/watch-tokens.mjs` DEFAULTS.timeoutMs).
   *
   * **In CI the effective value is always the hard-coded 8000.** The identically
   * named `TOKENS_TIMEOUT_MS` in `daily-stable.yml:542`, `pr-validation.yml:676`
   * and `manual.yml:320` sits in the POLLER step's own `env:` block, and a
   * step-level `env:` does not cross into another step -- this sidecar runs in the
   * Playwright step. `manual.yml:327-336` spells out that same gap for
   * `TOKENS_ATTRIB`: `$GITHUB_ENV` is the only mechanism that propagates a value
   * to later steps (composite-action internals included). So the lanes do not
   * configure this today; they merely happen to set the number that is already the
   * default. The env read stays because it makes the knob real for a local run and
   * live the moment that wiring lands -- but do not read a lane value as reaching
   * here, and do not change a lane's number expecting the sidecar to notice.
   *
   * This is not belt-and-braces. Without it Playwright's 30s default applies, and
   * a monitor endpoint wedged during teardown (#1077) consumes the test's own
   * 5-minute budget from inside `afterEach` -- so `request.delete` never runs and
   * the flow leaks silently. That is precisely the failure `deleteFlow` exists to
   * surface, arriving by way of telemetry. The sidecar keeps its promise never to
   * throw and still fails the test, by starving it.
   *
   * A wall-clock deadline checked BETWEEN requests cannot do this job: it never
   * fires on a request that has not returned.
   */
  timeoutMs?: number;
  /**
   * Maximum number of per-trace detail requests for the whole call. Falls back to
   * `TOKENS_DETAIL_CAP`, then to 25 -- again the poller's own default.
   *
   * **In CI the effective value is always the hard-coded 25**, for exactly the
   * reason given on `timeoutMs` above: `daily-stable.yml:546`,
   * `pr-validation.yml:681` and `manual.yml:325` set `TOKENS_DETAIL_CAP` inside the
   * POLLER step's `env:`, which never reaches the Playwright step this runs in.
   *
   * The list requests are one per flow and all start together, so they are already
   * bounded at roughly one round trip. The detail fan-out is the unbounded part:
   * one fetch per trace, and a flow can carry many -- capping the count is what
   * makes the worst case finite instead of proportional to how many traces a test
   * happened to produce.
   *
   * The ceiling that follows is per CALL: CAP x TIMEOUT, because a capped call
   * issues at most CAP detail requests and each is bounded by TIMEOUT. It is NOT
   * the sidecar's ceiling for a spec's whole teardown. `deleteFlow` calls this once
   * per flow, and every call starts with a fresh allowance, so that path costs up
   * to FLOWS x CAP x TIMEOUT. (`daily-stable.yml:640` computes CAP x TIMEOUT for
   * the POLLER's worst in-flight tick -- a different component, one call per tick;
   * do not read it as this sidecar's bound.)
   *
   * A capped trace is NAMED on `skipped`, and still recorded: the cap costs its
   * per-model breakdown, never its tokens. Dropping the spans silently would leave
   * `models: []` on a trace whose breakdown is merely unknown -- identical to a
   * trace whose detail genuinely came back empty, so the line would read complete.
   *
   * The cap is per-CALL and shared by every flow in it, and the flows run
   * concurrently -- so WHICH trace loses its breakdown depends on interleaving,
   * and two runs of the same suite can name different traces on `skipped`. That is
   * by design, not a flake: the property the cap owes you is that the total number
   * of detail requests is bounded and that every curtailed trace is named. Which
   * ones they are was never part of the contract, and making it deterministic
   * would mean serialising the flows again -- the cost this whole section removes.
   */
  detailCap?: number;
}

export interface TokenAttributionResult {
  recorded: number;
  /** One entry per flow whose traces could not be read or written, with the reason. */
  skipped: string[];
}

export async function recordTokenAttribution({
  request,
  flowIds,
  test,
  file,
  out = process.env.TOKENS_ATTRIB,
  headers,
  loadBuildProbe: loadBuildProbeOverride = loadBuildProbe,
  timeoutMs,
  detailCap,
}: RecordTokenAttributionOptions): Promise<TokenAttributionResult> {
  const result: TokenAttributionResult = { recorded: 0, skipped: [] };
  if (!out || !flowIds?.length) return result;

  // The clock for the COST record written at the end (§4.3). It starts here, so it
  // covers everything this call does on behalf of telemetry -- the `buildProbe`
  // import included, since that is time the teardown pays too.
  const callStartedAt = Date.now();

  // The import itself can reject — a future refactor moves the shared
  // module, fd exhaustion, a transient resolution failure (#1197 re-review,
  // Important). Unguarded, that rejection would propagate straight out of
  // this function: `track-created-flows.ts`'s `cleanup()` awaits this call
  // with no try/catch of its own, on the stated assumption that it "cannot
  // throw" — so an unguarded import failure would fail the calling spec's
  // teardown as an unrelated random failure, in a helper 28 specs depend on.
  // Degrade instead: resolve normally, and name the failure on `skipped`
  // rather than silently returning `{recorded: 0, skipped: []}` — which
  // would read exactly like "no traces yet", the same confusion finding I8
  // already fixed once, one level up the call stack this time.
  let buildProbe: BuildProbeFn;
  try {
    buildProbe = await loadBuildProbeOverride();
  } catch (error) {
    result.skipped.push(
      `buildProbe import failed: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`,
    );
    return result;
  }

  // The poller's own defaults (scripts/watch-tokens.mjs DEFAULTS), not a third set
  // invented here -- and the poller's own coercion too: `positive()` above is
  // `num()` from scripts/watch-tokens.mjs:63-66, which requires
  // `Number.isFinite(n) && n > 0` and falls back otherwise.
  //
  // Applied to BOTH the option and the env var, deliberately. An earlier version
  // rejected a non-positive value only on the env path, which left
  // `timeoutMs: 0` reaching Playwright as `timeout: 0` -- meaning NO timeout, the
  // exact wedge this option exists to close -- while the comment claimed 0 was
  // rejected. One rule, both paths, so the code matches what it says.
  const timeout = positive(timeoutMs, positive(process.env.TOKENS_TIMEOUT_MS, 8000));
  const maxDetail = positive(detailCap, positive(process.env.TOKENS_DETAIL_CAP, 25));
  // Shared across the concurrent tasks below. Safe without synchronisation
  // because JS runs them on a single thread, and it is incremented BEFORE its
  // await so two tasks cannot both pass the check on the same slot.
  let detailFetches = 0;

  // Concurrent, not serial (§4.2): N flows cost roughly one round trip instead of
  // N. `result` is mutated from several tasks, which is safe because JS runs them
  // on one thread -- and `appendFileSync` is synchronous, so concurrent appends
  // cannot interleave a line (the property the comment below relies on).
  await Promise.all(
    flowIds.map(async (flowId) => {
      // Claimed BEFORE the request, so a throw below cannot leave the flow
      // eligible for a retry the contract forbids (§2.1).
      if (attempted.has(flowId)) return;
      attempted.add(flowId);

      try {
        const res = await request.get(`/api/v1/monitor/traces?flow_id=${flowId}`, { headers, timeout });
        // `res.json()` used to run regardless of `res.ok()`. Langflow answers an
        // unauthenticated/forbidden request with a JSON body too (e.g. 403
        // `{"detail": "Not authenticated"}`), so `body.traces` was `undefined`,
        // the loop below bailed out, and the result read exactly like "no
        // traces yet" — `{recorded: 0, skipped: []}` — with no warning anywhere.
        // That is the exact regression the bearer-token fix (design §S2) exists
        // to catch: a 403 must be distinguishable from "nothing to attribute
        // yet" (#1197 review, finding I8).
        if (!res.ok()) {
          result.skipped.push(`${flowId}: HTTP ${res.status()}`);
          return;
        }
        const body = (await res.json()) as {
          traces?: Array<{ id?: string; flowId?: string; startTime?: string; status?: string; totalTokens?: number }>;
        };
        const traces = (body?.traces ?? []).filter(
          (t): t is { id: string; flowId?: string; startTime?: string; status?: string; totalTokens?: number } =>
            typeof t?.id === "string" && t.id.length > 0,
        );
        if (!traces.length) return;

        const pending: Array<{ trace: (typeof traces)[number]; spans: unknown }> = [];
        for (const trace of traces) {
          // At most ONE detail fetch per trace this flow's list turned up — never
          // repeated, never retried (the "must not poll" contract above). A
          // failure here (404 — the flow raced ahead and 404'd this trace too,
          // S4; or any other non-2xx) must not lose the line: `buildProbe`
          // degrades a missing/undefined spans array to `models: []` on its own,
          // the exact same degradation the poller applies when ITS OWN detail
          // fetch comes back empty. The trace's own `total_tokens` — already in
          // hand from the list response above — survives either way.
          let spans: unknown;
          // An EXPLICIT numeric zero means the per-model spans buy nothing
          // (§4.2). Absent or null means NOT YET COMPUTED -- the
          // total_tokens: null-not-0 rule (#1197 review, finding I3) -- so those
          // are still fetched. Conflating the two would discard a real trace
          // whose total had not landed yet.
          const knownZero = typeof trace.totalTokens === "number" && trace.totalTokens === 0;
          if (!knownZero) {
            if (detailFetches >= maxDetail) {
              // The cap must NAME itself wherever it curtails work. Silently
              // dropping the spans would leave `models: []` on a trace whose
              // breakdown is merely unknown -- indistinguishable from a trace whose
              // detail genuinely came back empty, and the line would read complete.
              // The trace is still recorded below: the cap costs the per-model
              // breakdown, never the tokens.
              result.skipped.push(
                `${flowId}: detail cap of ${maxDetail} reached before trace ${trace.id}`,
              );
            } else {
              // Incremented BEFORE the await, so two concurrent tasks cannot both
              // pass the check on the same slot and exceed the cap.
              detailFetches += 1;
              try {
                const detailRes = await request.get(`/api/v1/monitor/traces/${trace.id}`, { headers, timeout });
                if (detailRes.ok()) {
                  const detailBody = (await detailRes.json()) as { spans?: unknown };
                  spans = detailBody?.spans;
                }
              } catch {
                // A network-level failure on THIS ONE trace's detail must not lose
                // the whole flow's attribution -- degrade to no spans, exactly as a
                // non-ok response does. `buildProbe` renders that as `models: []`,
                // the same degradation the poller applies to its own empty detail.
              }
            }
          }
          pending.push({ trace, spans });
        }

        const lines = pending.map(({ trace, spans }) =>
          JSON.stringify({ ...buildProbe(trace, spans), flow_id: flowId, test, file }),
        );
        // appendFileSync, not a stream and not `fs.promises.appendFile`: parallel
        // workers share this file, the flows above run concurrently, and a single
        // synchronous sub-4KB append is what keeps two writers from interleaving a
        // line. An async write yields between the open and the write, which is
        // exactly the window that produces half a JSON object.
        //
        // No behavioural test can tell the two apart from outside (an awaited async
        // append also leaves a complete file by the time this function returns), so
        // the synchrony is pinned STRUCTURALLY -- "the sidecar appends
        // synchronously" in token-attribution.test.ts reads this source and fails if
        // the call becomes async. Change one and the other must change with it.
        fs.appendFileSync(out, `${lines.join("\n")}\n`);
        result.recorded += lines.length;
      } catch (error) {
        result.skipped.push(`${flowId}: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`);
      }
    }),
  );

  // ONE cost record per CALL, wall-clock, written whenever `out` is set and at least
  // one flow id was passed -- including when there were zero traces, when the list
  // came back non-ok, and when a flow threw (§4.3, fix round 2).
  //
  // This replaces a per-flow `attrib_ms` repeated on every trace line, which could
  // not measure what §4.3 exists to measure, in two ways:
  //
  //   - a flow that produced NO traces wrote no line, so it contributed nothing --
  //     yet §4.1's dominant cost is "one list request per deleted flow, paid even by
  //     specs that burn nothing". The artifact was blind to precisely the ~140 UI
  //     specs whose single GET each IS the cost;
  //   - summing a per-flow elapsed over-reported by roughly the flow count, because
  //     `.map` starts every task at once so each flow measures nearly the same
  //     interval -- and that sum barely moves when the loop goes serial->concurrent,
  //     so the one field added to demonstrate the improvement could not show it.
  //
  // One record per call means a PLAIN SUM downstream is correct, and the
  // distinct-flow_id reduction the old shape needed (and its trap) is gone with it.
  //
  // `flows` is how many ids this call was ASKED to attribute. An id already claimed
  // by an earlier call issues no request, so a repeat teardown legitimately reports
  // its flow count with a near-zero `attrib_ms`.
  //
  // Deliberate exception: a failing `buildProbe` import returns above, before this
  // point, and writes nothing at all. That path made no request, and "no file is
  // written when the import itself fails" is pinned by its own test.
  try {
    const cost = {
      kind: "attrib_cost",
      flows: flowIds.length,
      attrib_ms: Date.now() - callStartedAt,
      test,
      file,
    };
    fs.appendFileSync(out, `${JSON.stringify(cost)}\n`);
  } catch (error) {
    // Named, never thrown -- same contract as every other failure here. Silence
    // would make an unwritable path look like a teardown that cost nothing.
    result.skipped.push(
      `attrib_cost: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`,
    );
  }
  return result;
}
