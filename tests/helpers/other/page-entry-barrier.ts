import type { Page } from "@playwright/test";

/**
 * The page-entry barrier every helper that lands on the home page waits on
 * (`mainpage_title`, then `new-project-btn`), with the failure ATTRIBUTED — and,
 * since #1265, the same attribution for any other entry observable a spec has to
 * wait on before it can start asserting (see `waitForAttributedSelector`).
 *
 * Why this exists (#1262). A bare `waitForSelector` on those two testids cannot
 * distinguish the only two things that make it time out:
 *
 *   1. the backend is unreachable or restarting — the page loads, the app shell
 *      renders nothing, and the barrier burns its whole budget;
 *   2. the entry point genuinely regressed — the backend answers and the UI
 *      still does not render the observable.
 *
 * Both produce the same line, which is the most common failure string in
 * `reports/daily-history.jsonl`:
 *
 *   TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
 *     - waiting for locator('[data-testid="mainpage_title"]') to be visible
 *
 * That ambiguity has already cost a wrong triage. On the 2026-08-04 daily
 * (run 30901311395, shard 4) gunicorn logged `WORKER TIMEOUT (pid:37)` at
 * 10:46:42, SIGKILLed the worker, and the backend was restarting through
 * 10:47:01→10:48:33; two retries of `language-model-regression.spec.ts` ran
 * inside that window, reported the line above, and the test was filed as an
 * entry-point failure (#1262) instead of as collateral of the wedge — while its
 * own first attempt had failed on the provider's build. The same string on
 * 2026-07-09/07-14/07-15 was a third observable entirely (`text=built
 * successfully`), which is how "recurrent 3×, same signature" survived review.
 *
 * So the barrier probes `/api/v1/version` on timeout and says which state it
 * observed. Three rules the unit tests pin:
 *
 *  - an unreachable or non-2xx backend gets `INFRA_PREFIX`, the marker meaning
 *    "the harness could not talk to Langflow" — the same claim
 *    `scripts/lib/infra-signatures.ts` requires before it will exempt a failure
 *    from `@stable` auto-removal;
 *  - a HEALTHY probe deliberately does NOT get that prefix: that failure is the
 *    UI's, and mislabelling it would turn a real entry-point regression into an
 *    unquarantined "outage";
 *  - a probe that could not run is reported as UNKNOWN, never as healthy
 *    (#1012 — an unevaluated check is not a clean one).
 *
 * The original Playwright error is always appended, so the trace, screenshot and
 * call log stay readable against it.
 *
 * WHY IT IS NOT ONLY THE HOME PAGE (#1265)
 *
 * The same ambiguity exists one navigation later, and it cost the same mis-triage.
 * `modelInputComponent.spec.ts` waited 30s for `sidebar-search-input` — the
 * component sidebar's search field on a freshly-opened flow — with a bare
 * `locator.waitFor`. On the 2026-08-04 daily (run 30901311395) that wait timed
 * out inside two measured shard-2 outages (76s and 92s, with gunicorn logging
 * `WORKER TIMEOUT (pid:37)` + SIGKILL at 10:46:30) and the failing attempt took
 * 287s against ~6s for its own file-siblings once the backend recovered. The
 * report showed only
 *
 *   TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
 *     - waiting for getByTestId('sidebar-search-input') to be visible
 *
 * so the flake was filed as test-local and an otherwise healthy `@stable` test
 * was quarantined for a cycle. `locator.waitFor: Timeout` cannot be added to
 * `scripts/lib/infra-signatures.ts` — a genuine UI regression produces it too —
 * so that message is unclassifiable by construction. The attributed one is not,
 * and NOT only because of `INFRA_PREFIX`: it embeds the probe's own transport
 * error, so a wedge (accepted-and-never-answered ⇒ `apiRequestContext.get:
 * Timeout`) already matches the existing `api-request-timeout` signature with no
 * new entry added anywhere, while the healthy-probe message stays unclassified.
 * Both halves of that are pinned in `page-entry-barrier.test.ts` against the real
 * classifier. So the barrier is generic in the observable and carries a `surface`
 * label naming which entry point failed.
 *
 * WHY IT SAMPLES DURING THE WAIT (#1549)
 *
 * The probe above runs AFTER the wait's budget is spent, so on its own it reports
 * the backend's state then — not during. That used to be stated here as a known
 * limitation, and measured against the in-run liveness recorder (#1030) it was
 * not an edge case: 23 healthy-probe verdicts over 8 dailies (2026-08-05 →
 * 09-03), every one on a day with a measured mid-run wedge, and attempts sitting
 * 72–93 % inside an outage window still wrote "the backend was reachable and this
 * IS a product/UI failure", because gunicorn had restarted the worker by the time
 * the probe ran. On 2026-09-03 7 of the 9 recorder probes inside the failing
 * attempt's window failed, and the barrier's single probe answered 200 in 93 ms.
 *
 * So the barrier samples `/api/v1/version` WHILE it waits, using the recorder's
 * own definitions (a probe is down past `LIVENESS_DOWN_MS`, an outage is
 * `LIVENESS_MIN_OUTAGE_PROBES` consecutive downs, a lone one is a blip), and a
 * healthy final probe now yields one of three verdicts:
 *
 *  - corroborated — every sample answered: the settled "IS a product/UI failure";
 *  - degraded     — the samples saw an outage, or the final 200 was itself slower
 *                   than the recorder's threshold: NOT shown to be a UI failure;
 *  - unsampled    — nothing was sampled: NOT shown either (#1012).
 *
 * Its resolution is the recorder's too, by construction: during an outage each
 * sample burns `LIVENESS_DOWN_MS` before it fails, so a wedge shorter than two
 * deadlines (~8 s) yields one failed sample — a blip — and stays corroborated.
 * Line 2 still prints the failed count and the slowest answer, so a reader sees
 * it. Measured with `docker pause` on 1.13.0.dev30: a 10 s wedge inside a 20 s
 * wait gave 2 failed of 11 samples and DEGRADED; the old message called it a
 * UI failure on the strength of an 18 ms answer afterwards.
 *
 * The asymmetry inherited from #1262 is kept exactly: none of the three carries
 * `INFRA_PREFIX`, and the degraded message carries sample COUNTS, never the
 * samples' transport errors — those would match `infra-signatures.ts` and exempt
 * the failure by the back door. A degraded barrier is a doubt for a human, not a
 * proven outage, so the exemption's scope is unchanged. What changed is that the
 * message stops asserting a verdict its evidence does not reach.
 *
 * Line 1 is also kept free of anything that varies by run (latency, URL, sample
 * counts): it is what `reports/daily-history.jsonl` stores as `error_signature`,
 * cut at 240 characters before the recurrence key masks digits, so a latency of
 * 347 ms against 1023 ms shifted the cut and one message read as 4 distinct
 * heads over 23 occurrences. The figures are on line 2.
 */

