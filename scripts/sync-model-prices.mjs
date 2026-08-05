#!/usr/bin/env node
/**
 * Project scripts/lib/model-prices.json into the QA Platform's e2e_model_prices
 * table, by POSTing to its `e2e-model-prices-sync` edge function.
 *
 * WHY THIS EXISTS
 *
 * The platform does not read this repo. It keeps its own copy of the price table
 * and costs every token row by joining a run's date against it. That copy is
 * installed by one RPC (`e2e_replace_model_prices`, a DELETE + INSERT in one
 * transaction) which the sync function calls, and NOTHING was calling the sync
 * function: it has no cron and, until this script, no caller in either repo. So a
 * model added here never reached the platform, and the platform reported it as a
 * price gap while this file priced it perfectly.
 *
 * That is not hypothetical. `claude-haiku-4-5` was added here on 2026-08-03; the
 * daily on 2026-08-04 spent 62k tokens on it, and the platform's Cost tab showed
 * "claude-haiku-4-5 · no band covers run_date · 1 run" with every dollar figure
 * marked as a floor.
 *
 * THE ONE TRANSLATION THIS SCRIPT MAKES, AND WHY IT IS NOT OBVIOUS
 *
 * The two sides disagree about what a FLAT rate means, and the disagreement is
 * structural rather than a bug on either side:
 *
 *   here      a flat entry is a band with `since: null`, which selectBand()
 *             treats as "always effective" -- it prices a run of any date.
 *   platform  `since` is `date NOT NULL` and selection is
 *             `since <= run_date ORDER BY since DESC LIMIT 1`. There is no
 *             "always" band, and a run before the earliest band resolves to
 *             UNPRICED on purpose: pricing a run against a rate that did not
 *             exist yet is the failure that table's shape exists to prevent.
 *
 * So "always" has to become a concrete date. FLAT_SINCE below is that date, and
 * it is deliberately EARLIER than the first run that ever reported tokens
 * (2026-08-03, per reports/token-history.jsonl) -- so no existing run loses its
 * price, and nothing claims a rate was in effect during a period the platform
 * holds no data for.
 *
 * This follows the precedent already set in the file itself: claude-sonnet-5's
 * first band documents its own `since` as "the earliest date this table needs to
 * answer for, not a verified launch date". Same reasoning, applied to flat rates.
 *
 * IF A RATE IS EVER CORRECTED RETROACTIVELY, DO NOT EDIT A FLAT ENTRY IN PLACE:
 * convert it to a dated-bands array so the old rate keeps pricing the runs it
 * actually applied to. Editing in place rewrites history on both sides, silently.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The `since` a flat entry syncs with. See the header: earlier than the first
 * token-bearing run, so translating "always" costs no existing run its price.
 */
export const FLAT_SINCE = "2026-08-01";

export const PRICES_PATH = "scripts/lib/model-prices.json";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The edge function this script installs the table through. */
const SYNC_FUNCTION = "e2e-model-prices-sync";

/**
 * Node's fetch reports every network failure as the same string — "fetch failed"
 * — and puts the part worth reading (ENOTFOUND, ECONNREFUSED, the TLS error) in
 * `cause`. A warning that does not name which one happened is not attribution,
 * which is the only thing this job produces when it gives up.
 */
function describeError(err) {
  const head = err?.message ?? String(err);
  const cause = err?.cause?.message ?? (err?.cause ? String(err.cause) : "");
  return cause && cause !== head ? `${head}: ${cause}` : head;
}

/**
 * How long to wait on the platform before giving up. The job's own
 * `timeout-minutes` is the backstop of last resort; a request that is never going
 * to be answered should not spend it.
 */
const POST_TIMEOUT_MS = 30_000;

/**
 * Flatten the price file into the payload rows the sync function validates.
 *
 * Takes the RAW parsed JSON, not `parsePrices()`'s output: that function drops
 * the per-entry `_comment`, which the platform stores. (It kept `provider` as of
 * #1300 — the summarizer needs it for `by_provider` — so that field is no longer
 * a reason to read raw, but `_comment` still is.) Reading the raw object here is
 * what keeps this projection lossless.
 *
 * Throws on anything the platform would reject, naming the offending model. The
 * platform's rejection is all-or-nothing (one RPC call, DELETE + INSERT), so a
 * single bad row would otherwise fail the whole sync with a message that does not
 * say which row.
 */
