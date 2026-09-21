#!/usr/bin/env node
/**
 * Can this run still open the issue it may need to open, and for how much longer?
 *
 * ## Why this exists
 *
 * Since the cut of 2026-09-20 the umbrella issue is how a red morning speaks, and it
 * is born from the VM's run on the destination with a token that expires on a KNOWN
 * DATE. Nothing read that date: when it lapses, `create-failure-issue.mjs` fails, the
 * orchestrator warns "issue creation failed (does not fail the run)", and the day goes
 * on — leaving a red morning whose umbrella never appeared, which to anyone reading
 * the destination is indistinguishable from a morning with nothing to report (#1012's
 * rule, arriving through the credential).
 *
 * Expiry is the rare silent failure that comes with a date attached, so it can be
 * caught before it happens instead of diagnosed after. GitHub says it outright:
 *
 *   github-authentication-token-expiration: 2026-12-19 22:56:58 UTC
 *
 * ## The three answers, and why they differ
 *
 * USABLE — the API answered for the repository. With a date, the days left travel
 * with it so the warning can start early enough to be acted on in a working week.
 * Note what this does NOT prove: `GET /repos/…` establishes READ access, and opening
 * an issue needs write. Proving write would mean opening one, so the remaining gap is
 * named here rather than papered over — a fine-grained token with metadata-only access
 * passes this and fails at the end of a red day.
 *
 * REJECTED — 401 or 403. This is the one that is worth stopping for: the lane cannot
 * deliver the consequence it is about to spend sixteen minutes and real model calls
 * earning, and it is knowable at the start. Not a network condition: the server
 * answered, and what it said was no.
 *
 * UNKNOWN — anything else, including no answer at all. A blip must not read as a dead
 * credential, the same rule the mirror check landed on (#1947).
 *
 * Usage:
 *   ISSUE_HOST=github.ibm.com ISSUE_REPO=Langflow/e2e-qa GH_TOKEN=… \
 *     node scripts/check-issue-credential.mjs
 *
 * Exit codes: 0 = usable, 2 = could not tell, 3 = refused. NOT 1 for refused: node
 * exits 1 on a syntax error, a missing import or an unhandled rejection, and the
 * caller treats refusal as fatal — a broken script would have aborted the daily with
 * a message blaming the token.
 */
export const EXIT_USABLE = 0;
export const EXIT_UNKNOWN = 2;
export const EXIT_REFUSED = 3;

/** The decision, as a pure function of what the API said. */
export function verdict({ status, expiresAt, now, warnDays }) {
  // 404 belongs here, and it is the likelier of the three: GitHub answers 404, not
  // 403, for a repository a credential cannot see — which is what a token that lost
  // access, or was replaced with one scoped elsewhere, looks like from outside. Left
  // in UNKNOWN it would only warn, and the umbrella would go missing anyway.
  if (status === 401 || status === 403 || status === 404) {
    return {
      code: EXIT_REFUSED,
      headline:
        `the credential cannot reach the repository (HTTP ${status}) — this lane cannot open the umbrella it may need, ` +
        `so a red morning would pass in silence`,
    };
  }
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return {
      code: EXIT_UNKNOWN,
      headline: `could not tell whether the credential works (${status == null ? "no answer" : `HTTP ${status}`}) — UNKNOWN, which is not the same as refused`,
    };
  }
  if (expiresAt && expiresAt <= now) {
    // Reachable through clock skew on the VM or a cached 2xx, and "works but expires
    // in -3 day(s)" is not a sentence this should ever print.
    const daysAgo = Math.ceil((now - expiresAt) / 86_400_000);
    return {
      code: EXIT_REFUSED,
      headline: `the credential expired ${daysAgo} day(s) ago, on ${new Date(expiresAt).toISOString().slice(0, 10)} — the umbrella cannot be opened`,
    };
  }
  if (!expiresAt) {
    // A token with no expiry is a real configuration, and saying "unknown" about it
    // would train the reader to ignore this line. It is reported as what it is.
    return { code: EXIT_USABLE, headline: "the credential works, and carries no expiry date" };
  }
  const daysLeft = Math.floor((expiresAt - now) / 86_400_000);
  if (daysLeft <= warnDays) {
    return {
      code: EXIT_USABLE,
      expiring: true,
      daysLeft,
      headline:
        `the credential works but expires in ${daysLeft} day(s), on ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
        `Replace it before then: the failure it produces is silent — the umbrella simply does not appear.`,
    };
  }
  return {
    code: EXIT_USABLE,
    daysLeft,
    headline: `the credential works and expires in ${daysLeft} day(s), on ${new Date(expiresAt).toISOString().slice(0, 10)}`,
  };
}

/** GitHub's header, which is a space-separated UTC stamp rather than ISO-8601. */
export function parseExpiry(header) {
  if (!header) return null;
  const cleaned = String(header).trim().replace(" UTC", "Z").replace(" ", "T");
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : null;
}

export async function main(env = process.env, fetchImpl = fetch) {
  const host = env.ISSUE_HOST || "github.com";
  const repo = env.ISSUE_REPO || "oriontech-me/langflow-e2e";
  // The SAME precedence as the consumer (`create-failure-issue.mjs` reads
  // `GITHUB_TOKEN || GH_TOKEN`). Inverted here, this would validate a credential the
  // creator never uses and pass while the real one is dead — the exact silent failure
  // it exists to close.
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const warnDays = Number(env.CREDENTIAL_WARN_DAYS || 21);

  if (!token) {
    // UNKNOWN, not refused, and the distinction is load-bearing: `create-failure-issue`
    // falls back to the `gh` CLI when there is no token, deliberately, for a machine
    // where a human is logged in. Calling this a refusal would abort a lane that can
    // still open the issue.
    console.log(
      "[credential] UNKNOWN: no GITHUB_TOKEN/GH_TOKEN here — the issue creator would fall back to the `gh` CLI, which this cannot check.",
    );
    return EXIT_UNKNOWN;
  }

  const base = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  // Only the CALL is guarded. Reading the headers inside the same try would let a
  // throw after the answer arrived downgrade a real 401 into UNKNOWN — the one
  // conversion this file must never make.
  let res = null;
  try {
    res = await fetchImpl(`${base}/repos/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(Number(env.CREDENTIAL_TIMEOUT_MS || 20_000)),
    });
  } catch {
    res = null;
  }
  const status = res ? res.status : null;
  let expiresAt = null;
  try {
    expiresAt = parseExpiry(res?.headers?.get("github-authentication-token-expiration"));
  } catch {
    expiresAt = null;
  }

  const result = verdict({ status, expiresAt, now: Date.now(), warnDays: Number.isFinite(warnDays) ? warnDays : 21 });
  const label = { [EXIT_USABLE]: result.expiring ? "EXPIRING" : "ok", [EXIT_REFUSED]: "REFUSED", [EXIT_UNKNOWN]: "UNKNOWN" }[result.code];
  console.log(`[credential] ${label}: ${result.headline}`);
  return result.code;
}

// The guard `check-run-integrity.mjs` documents: a `file://${argv[1]}` template stops
// matching on a percent-encoded path or a symlinked ancestor, and the failure is
// silent — no output, exit 0, which here would read as a healthy credential.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMainModule()) process.exitCode = await main();