/**
 * Marker for a failure the harness proved it could not attribute to the page.
 * Kept in one place so a future `infra-signatures.ts` entry and this message
 * cannot drift apart.
 */
export const INFRA_PREFIX = "[backend-unreachable]";

/** Endpoint used as the liveness probe — unauthenticated and cheap. */
export const PROBE_PATH = "/api/v1/version";

/**
 * A liveness sample slower than this is DOWN — the in-run recorder's per-probe
 * deadline (`scripts/watch-backend.mjs`, `WATCH_TIMEOUT_MS`), where an answer
 * past it is aborted and logged as `timeout>4000ms`. Pinned to the recorder's
 * default by a unit test, so the two cannot disagree about "up" again.
 */
export const LIVENESS_DOWN_MS = 4000;

/**
 * Consecutive down samples that make an outage rather than a blip — the
 * recorder's `WATCH_MIN_PROBES`. A lone failed probe is a floor of the runner
 * (~24 a day on the daily, #1686), not evidence that the backend stopped serving.
 */
export const LIVENESS_MIN_OUTAGE_PROBES = 2;

/**
 * Sampling period while a barrier waits. Under 2 s on purpose: Playwright's
 * request context reusing a socket idle for ~2 s against the Langflow server
 * drops it with `socket hang up` on alternate calls (measured locally,
 * 2026-09-14), which would read as a failed sample. The first sample is taken
 * one period in, so a barrier that renders within it costs no request at all.
 */
export const SAMPLE_INTERVAL_MS = 1000;

export type ProbeState = "healthy" | "http_error" | "unreachable" | "unknown";

export interface BackendProbe {
  state: ProbeState;
  /** Wall-clock the probe took, in ms. */
  ms: number;
  /**
   * The absolute URL the probe actually called. Reported rather than rebuilt
   * from the environment: `PLAYWRIGHT_BASE_URL` and the browser context's own
   * baseURL can disagree, and a message that names an origin nobody called is
   * how a reader concludes the wrong backend was healthy.
   */
  url: string;
  /** Set when the backend answered. */
  status?: number;
  /** Transport error, or why the probe itself could not run. */
  detail?: string;
}