export function buildPricePayload(raw, { repoCommitSha, flatSince = FLAT_SINCE } = {}) {
  if (typeof repoCommitSha !== "string" || !repoCommitSha.trim()) {
    throw new Error("buildPricePayload: repoCommitSha is required");
  }
  if (!ISO_DATE.test(flatSince)) {
    throw new Error(`buildPricePayload: flatSince must be YYYY-MM-DD, got ${JSON.stringify(flatSince)}`);
  }

  const prices = [];
  for (const [model, entry] of Object.entries(raw ?? {})) {
    if (model.startsWith("_")) continue; // the file's own top-level "_comment"
    const bands = Array.isArray(entry) ? entry : [entry];
    for (const band of bands) {
      const provider = band?.provider;
      if (typeof provider !== "string" || !provider.trim()) {
        throw new Error(
          `${model}: every entry (and every band) needs an explicit "provider" — ` +
            `the platform stores it per (price_key, since) row and rejects a null. ` +
            `It is never derived from the id prefix; see model-prices.json's header.`,
        );
      }
      const input = Number(band?.inputPerMillion);
      const output = Number(band?.outputPerMillion);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
        throw new Error(
          `${model}: inputPerMillion/outputPerMillion must be finite and >= 0, ` +
            `got ${JSON.stringify(band?.inputPerMillion)} / ${JSON.stringify(band?.outputPerMillion)}`,
        );
      }
      // A dated band carries its own `since`; a flat entry gets the floor. An
      // entry with a MALFORMED since is an error, never silently the floor --
      // that would move a corrected rate back in time over runs it never priced.
      let since;
      if (Array.isArray(entry)) {
        if (!ISO_DATE.test(band?.since ?? "")) {
          throw new Error(`${model}: a dated band needs since as YYYY-MM-DD, got ${JSON.stringify(band?.since)}`);
        }
        since = band.since;
      } else {
        if (band?.since !== undefined) {
          throw new Error(
            `${model}: a flat entry must NOT carry "since" — this repo reads a flat rate as ` +
              `"always effective" and ignores the field, so a since here means two readers ` +
              `disagree about the same data. Convert it to a dated-bands array instead.`,
          );
        }
        since = flatSince;
      }
      const row = {
        price_key: model,
        since,
        provider,
        input_per_million: input,
        output_per_million: output,
      };
      // The entry's own comment is real provenance (where the rate was sourced,
      // when it was verified) and the table has a column for it.
      if (typeof band?._comment === "string" && band._comment.trim()) row.note = band._comment;
      prices.push(row);
    }
  }

  if (prices.length === 0) {
    // The platform refuses a zero-row payload for the same reason: replacing the
    // dimension with nothing makes every model unpriced and every run read as
    // costing nothing, and a cost dashboard of zeros looks exactly like good news.
    throw new Error("buildPricePayload: refusing to build a zero-row payload");
  }

  // (price_key, since) is the platform table's PRIMARY KEY. A duplicate would
  // fail the INSERT after the DELETE had already run inside that transaction --
  // it rolls back, but the error names a constraint rather than a model, so catch
  // it here where the model's name is still in hand.
  const seen = new Set();
  for (const r of prices) {
    // NUL as the separator, so no price_key can spell another key's pair.
    // Written as an ESCAPE, never as a raw byte: a single raw NUL makes git call
    // the whole file binary, and this script reached its first review as
    // "Binary files differ" with nothing for a reviewer to read. Pinned by a test.
    const k = `${r.price_key}\u0000${r.since}`;
    if (seen.has(k)) {
      throw new Error(`${r.price_key}: two bands share since=${r.since}; (price_key, since) is the platform's primary key`);
    }
    seen.add(k);
  }

  return { repo_commit_sha: repoCommitSha, prices };
}

/**
 * Endpoint for the sync function, derived from the run-ingest endpoint's base so
 * one repo variable covers both. An explicit override wins.
 *
 * Parsed as a URL rather than cut with a regex. `QA_PLATFORM_ENDPOINT` is typed
 * by a human into a repo variable, and substring surgery on the two likeliest
 * typos produced a URL that looked fine in the log: a trailing slash APPENDED the
 * function name to the run-ingest path, and a bare origin replaced the HOST with
 * it (`https://e2e-model-prices-sync`). Both post somewhere that does not exist,
 * and the only symptom is an HTTP error inside a continue-on-error job.
 *
 * Throws when the base cannot yield an endpoint. The caller turns that into a
 * warning — a config error must not be reported as a transport failure, and must
 * not be guessed at either.
 */
