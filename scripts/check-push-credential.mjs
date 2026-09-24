#!/usr/bin/env node
/**
 * Can this run still push the `@stable` removal it may make, and for how much longer?
 *
 * ## Why this exists
 *
 * Since #2002 the VM lane pushes its removals to the source with `SOURCE_PUSH_TOKEN`,
 * and that token expires on a KNOWN DATE (2026-12-20). When it lapses,
 * `auto_remove_commit` fails at the push, rolls the local commit back, and the
 * umbrella reports the removal as made and not pushed. That is not silent, but it is
 * late: it arrives on a red morning, and the tag stays in the selection until someone
 * removes it by hand. The date is readable at the start of every run, so it is read
 * here (#2028).
 *
 * ## How it differs from check-issue-credential.mjs
 *
 * The answers and exit codes are the same, and so is the header (`parseExpiry` is
 * shared). Two things are not:
 *
 * - The CALLER never stops the run on this. A refused umbrella credential means a red
 *   day cannot be reported at all (#1950); a refused push credential means the
 *   umbrella still opens and names the removal it could not push. Stopping would give
 *   up the day's verdict to protect the removal, which is the smaller of the two.
 * - No token is REFUSED, not UNKNOWN. The issue creator falls back to the `gh` CLI;
 *   `auto_remove_commit` has no fallback and refuses without the token.
 *
 * And one thing this can see that the other cannot: `GET /repos/…` reports
 * `permissions.push` for the caller. A `push: false` is a refusal — the token reads
 * the source (which is public, so reading proves nothing) and cannot write to it.
 * When GitHub leaves `permissions` out, nothing is claimed about write.
 *
 * Usage:
 *   SOURCE_PUSH_TOKEN=… SOURCE_REMOTE_URL=https://github.com/oriontech-me/langflow-e2e \
 *     node scripts/check-push-credential.mjs
 *
 * Exit codes: 0 = usable, 2 = could not tell, 3 = refused. NOT 1, for the reason
 * check-issue-credential.mjs gives: node exits 1 when it crashes, and a crash must
 * not read as the token being refused.
 */
import { parseExpiry, EXIT_USABLE, EXIT_UNKNOWN, EXIT_REFUSED } from "./check-issue-credential.mjs";

export { EXIT_USABLE, EXIT_UNKNOWN, EXIT_REFUSED };

const CONSEQUENCE = "a removal would be reported as made and not pushed, and the tag would stay until removed by hand";

/** The decision, as a pure function of what the API said. */
export function verdict({ status, expiresAt, canPush, now, warnDays }) {
  // 404 is a refusal for the reason check-issue-credential.mjs gives: it is how GitHub
  // answers for a repository the credential cannot see. On a PUBLIC source it is
  // sharper still — an anonymous call would have answered 200 — so a 404 here means
  // the token itself is being turned away.
  if (status === 401 || status === 403 || status === 404) {
    return {
      code: EXIT_REFUSED,
      headline: `the push credential cannot reach the source (HTTP ${status}) — ${CONSEQUENCE}`,
    };
  }
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return {
      code: EXIT_UNKNOWN,
      headline: `could not tell whether the push credential works (${status == null ? "no answer" : `HTTP ${status}`}) — UNKNOWN, which is not the same as refused`,
    };
  }
  if (expiresAt && expiresAt <= now) {
    const daysAgo = Math.ceil((now - expiresAt) / 86_400_000);
    return {
      code: EXIT_REFUSED,
      headline: `the push credential expired ${daysAgo} day(s) ago, on ${new Date(expiresAt).toISOString().slice(0, 10)} — ${CONSEQUENCE}`,
    };
  }
  if (canPush === false) {
    return {
      code: EXIT_REFUSED,
      headline: `the push credential reads the source but GitHub reports no push permission — ${CONSEQUENCE}`,
    };
  }
  // What was proven, said once, so no branch below overstates it.
  const works = canPush === true ? "the push credential can push to the source" : "the push credential reaches the source (GitHub did not report push permission)";
  if (!expiresAt) {
    return { code: EXIT_USABLE, headline: `${works}, and carries no expiry date` };
  }
  const daysLeft = Math.floor((expiresAt - now) / 86_400_000);
  if (daysLeft <= warnDays) {
    return {
      code: EXIT_USABLE,
      expiring: true,
      daysLeft,
      headline:
        `${works} but expires in ${daysLeft} day(s), on ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
        `Replace it before then, or ${CONSEQUENCE}.`,
    };
  }
  return {
    code: EXIT_USABLE,
    daysLeft,
    headline: `${works} and expires in ${daysLeft} day(s), on ${new Date(expiresAt).toISOString().slice(0, 10)}`,
  };
}

/**
 * `https://<host>/<owner>/<repo>[.git][/]` → { host, repo }, or null. The same URL
 * `auto_remove_commit` fetches and pushes, so the check asks about the repository the
 * push goes to, not a constant that could drift from it.
 */
export function parseRemote(url) {
  const m = /^https:\/\/([^/@\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url || "").trim());
  return m ? { host: m[1], repo: `${m[2]}/${m[3]}` } : null;
}

export async function main(env = process.env, fetchImpl = fetch) {
  const remoteUrl = env.SOURCE_REMOTE_URL || "https://github.com/oriontech-me/langflow-e2e";
  const token = env.SOURCE_PUSH_TOKEN || "";
  const warnDays = Number(env.CREDENTIAL_WARN_DAYS || 21);

  if (!token) {
    // REFUSED, and this is where it parts from the umbrella's check: there is no `gh`
    // fallback on the write path — `auto_remove_commit` refuses without the token.
    console.log(`[push-credential] REFUSED: SOURCE_PUSH_TOKEN is unset — ${CONSEQUENCE}.`);
    return EXIT_REFUSED;
  }
  const remote = parseRemote(remoteUrl);
  if (!remote) {
    console.log(`[push-credential] UNKNOWN: cannot read a host and repository from SOURCE_REMOTE_URL (${remoteUrl}).`);
    return EXIT_UNKNOWN;
  }

  const base = remote.host === "github.com" ? "https://api.github.com" : `https://${remote.host}/api/v3`;
  // Only the CALL is guarded, as in check-issue-credential.mjs: a throw after the
  // answer arrived must not downgrade a real 401 into UNKNOWN.
  let res = null;
  try {
    res = await fetchImpl(`${base}/repos/${remote.repo}`, {
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
  // Read only on a 2xx, and only a literal boolean counts: an unreadable body claims
  // nothing about write, in either direction.
  let canPush = null;
  if (status >= 200 && status < 300) {
    try {
      const push = (await res.json())?.permissions?.push;
      canPush = typeof push === "boolean" ? push : null;
    } catch {
      canPush = null;
    }
  }

  const result = verdict({ status, expiresAt, canPush, now: Date.now(), warnDays: Number.isFinite(warnDays) ? warnDays : 21 });
  const label = { [EXIT_USABLE]: result.expiring ? "EXPIRING" : "ok", [EXIT_REFUSED]: "REFUSED", [EXIT_UNKNOWN]: "UNKNOWN" }[result.code];
  console.log(`[push-credential] ${label}: ${result.headline}`);
  return result.code;
}

// The same entry-point guard as check-issue-credential.mjs, for the same reason: a
// `file://${argv[1]}` comparison stops matching on a symlinked or percent-encoded
// path, and then this exits 0 having printed nothing.
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