/** One liveness sample taken during a wait — up or down, as the recorder counts it. */
export interface LivenessSample {
  ok: boolean;
  ms: number;
}

/** What the samples taken during one wait add up to. */
export interface WaitLiveness {
  samples: number;
  failed: number;
  /** Longest run of consecutive failed samples — an outage at `LIVENESS_MIN_OUTAGE_PROBES`. */
  longestFailedRun: number;
  /** Slowest sample that still answered in time, 0 when none did. */
  slowestOkMs: number;
}

/** Pure — the unit tests drive it directly. */
export function summarizeWaitLiveness(samples: LivenessSample[]): WaitLiveness {
  let failed = 0;
  let run = 0;
  let longestFailedRun = 0;
  let slowestOkMs = 0;
  for (const s of samples) {
    if (s.ok) {
      run = 0;
      slowestOkMs = Math.max(slowestOkMs, s.ms);
    } else {
      failed++;
      run++;
      longestFailedRun = Math.max(longestFailedRun, run);
    }
  }
  return { samples: samples.length, failed, longestFailedRun, slowestOkMs };
}

export type HealthyVerdict = "corroborated" | "degraded" | "unsampled";

/**
 * What a HEALTHY final probe is worth, given the samples taken during the wait.
 * Pure. A final answer the recorder would itself have counted as down outranks
 * the samples; otherwise an outage in the samples does; otherwise the absence of
 * samples does — and only a wait that was sampled and answered throughout is
 * `corroborated`.
 */
export function healthyVerdict(probe: BackendProbe, during?: WaitLiveness): HealthyVerdict {
  if (probe.ms >= LIVENESS_DOWN_MS) return "degraded";
  if (!during || during.samples === 0) return "unsampled";
  if (during.longestFailedRun >= LIVENESS_MIN_OUTAGE_PROBES) return "degraded";
  return "corroborated";
}

/**
 * Default `surface` label — the home page this barrier was built for (#1262).
 * Kept as the default so every existing caller, and every history entry already
 * written against that wording, keeps reading the same.
 */
export const PAGE_ENTRY_SURFACE = "page-entry";

export interface EntryBarrierContext {
  selector: string;
  timeoutMs: number;
  probe: BackendProbe;
  /** The original Playwright error text. */
  cause: string;
  /**
   * Which entry point this barrier guards, e.g. `page-entry` or
   * `component-sidebar`. Named in the message so a reader knows WHICH surface
   * failed without decoding the selector — #1265's flake was triaged as a model
   * selector problem because the message named neither (default:
   * `PAGE_ENTRY_SURFACE`).
   */
  surface?: string;
  /**
   * Liveness sampled while the barrier waited (#1549). Read only when the final
   * probe is healthy — it decides whether that answer is worth a verdict. Absent
   * means nothing sampled, which is never read as corroboration.
   */
  during?: WaitLiveness;
}

/**
 * Build the attributed failure message. Pure — the unit tests drive it directly
 * with each probe state.
 */
export function entryBarrierMessage(ctx: EntryBarrierContext): string {
  const { selector, timeoutMs, probe, cause } = ctx;
  const surface = ctx.surface?.trim() || PAGE_ENTRY_SURFACE;
  const barrier = `${surface} barrier "${selector}" did not render within ${timeoutMs}ms`;
  const url = probe.url;

  let head: string;
  switch (probe.state) {
    case "unreachable":
      head =
        `${INFRA_PREFIX} ${barrier} — and the backend did not answer GET ` +
        `${PROBE_PATH} within ${probe.ms}ms (${url}): ${probe.detail}. ` +
        `Langflow was unreachable or restarting, so this is NOT an entry-point ` +
        `regression in the app.`;
      break;
    case "http_error":
      head =
        `${INFRA_PREFIX} ${barrier} — the backend answered GET ${PROBE_PATH} ` +
        `with HTTP ${probe.status} in ${probe.ms}ms (${url}). Langflow is up but ` +
        `failing to serve, so this is NOT an entry-point regression in the app.`;
      break;
    case "healthy":
      head = healthyHead(barrier, surface, probe, ctx.during);
      break;
    default:
      head =
        `${barrier} — backend liveness could not be probed ` +
        `(${probe.detail}), so whether Langflow was reachable is UNKNOWN. ` +
        `Do not read this as a healthy backend.`;
  }

  return `${head}\n\nOriginal error:\n${cause}`;
}

