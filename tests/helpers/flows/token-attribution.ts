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
//   - it must be inert by default. With `TOKENS_ATTRIB` unset (every local run,
//     every PR lane) it makes no request and touches no file.
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

  for (const flowId of flowIds) {
    try {
      const res = await request.get(`/api/v1/monitor/traces?flow_id=${flowId}`, { headers });
      // `res.json()` used to run regardless of `res.ok()`. Langflow answers an
      // unauthenticated/forbidden request with a JSON body too (e.g. 403
      // `{"detail": "Not authenticated"}`), so `body.traces` was `undefined`,
      // the loop below `continue`d, and the result read exactly like "no
      // traces yet" — `{recorded: 0, skipped: []}` — with no warning anywhere.
      // That is the exact regression the bearer-token fix (design §S2) exists
      // to catch: a 403 must be distinguishable from "nothing to attribute
      // yet" (#1197 review, finding I8).
      if (!res.ok()) {
        result.skipped.push(`${flowId}: HTTP ${res.status()}`);
        continue;
      }
      const body = (await res.json()) as {
        traces?: Array<{ id?: string; flowId?: string; startTime?: string; status?: string; totalTokens?: number }>;
      };
      const traces = (body?.traces ?? []).filter(
        (t): t is { id: string; flowId?: string; startTime?: string; status?: string; totalTokens?: number } =>
          typeof t?.id === "string" && t.id.length > 0,
      );
      if (!traces.length) continue;

      const lines: string[] = [];
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
        try {
          const detailRes = await request.get(`/api/v1/monitor/traces/${trace.id}`, { headers });
          if (detailRes.ok()) {
            const detailBody = (await detailRes.json()) as { spans?: unknown };
            spans = detailBody?.spans;
          }
        } catch {
          // Network-level failure fetching THIS ONE trace's detail must not
          // lose the whole flow's attribution — degrade to no spans, same as
          // a non-ok response.
        }
        const probe = buildProbe(trace, spans);
        lines.push(JSON.stringify({ ...probe, flow_id: flowId, test, file }));
      }
      // appendFileSync, not a stream: parallel workers share this file, and a single
      // sub-4KB append is what keeps their lines from interleaving.
      fs.appendFileSync(out, `${lines.join("\n")}\n`);
      result.recorded += lines.length;
    } catch (error) {
      result.skipped.push(`${flowId}: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`);
    }
  }
  return result;
}
