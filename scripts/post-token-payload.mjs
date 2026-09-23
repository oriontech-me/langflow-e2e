#!/usr/bin/env node
/**
 * Merge the run's token block into its payload, POST it to the QA Platform, and
 * read the verdict out of the response (#2017).
 *
 * The VM lane captured token consumption on every shard and never sent it: the
 * summarizer wrote no block (no TOKENS_SUMMARY_OUT) and nothing called
 * merge-token-payload.mjs. Invisible only while daily-stable.yml still posts its
 * own; the day that lane is retired the platform keeps receiving runs with no
 * token rows, and nothing fails.
 *
 * WHY A SCRIPT AND NOT A BLOCK OF SHELL
 *
 * The daily's `POST token consumption to QA Platform` step is the reference, and
 * it is not one call — it is a set of outcomes that have to stay distinguishable,
 * and #1226 established that a guard over workflow text passes the mutations it
 * exists to catch. Here each outcome is a return value a test can assert on.
 *
 * WHY A SECOND POST
 *
 * merge-token-payload.mjs's header has the full argument: the run's own POST must
 * not wait behind a telemetry step, and the platform treats the re-POST as
 * idempotent on the run row, so only the token rows land.
 *
 * THE OUTCOMES, and why none of them may collapse into another
 *
 *   From the merge — gated on the FILE, as the workflow is, because a zeroed
 *   block would clamp the run's token columns and read as "spent nothing":
 *     block_missing        the run captured nothing — a notice, not a warning
 *     block_unparseable    spend was computed and then LOST, not zero
 *     payload_missing /
 *     payload_unparseable  tokens computed and discarded: nothing to attach them to
 *     merge_unknown        no verdict at all — UNKNOWN, never zero
 *
 *   Before the POST:
 *     not_configured       endpoint or token unset
 *
 *   From the POST — HTTP 200 is NOT the verdict: the ingest is diagnostic on the
 *   platform's side too and never fails the request, so a rejected or dropped
 *   block arrives inside a 200 (contract: quality-platform
 *   e2e-automation-runs-create/index.ts, `tokenFields`):
 *     http_failed          no response, or a non-2xx one
 *     status_absent        a 2xx whose body carries no tokens_status (or no body)
 *     not_ingested         tokens_status is skipped | rejected | failed
 *     dropped              ingested, but tokens_dropped != 0
 *     delivered            ingested with nothing dropped — the ONLY success
 *
 * Telemetry never fails the run: the CLI always exits 0, and the last line it
 * prints (`post-token-payload: outcome=<…>`) is the machine-readable contract.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mergeTokenPayload } from "./merge-token-payload.mjs";

export const OUTCOMES = [
  "block_missing",
  "block_unparseable",
  "payload_missing",
  "payload_unparseable",
  "merge_unknown",
  "not_configured",
  "http_failed",
  "status_absent",
  "not_ingested",
  "dropped",
  "delivered",
];

/**
 * What a merge that wrote no file means. `code` is the verdict mergeTokenPayload
 * returned (or undefined when it threw). A code that is not a known no-POST
 * verdict — including "merged" with no file behind it — is UNKNOWN.
 */
export function describeMerge(code) {
  switch (code) {
    case "block_missing":
      return {
        outcome: code,
        level: "notice",
        message: "no token block for this run — the run captured nothing to POST.",
      };
    case "block_unparseable":
      return {
        outcome: code,
        level: "warn",
        message:
          "the token block exists but is unparseable — this run's token spend was computed and then LOST, not zero.",
      };
    case "payload_missing":
    case "payload_unparseable":
      return {
        outcome: code,
        level: "warn",
        message: `the run payload is unusable (${code}), so the token block could not be attached — the tokens were computed and are being discarded.`,
      };
    default:
      return {
        outcome: "merge_unknown",
        level: "warn",
        message: `the merge reached no usable verdict (code='${code ?? ""}') — treat this run's token spend as UNKNOWN, not zero.`,
      };
  }
}

/**
 * What the platform's answer means. `status` is the HTTP status (0 or undefined
 * when there was no response); `body` is the raw response text.
 *
 * The fields are read from ONE parse, and a missing field is the literal
 * "absent" rather than a default, so an unreadable body cannot resolve to a
 * plausible-looking zero.
 */