/**
 * The healthy-probe message. Line 1 is the verdict and nothing that varies by
 * run; line 2 carries the figures. Counts only — never a sample's transport
 * error, which `infra-signatures.ts` would match.
 */
function healthyHead(
  barrier: string,
  surface: string,
  probe: BackendProbe,
  during?: WaitLiveness,
): string {
  const verdict = healthyVerdict(probe, during);
  const line1 =
    verdict === "corroborated"
      ? `${barrier} — the backend answered throughout the wait, so this IS a ` +
        `product/UI failure at the ${surface} entry point.`
      : verdict === "degraded"
        ? `${barrier} — the backend was DEGRADED during the wait, so this is NOT ` +
          `shown to be a product/UI failure at the ${surface} entry point.`
        : `${barrier} — the backend was NOT sampled during the wait, so this is ` +
          `NOT shown to be a product/UI failure at the ${surface} entry point.`;

  const slowest =
    during && during.failed < during.samples
      ? `the slowest answer took ${during.slowestOkMs}ms`
      : `none answered in time`;
  const sampled =
    during && during.samples > 0
      ? `${during.failed} of ${during.samples} liveness probe(s) during the wait ` +
        `failed (longest run ${during.longestFailedRun}; a probe counts as failed ` +
        `past ${LIVENESS_DOWN_MS}ms, as the in-run recorder counts it), ${slowest}`
      : `no liveness probe was taken during the wait`;
  const after =
    `the backend answered GET ${PROBE_PATH} with HTTP ${probe.status} in ` +
    `${probe.ms}ms (${probe.url}) when probed afterwards`;
  const advice =
    verdict === "degraded"
      ? ` A wedge that clears inside the budget reads exactly like this (#1549) — ` +
        `check the shard's backend liveness before treating it as a UI regression.`
      : "";

  return `${line1}\nLiveness: ${sampled}; ${after}.${advice}`;
}

/**
 * Origin to probe: the page's own, when it is on one — that is by definition the
 * Langflow the spec is driving. `baseURL` exists for the force-fail harness and
 * for a page parked on `about:blank`.
 */
export function resolveProbeUrl(page: Page, baseURL?: string): string {
  const explicit = baseURL ?? undefined;
  const pageUrl = page.url();
  const origin =
    explicit ??
    (/^https?:/i.test(pageUrl) ? new URL(pageUrl).origin : undefined) ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:7860";
  return new URL(PROBE_PATH, origin).toString();
}

/** Probe Langflow's liveness through the page's own request context. */
export async function probeBackend(
  page: Page,
  options?: { baseURL?: string; timeoutMs?: number },
): Promise<BackendProbe> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const url = resolveProbeUrl(page, options?.baseURL);
  const started = Date.now();
  try {
    const res = await page.request.get(url, { timeout: timeoutMs });
    const ms = Date.now() - started;
    return res.ok()
      ? { state: "healthy", ms, status: res.status(), url }
      : { state: "http_error", ms, status: res.status(), url };
  } catch (error: any) {
    const ms = Date.now() - started;
    const detail = String(error?.message ?? error).split("\n")[0];
    // A transport error IS the answer here (refused / timed out / DNS), which is
    // different from the probe being unable to run at all — the latter only
    // happens when the page or its context is already gone.
    const unusable = /Target page|context or browser has been closed|browser has been closed/i.test(
      detail,
    );
    return unusable
      ? { state: "unknown", ms, url, detail: `probe could not run: ${detail}` }
      : { state: "unreachable", ms, url, detail };
  }
}

export interface LivenessSampler {
  /**
   * Resolves with every sample taken once sampling has ended for any reason —
   * `stop()`, the `maxMs` bound, or a probe that could not run. Never rejects.
   */
  readonly done: Promise<LivenessSample[]>;
  /**
   * Stop sampling. Resolves with every sample taken — including one still in
   * flight, which is the observation closest to the moment the wait gave up.
   * Never rejects.
   */
  stop(): Promise<LivenessSample[]>;
}

/**
 * Take one liveness sample every `intervalMs` until stopped. The period is
 * measured start to start, so a sample that burns its whole deadline is followed
 * at once — the same pacing as the in-run recorder. A `sample` that resolves to
 * `null` (or throws) means it could not run at all — the page or its context is
 * gone — and ends the sampling: recording a closed browser as an outage would
 * be exactly the unproven claim #1012 forbids.
 *
 * `maxMs` bounds it even if nobody calls `stop()`: a forgotten stop must cost a
 * few samples, not an unbounded stream of requests for the rest of the test —
 * and, without the bound, that mutation HANGS the unit lane instead of failing
 * it. The pause timer is deliberately NOT `unref`'d: a caller awaiting a sample
 * (or `done`) with nothing else pending would see Node drain the event loop
 * under it. On Node 20 — the PR lane's — that cancels the awaiting test and
 * every test after it ("Promise resolution is still pending but the event loop
 * has already resolved"); Node 26 happens to keep the loop alive, which is how
 * the first version passed locally.
 */
