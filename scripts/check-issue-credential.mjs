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
 * Exit codes: 0 = usable, 1 = rejected, 2 = could not tell.
 */
export const EXIT_USABLE = 0;
export const EXIT_REJECTED = 1;
export const EXIT_UNKNOWN = 2;

/** The decision, as a pure function of what the API said. */
export function verdict({ status, expiresAt, now, warnDays }) {
  if (status === 401 || status === 403) {
    return {
      code: EXIT_REJECTED,
      headline: `the credential was refused (HTTP ${status}) — this lane cannot open the umbrella it may need, so a red morning would pass in silence`,
    };
  }
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return {
      code: EXIT_UNKNOWN,
      headline: `could not tell whether the credential works (${status == null ? "no answer" : `HTTP ${status}`}) — UNKNOWN, which is not the same as refused`,
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
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || "";
  const warnDays = Number(env.CREDENTIAL_WARN_DAYS || 21);

  if (!token) {
    console.log("[credential] REJECTED: no GH_TOKEN/GITHUB_TOKEN in the environment, so no issue can be opened.");
    return EXIT_REJECTED;
  }

  const base = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  let status = null;
  let expiresAt = null;
  try {
    const res = await fetchImpl(`${base}/repos/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(Number(env.CREDENTIAL_TIMEOUT_MS || 20_000)),
    });
    status = res.status;
    expiresAt = parseExpiry(res.headers.get("github-authentication-token-expiration"));
  } catch {
    status = null;
  }

  const result = verdict({ status, expiresAt, now: Date.now(), warnDays: Number.isFinite(warnDays) ? warnDays : 21 });
  const label = { [EXIT_USABLE]: result.expiring ? "EXPIRING" : "ok", [EXIT_REJECTED]: "REJECTED", [EXIT_UNKNOWN]: "UNKNOWN" }[result.code];
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