export function classifyIngest(status, body) {
  if (!(status >= 200 && status < 300)) {
    return {
      outcome: "http_failed",
      level: "warn",
      message: `the QA Platform token POST failed (HTTP ${status || "no response"}) — the token rows are NOT recorded.`,
    };
  }
  let parsed = {};
  try {
    const value = JSON.parse(body ?? "");
    if (value && typeof value === "object") parsed = value;
  } catch {
    parsed = {};
  }
  const field = (k) => (parsed[k] === undefined || parsed[k] === null ? "absent" : String(parsed[k]));
  const fields = {
    tokens_status: field("tokens_status"),
    tokens_dropped: field("tokens_dropped"),
    tokens_received: field("tokens_received"),
    tokens_superseded: field("tokens_superseded"),
  };
  if (fields.tokens_status === "absent") {
    return {
      outcome: "status_absent",
      level: "warn",
      fields,
      message: `HTTP ${status} but the response carries no tokens_status — cannot confirm the rows landed. Treat this run's token spend as UNKNOWN.`,
    };
  }
  if (fields.tokens_status !== "ingested") {
    return {
      outcome: "not_ingested",
      level: "warn",
      fields,
      message: `the QA Platform did not ingest the token rows (tokens_status=${fields.tokens_status}, superseded=${fields.tokens_superseded}) — the run row is fine, the token rows are NOT recorded.`,
    };
  }
  if (fields.tokens_dropped !== "0") {
    return {
      outcome: "dropped",
      level: "warn",
      fields,
      message: `the QA Platform dropped ${fields.tokens_dropped} of ${fields.tokens_received} token rows — the block and the ingest disagree (missing model, or two payload rows on one identity).`,
    };
  }
  return {
    outcome: "delivered",
    level: "ok",
    fields,
    message: `token rows delivered — ${fields.tokens_received} row(s) ingested, none dropped.`,
  };
}

const realIo = {
  exists: (p) => existsSync(p),
  remove: (p) => rmSync(p, { force: true }),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, body) => writeFileSync(p, body),
};

export async function postTokenPayload({
  env = process.env,
  merge = mergeTokenPayload,
  fetchImpl = globalThis.fetch,
  io = realIo,
  log = console.log,
} = {}) {
  const payloadOut = env.PAYLOAD_OUT || "payload-with-tokens.json";
  const say = (r) => {
    log(`post-token-payload: ${r.level}: ${r.message}`);
    return r;
  };

  // The gate is the file, so a file left from an earlier invocation would be
  // POSTed as this run's. Removed first; failing to remove it is not fatal, but
  // it is then the one thing the gate cannot tell apart, so it is said.
  try {
    io.remove(payloadOut);
  } catch (error) {
    log(`post-token-payload: warn: could not clear ${payloadOut} before merging (${error?.message || error}).`);
  }

  let code;
  try {
    const result = await merge({ env, log });
    code = result?.code;
  } catch (error) {
    log(`post-token-payload: the merge threw: ${error?.message || error}`);
    code = undefined;
  }
  if (!io.exists(payloadOut)) return say(describeMerge(code === "merged" ? undefined : code));
  if (code !== "merged") {
    // The file exists but the merge did not say it wrote it (another verdict, or
    // it threw): the gate and the verdict disagree, and neither can be trusted.
    return say(describeMerge(undefined));
  }

  if (!env.QA_PLATFORM_ENDPOINT || !env.QA_E2E_AUTOMATION_TOKEN) {
    return say({
      outcome: "not_configured",
      level: "warn",
      message: "QA_PLATFORM_ENDPOINT/QA_E2E_AUTOMATION_TOKEN are not set — the token POST is skipped.",
    });
  }

  let status = 0;
  let body = "";
  try {
    const response = await fetchImpl(env.QA_PLATFORM_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.QA_E2E_AUTOMATION_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: io.readFile(payloadOut),
      signal: AbortSignal.timeout(Number(env.TOKEN_POST_TIMEOUT_MS) || 60_000),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    log(`post-token-payload: the request did not complete: ${error?.message || error}`);
  }
  if (env.TOKEN_POST_RESPONSE_OUT) {
    try {
      io.writeFile(env.TOKEN_POST_RESPONSE_OUT, body);
    } catch {
      // Evidence only; the verdict below is already in the log.
    }
  }
  log(`post-token-payload: HTTP ${status || "no response"}`);
  const verdict = classifyIngest(status, body);
  if (verdict.fields) {
    const f = verdict.fields;
    log(
      `post-token-payload: tokens_status=${f.tokens_status} dropped=${f.tokens_dropped} ` +
        `received=${f.tokens_received} superseded=${f.tokens_superseded}`,
    );
  }
  return say(verdict);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let outcome = "merge_unknown";
  try {
    outcome = (await postTokenPayload()).outcome;
  } catch (error) {
    console.log(`post-token-payload: warn: unexpected error — token spend UNKNOWN: ${error?.message || error}`);
  }
  // Always the LAST line, and always exit 0: telemetry never fails the run.
  console.log(`post-token-payload: outcome=${outcome}`);
}
