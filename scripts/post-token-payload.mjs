#!/usr/bin/env node
// Attach this run's token consumption to the record the platform already holds, and
// say what actually happened to it.
//
// ## Why a second POST exists at all
//
// The run's own POST happens before this number does. The total only exists once every
// shard has finished and its artifacts have been gathered, and moving the run's POST
// behind a telemetry step would delay the verdict for the sake of a diagnostic. So the
// same payload is re-POSTed with a `tokens` block added; the platform's ingest is
// idempotent on the run row, and only the token rows land.
//
// ## Why this is a script and not four lines of shell
//
// There are EIGHT distinguishable outcomes here and none of them may be collapsed into
// "it worked" or "it failed". The Actions lane composes them inline in YAML, where
// #1226 established that a guard over workflow text passes the mutations it exists to
// catch — three wrong figures shipped out of such a block with every gate green. Here
// the wording is asserted on output.
//
// ## The two conflations this exists to prevent
//
// A block that is ABSENT and a block that is UNPARSEABLE are different facts: the first
// is a run that captured nothing, the second is a run whose spend was computed and then
// LOST. Reporting the second as the first is the absent-vs-zero conflation (#1012).
//
// And HTTP 200 is NOT the verdict. The platform's token ingest is diagnostic on its
// side too, so it never fails the request: a rejected or dropped block comes back
// inside a 200, and the body is where the truth is. `absent` is a literal outcome, not
// a reason to print a plausible-looking zero.
//
// ## It never fails the run
//
// Telemetry is an attachment to a verdict. Every path here returns 0; the reporting is
// the product.
import { mergeTokenPayload } from "./merge-token-payload.mjs";

/**
 * What a merge verdict means for a human reading the daily log.
 *
 * Keyed on the same codes `MERGE_CODES` lists, and `null` for `merged` — the one code
 * that is not an ending. An unrecognised code is UNKNOWN rather than falling through to
 * the most likely neighbour: a verdict this does not know about is exactly the case
 * where guessing costs a real outcome its name.
 */
export function describeMergeOutcome(code) {
  switch (code) {
    case "merged":
      return null;
    case "block_missing":
      return { level: "notice", text: "No token block for this run — the run captured nothing to POST." };
    case "block_unparseable":
      return {
        level: "warning",
        text: "The token block exists but is unparseable — this run's token spend was computed and then LOST, not zero.",
      };
    case "payload_missing":
    case "payload_unparseable":
      return {
        level: "warning",
        text: `The run payload (${code}) is unusable, so the token block could not be attached — the tokens were computed and are being discarded.`,
      };
    default:
      return {
        level: "warning",
        text: `merge-token-payload reached no verdict (code='${code ?? "none"}') — treat this run's token spend as UNKNOWN, not zero.`,
      };
  }
}

/**
 * What the platform's response says happened to the rows.
 *
 * Reads four fields from ONE parse, so a field that is present-but-null cannot be
 * confused with one that is absent. Delivery is the narrowest case — `ingested` with
 * nothing dropped — because every other shape is a row that did not land.
 */
export function describeIngest({ status, dropped, received, superseded } = {}) {
  if (status === undefined || status === null || status === "absent") {
    return {
      level: "warning",
      text: "the response carries no tokens_status — cannot confirm the rows landed. Treat this run's token spend as UNKNOWN.",
    };
  }
  if (status !== "ingested") {
    return {
      level: "warning",
      text: `the QA Platform did not ingest the token rows (tokens_status=${status}, superseded=${superseded ?? "absent"}) — the run row is fine, the token rows are NOT recorded.`,
    };
  }
  if (String(dropped) !== "0") {
    return {
      level: "warning",
      text: `the QA Platform dropped ${dropped} of ${received} token row(s) — the block and the ingest disagree (missing model, or two payload rows on one identity).`,
    };
  }
  return { level: "info", text: `Token rows delivered — ${received} row(s) ingested, none dropped.` };
}

/** The four fields, from one parse, with `absent` where the body does not carry them. */
export function readIngestFields(bodyText) {
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: "absent", dropped: "absent", received: "absent", superseded: "absent" };
  }
  return {
    status: body.tokens_status ?? "absent",
    dropped: body.tokens_dropped ?? "absent",
    received: body.tokens_received ?? "absent",
    superseded: body.tokens_superseded ?? "absent",
  };
}

function emit({ level, text }) {
  if (level === "info") console.log(`[tokens] ${text}`);
  else console.error(`[tokens] ${level}: ${text}`);
}

async function main({ env = process.env, fetchImpl = fetch, readFileSync } = {}) {
  const read = readFileSync ?? (await import("node:fs")).readFileSync;

  const result = await mergeTokenPayload({ env });
  const outcome = describeMergeOutcome(result?.code);
  if (outcome) {
    emit(outcome);
    return 0;
  }

  const endpoint = env.QA_PLATFORM_ENDPOINT || "";
  const token = env.QA_E2E_AUTOMATION_TOKEN || "";
  if (!endpoint || !token) {
    emit({ level: "warning", text: "QA_PLATFORM_ENDPOINT/QA_E2E_AUTOMATION_TOKEN are not set — the token POST is skipped." });
    return 0;
  }

  const payloadOut = env.PAYLOAD_OUT || "payload-with-tokens.json";
  let body;
  try {
    body = read(payloadOut, "utf8");
  } catch (e) {
    emit({ level: "warning", text: `${payloadOut} was reported written but cannot be read (${e?.message ?? e}) — the token rows are discarded.` });
    return 0;
  }

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    emit({ level: "warning", text: `the token POST could not be sent (${e?.message ?? e}) — the run row is fine, the token rows are NOT recorded.` });
    return 0;
  }

  const text = await res.text().catch(() => "");
  if (res.status !== 200 && res.status !== 201) {
    emit({ level: "warning", text: `the QA Platform token POST failed (HTTP ${res.status}).` });
    return 0;
  }

  const fields = readIngestFields(text);
  console.log(
    `[tokens] tokens_status=${fields.status} dropped=${fields.dropped} received=${fields.received} superseded=${fields.superseded}`,
  );
  emit(describeIngest(fields));
  return 0;
}

export { main };

if (process.argv[1] && process.argv[1].endsWith("post-token-payload.mjs")) {
  main().then((code) => { process.exitCode = code; });
}
