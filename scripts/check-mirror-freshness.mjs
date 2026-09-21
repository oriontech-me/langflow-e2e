#!/usr/bin/env node
/**
 * Is the mirror this lane READS still following the repository it mirrors?
 *
 * ## Why this exists
 *
 * The VM checks out from the destination mirror, and the mirror is pushed from a
 * laptop on a schedule. When that stops, nothing anywhere says so: the sync does not
 * fail, it just does not push, and the VM keeps running a suite that is quietly older
 * than `main`. Measured: the guard tripped on 43 consecutive runs between 2026-09-16
 * and 2026-09-18 and nobody knew, the destination stayed frozen at one commit, and the
 * lane spent two days running a two-day-old suite against a moving comparison — 682
 * tests here, 723 there. Those two days are recorded as measured and NOT comparable,
 * which is the cheapest outcome that silence can buy.
 *
 * So this asks the only question that catches it: does the destination's `main` hold
 * what the source's `main` holds? Not "did the last sync report an error" — a sync that
 * never ran reports nothing at all, and that is the failure mode that actually happened.
 *
 * ## What it refuses to do
 *
 * Guess. If the source cannot be reached, the answer is UNKNOWN and the exit code says
 * so: a network blip must not read as "fresh", because "fresh" is exactly the answer
 * that lets a stale suite run unremarked. The whole point is to remove a silence, and a
 * check that degrades to silence has not removed it.
 *
 * ## Usage
 *
 *   node scripts/check-mirror-freshness.mjs                 # in a clone of the mirror
 *   MAX_LAG_MINUTES=180 node scripts/check-mirror-freshness.mjs
 *   SOURCE_REMOTE_URL=... DESTINATION_REMOTE=origin node scripts/check-mirror-freshness.mjs
 *
 * Exit codes: 0 = current, 1 = behind, 2 = could not tell.
 */
import { execFileSync } from "node:child_process";

export const EXIT_CURRENT = 0;
export const EXIT_BEHIND = 1;
export const EXIT_UNKNOWN = 2;

/**
 * The verdict, as a pure function of the two tips and the clock, so the decision is
 * testable without a network: every branch below is one a real morning can produce.
 */
export function verdict({ sourceSha, destSha, oldestMissingAt, now, maxLagMinutes, behindBy }) {
  if (!sourceSha) {
    return { code: EXIT_UNKNOWN, headline: "could not read the source's main — the mirror's freshness is UNKNOWN, which is not the same as current" };
  }
  if (!destSha) {
    return { code: EXIT_UNKNOWN, headline: "could not read the destination's main — the mirror's freshness is UNKNOWN" };
  }
  if (sourceSha === destSha) {
    return { code: EXIT_CURRENT, headline: `the mirror is current at ${destSha.slice(0, 8)}` };
  }
  // Behind, and the age is what decides whether it is a cycle or a stall. The sync runs
  // hourly, so a difference minutes old is the ordinary window between a merge and the
  // next push — reporting that as an alarm would teach everyone to ignore this.
  //
  // The age that answers this is the age of the OLDEST commit the destination is
  // missing, not the age of its own tip. The first version measured the tip and the
  // end-to-end test caught it at once: a mirror whose tip is recent but which has
  // stopped following reads as young, which is the exact state this exists to catch.
  // "How long has the source been ahead?" is the question; the tip cannot answer it.
  const lagMinutes = oldestMissingAt && now ? Math.round((now - oldestMissingAt) / 60000) : null;
  const behind = behindBy == null ? "an unknown number of" : String(behindBy);
  if (lagMinutes != null && lagMinutes <= maxLagMinutes) {
    return {
      code: EXIT_CURRENT,
      headline: `the mirror is ${behind} commit(s) behind, ${lagMinutes} min old — inside the ${maxLagMinutes} min window the schedule allows`,
    };
  }
  return {
    code: EXIT_BEHIND,
    headline:
      `the mirror is ${behind} commit(s) behind and its tip is ` +
      (lagMinutes == null ? "of unknown age" : `${lagMinutes} min old`) +
      `, past the ${maxLagMinutes} min window. The lane reading it is running an older suite than \`main\`, ` +
      `and a comparison made from it is measured but NOT comparable.`,
  };
}

function git(args, { cwd = process.cwd() } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git ls-remote` reduced to one sha, or null when the remote could not be read. */
export function remoteTip(url, ref = "refs/heads/main", { cwd } = {}) {
  try {
    const out = git(["ls-remote", url, ref], { cwd });
    const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
    return line ? line.split("\t")[0] : null;
  } catch {
    return null;
  }
}

export function main(env = process.env, cwd = process.cwd()) {
  const sourceUrl = env.SOURCE_REMOTE_URL || "https://github.com/oriontech-me/langflow-e2e";
  const destination = env.DESTINATION_REMOTE || "origin";
  const maxLagMinutes = Number(env.MAX_LAG_MINUTES || 120);

  const sourceSha = remoteTip(sourceUrl, "refs/heads/main", { cwd });
  const destSha = remoteTip(destination, "refs/heads/main", { cwd });

  let oldestMissingAt = null;
  let behindBy = null;
  if (sourceSha && destSha && sourceSha !== destSha) {
    try {
      git(["fetch", "--quiet", sourceUrl, "main"], { cwd });
      const missing = git(["rev-list", "--format=%ct", "--no-commit-header", `${destSha}..FETCH_HEAD`], { cwd })
        .split("\n")
        .filter(Boolean);
      behindBy = missing.length;
      // Oldest last: `rev-list` walks newest first, so the tail is the commit that has
      // been waiting the longest — the one whose age IS the stall.
      const oldest = missing[missing.length - 1];
      oldestMissingAt = oldest ? Number(oldest) * 1000 : null;
    } catch {
      // Left null on purpose: "an unknown number of commits behind" is still a report,
      // and inventing zero here would turn a stall into a clean bill of health.
    }
  }

  const result = verdict({ sourceSha, destSha, oldestMissingAt, now: Date.now(), maxLagMinutes, behindBy });
  const label = { [EXIT_CURRENT]: "ok", [EXIT_BEHIND]: "BEHIND", [EXIT_UNKNOWN]: "UNKNOWN" }[result.code];
  console.log(`[mirror] ${label}: ${result.headline}`);
  if (result.code !== EXIT_CURRENT) {
    console.log(`[mirror] source ${sourceSha ? sourceSha.slice(0, 8) : "?"} · destination ${destSha ? destSha.slice(0, 8) : "?"}`);
  }
  return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