export function startLivenessSampler(
  sample: () => Promise<LivenessSample | null>,
  options?: { intervalMs?: number; maxMs?: number },
): LivenessSampler {
  const intervalMs = options?.intervalMs ?? SAMPLE_INTERVAL_MS;
  const maxMs = options?.maxMs ?? Number.POSITIVE_INFINITY;
  const samples: LivenessSample[] = [];
  const startedAt = Date.now();
  let stopped = false;
  let wake: (() => void) | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    let lastMs = 0;
    while (!stopped) {
      await pause(Math.max(0, intervalMs - lastMs));
      if (stopped || Date.now() - startedAt >= maxMs) return;
      const started = Date.now();
      let taken: LivenessSample | null;
      try {
        taken = await sample();
      } catch {
        taken = null;
      }
      if (taken === null) return;
      samples.push(taken);
      lastMs = Date.now() - started;
    }
  })();

  const done = loop.then(
    () => samples,
    () => samples,
  );
  return {
    done,
    stop() {
      stopped = true;
      wake?.();
      return done;
    },
  };
}

/**
 * One liveness sample through the page's request context, judged as the in-run
 * recorder judges its own: up only when it answered 2xx inside
 * `LIVENESS_DOWN_MS`. `null` when the probe could not run at all.
 */
async function sampleBackend(page: Page, baseURL?: string): Promise<LivenessSample | null> {
  const probe = await probeBackend(page, { baseURL, timeoutMs: LIVENESS_DOWN_MS });
  if (probe.state === "unknown") return null;
  return { ok: probe.state === "healthy" && probe.ms < LIVENESS_DOWN_MS, ms: probe.ms };
}

/**
 * `waitForSelector` for ANY entry observable, with the timeout attributed.
 *
 * Drop-in for `await page.waitForSelector(selector, { timeout })`. Behaviour on
 * success is identical (same selector, same budget) — only the failure path
 * changes, and it never loosens the budget: a barrier that masked a slow surface
 * would defeat the point of measuring it (#1265).
 *
 * While it waits it samples backend liveness (#1549), so a healthy probe at the
 * end can be told apart from a wedge that cleared just before it. On success the
 * sampler is stopped without waiting for a sample in flight, so the happy path
 * pays nothing for it; on failure the attribution waits for that sample (at most
 * `LIVENESS_DOWN_MS`) before the final probe.
 *
 * `surface` names the entry point in the message. Pass it whenever the barrier is
 * not the home page, so the failure says which one broke. `sampleIntervalMs`
 * exists for the unit tests, which cannot spend a real second per sample.
 */
export async function waitForAttributedSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
  options?: { baseURL?: string; surface?: string; sampleIntervalMs?: number },
): Promise<void> {
  // Bounded by the wait's own budget: the failure path stops it there anyway, and
  // a sample past it would describe the backend after the wait, not during.
  const sampler = startLivenessSampler(() => sampleBackend(page, options?.baseURL), {
    intervalMs: options?.sampleIntervalMs,
    maxMs: timeoutMs,
  });
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } catch (error: any) {
    const during = summarizeWaitLiveness(await sampler.stop());
    const probe = await probeBackend(page, { baseURL: options?.baseURL });
    throw new Error(
      entryBarrierMessage({
        selector,
        timeoutMs,
        probe,
        during,
        surface: options?.surface,
        cause: String(error?.message ?? error),
      }),
    );
  }
  void sampler.stop();
}

/**
 * The home-page specialisation (#1262) — `waitForAttributedSelector` with the
 * `page-entry` surface. Kept as its own name because that is what every helper
 * landing on the home page calls, and what the messages in
 * `reports/daily-history.jsonl` were written against.
 */
export async function waitForPageEntry(
  page: Page,
  selector: string,
  timeoutMs: number,
  options?: { baseURL?: string },
): Promise<void> {
  await waitForAttributedSelector(page, selector, timeoutMs, {
    baseURL: options?.baseURL,
    surface: PAGE_ENTRY_SURFACE,
  });
}