export function resolveSyncEndpoint(env) {
  // An unset GitHub `vars.X` arrives as "", not as undefined.
  const override = (env.QA_MODEL_PRICES_ENDPOINT ?? "").trim();
  if (override) return override;
  const base = (env.QA_PLATFORM_ENDPOINT ?? "").trim();
  if (!base) return null;

  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`QA_PLATFORM_ENDPOINT is not a valid URL: ${JSON.stringify(base)}`);
  }
  // .../functions/v1/e2e-automation-runs-create -> .../functions/v1/e2e-model-prices-sync
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(
      `QA_PLATFORM_ENDPOINT has no path segment to replace: ${JSON.stringify(base)} — ` +
        `expected something like https://<host>/functions/v1/e2e-automation-runs-create, ` +
        `or set QA_MODEL_PRICES_ENDPOINT explicitly.`,
    );
  }
  segments[segments.length - 1] = SYNC_FUNCTION;
  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function syncModelPrices({
  env = process.env,
  readFile = (p) => readFileSync(p, "utf8"),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const token = env.QA_E2E_MODEL_PRICES_TOKEN;
  const sha = env.GITHUB_SHA || env.PRICES_COMMIT_SHA;

  if (!sha) {
    log("sync-model-prices: no GITHUB_SHA / PRICES_COMMIT_SHA — cannot record which commit this reflects; skipping.");
    return { posted: false, reason: "no commit sha" };
  }

  // Built BEFORE the credential check on purpose: a malformed price file should
  // fail loudly on every lane, including the ones with no secret, rather than
  // being discovered only on the lane that can post.
  const payload = buildPricePayload(JSON.parse(readFile(PRICES_PATH)), { repoCommitSha: sha });
  log(`sync-model-prices: built ${payload.prices.length} row(s) from ${PRICES_PATH} at ${sha.slice(0, 7)}.`);

  // Resolved AFTER the payload, so a bad repo variable still lets the validation
  // half run. A base that cannot yield an endpoint is a config error, reported as
  // one rather than left to surface later as an HTTP failure against a URL nobody
  // meant to call.
  let endpoint;
  try {
    endpoint = resolveSyncEndpoint(env);
  } catch (err) {
    log(
      `::warning::model-prices sync: ${err?.message ?? err} — not posting; ` +
        `the platform's price table is unchanged.`,
    );
    return { posted: false, reason: "bad endpoint", payload };
  }

  if (!endpoint || !token) {
    log(
      "sync-model-prices: endpoint or QA_E2E_MODEL_PRICES_TOKEN not configured — not posting. " +
        "The payload above is valid; the platform's copy stays as it was.",
    );
    return { posted: false, reason: "not configured", payload };
  }

  // A REQUEST THAT NEVER GETS AN ANSWER IS THE LIKELIEST FAILURE HERE, and for a
  // long time it was the only one not handled: DNS, ECONNREFUSED, TLS and socket
  // hangup all REJECT rather than returning a status, so they escaped this await,
  // exited non-zero and printed a stack trace instead of the ::warning:: below —
  // which the job's continue-on-error then turned into a green run with nothing
  // installed. The whole point of never failing the job is that the warning is
  // the signal, so the warning has to exist on every path that gives up.
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    log(
      `::warning::model-prices sync could not reach the platform (${describeError(err)}) — ` +
        `the price table is unchanged.`,
    );
    return { posted: false, reason: "transport", payload };
  }

  // An unreadable body is not evidence the install failed — the POST may well
  // have landed. The status decides; this is logged and moved past.
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    log(`sync-model-prices: HTTP ${res.status}, but the response body could not be read (${describeError(err)}).`);
  }
  log(`sync-model-prices: HTTP ${res.status} ${text.slice(0, 500)}`);
  if (!res.ok) {
    // Never fails the job: this is telemetry plumbing, and a platform outage must
    // not turn into a red suite. The warning is the signal.
    log(`::warning::model-prices sync failed (HTTP ${res.status}) — the platform's price table is unchanged.`);
    return { posted: false, reason: `http ${res.status}`, payload };
  }
  return { posted: true, reason: "ok", payload };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Every way of giving up POSTs nothing and returns a reason with a ::warning::
  // beside it — transport, bad endpoint, unconfigured. So no non-zero exit here,
  // and the workflow reads the log.
  //
  // A MALFORMED PRICE FILE IS THE ONE EXCEPTION and still throws: that is a data
  // error in this repo, not the platform being unreachable, and it fails on the
  // PR lane too via `npm run test:scripts`.
  await syncModelPrices();
}
