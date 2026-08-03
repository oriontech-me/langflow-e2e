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
   * makes. Defaults to `TOKENS_TIMEOUT_MS`, then to 8000 -- the same knob and the
   * same default the poller uses (`scripts/watch-tokens.mjs` DEFAULTS.timeoutMs).
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
   * Maximum number of per-trace detail requests for the whole call. Defaults to
   * `TOKENS_DETAIL_CAP`, then to 25 -- again the poller's own knob and default.
   *
   * The list requests are one per flow and all start together, so they are already
   * bounded at roughly one round trip. The detail fan-out is the unbounded part:
   * one fetch per trace, and a flow can carry many. `daily-stable.yml:640` models
   * the worst case as CAP x TIMEOUT, so capping the count is what makes that
   * product finite.
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

  // The poller's own knobs and defaults (scripts/watch-tokens.mjs DEFAULTS), not a
  // third set invented here. `Number(x) || d` deliberately falls back on NaN too,
  // so a malformed lane value degrades to the default instead of poisoning every
  // request with `timeout: NaN`. (The parentheses are obligatory: `??` and `||`
  // cannot be mixed unparenthesised — TS5076.)
  //
  // A lane exporting `TOKENS_TIMEOUT_MS=0` therefore resolves to 8000, which is
  // the semantics this repo already practises: the poller coerces the very same
  // variable through `num()` (scripts/watch-tokens.mjs:63-66), which requires
  // `Number.isFinite(n) && n > 0` and falls back otherwise. Rejecting 0 is also
  // the only safe reading here, since Playwright's `timeout: 0` means NO timeout
  // and would reopen the exact wedge this option exists to close.
  const timeout = timeoutMs ?? (Number(process.env.TOKENS_TIMEOUT_MS) || 8000);
  const maxDetail = detailCap ?? (Number(process.env.TOKENS_DETAIL_CAP) || 25);
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

      const startedAt = Date.now();

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

        const elapsed = Date.now() - startedAt;
        // Per-FLOW elapsed, repeated on each of that flow's lines (§4.3).
        // Anything totalling this must reduce over distinct flow_id.
        const lines = pending.map(({ trace, spans }) =>
          JSON.stringify({ ...buildProbe(trace, spans), flow_id: flowId, test, file, attrib_ms: elapsed }),
        );
        // appendFileSync, not a stream: parallel workers share this file, and a single
        // sub-4KB append is what keeps their lines from interleaving.
        fs.appendFileSync(out, `${lines.join("\n")}\n`);
        result.recorded += lines.length;
      } catch (error) {
        result.skipped.push(`${flowId}: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`);
      }
    }),
  );
  return result;
}
