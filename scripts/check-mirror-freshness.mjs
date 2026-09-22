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
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXIT_CURRENT = 0;
export const EXIT_BEHIND = 1;
export const EXIT_UNKNOWN = 2;
// Its own code rather than BEHIND: a destination holding commits the source does not
// is not an old mirror, it is a diverged one — the state the sync guard exists to
// stop — and a caller that only knows "not zero" still does the right thing.
export const EXIT_DIVERGED = 3;

// Every git call here talks to a network remote from an unattended timer. Without these
// an unknown host key or a credential prompt does not fail — it BLOCKS, on a tty the
// caller does not have, and a check written to remove a silence becomes the silence.
const NETWORK_TIMEOUT_MS = 60_000;
const BATCH_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

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
  // Different tips and NOTHING missing: the destination already holds the source's tip,
  // so it is ahead or rewritten, not behind. Reporting that as "0 commit(s) behind, of
  // unknown age" was both wrong and indistinguishable from "could not walk the history".
  if (behindBy === 0) {
    return {
      code: EXIT_DIVERGED,
      headline:
        `the destination holds commits the source does not (${destSha.slice(0, 8)} vs ${sourceSha.slice(0, 8)}). ` +
        `This is divergence, not lag: the mirror is a function of the source, so something wrote to it directly ` +
        `or the source was rewritten.`,
    };
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

function git(args, { cwd = process.cwd(), env = process.env } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: NETWORK_TIMEOUT_MS,
    env: { ...env, ...BATCH_ENV },
  }).trim();
}

/** `git ls-remote` reduced to one sha, or null when the remote could not be read. */
export function remoteTip(url, ref = "refs/heads/main", { cwd, env } = {}) {
  try {
    const out = git(["ls-remote", url, ref], { cwd, env });
    const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
    return line ? line.split("\t")[0] : null;
  } catch {
    return null;
  }
}

/** A remote name or URL reduced to the URL git would use, or null when unknown. */
export function resolveRemote(nameOrUrl, { cwd, env } = {}) {
  try {
    return git(["remote", "get-url", nameOrUrl], { cwd, env });
  } catch {
    return nameOrUrl || null;
  }
}

export function main(env = process.env, cwd = process.cwd()) {
  const sourceUrl = env.SOURCE_REMOTE_URL || "https://github.com/oriontech-me/langflow-e2e";
  const destination = env.DESTINATION_REMOTE || "origin";
  // A typo here must not disable the window quietly: `Number("18O")` is NaN, every
  // comparison with it is false, the young branch becomes unreachable and the output
  // reads "past the NaN min window". Named and replaced instead.
  let maxLagMinutes = Number(env.MAX_LAG_MINUTES || 120);
  if (!Number.isFinite(maxLagMinutes) || maxLagMinutes < 0) {
    console.log(`[mirror] MAX_LAG_MINUTES=${JSON.stringify(env.MAX_LAG_MINUTES)} is not a number of minutes — using 120.`);
    maxLagMinutes = 120;
  }

  // The one answer this must never give by accident is "current", and pointing both
  // sides at the same repository produces it forever — which is what a dev clone made
  // straight from the source would do. Compared by resolved URL, so an alias and a URL
  // for the same remote are caught too.
  const sourceResolved = resolveRemote(sourceUrl, { cwd, env });
  const destResolved = resolveRemote(destination, { cwd, env });
  if (sourceResolved && destResolved && sourceResolved === destResolved) {
    console.log(
      `[mirror] UNKNOWN: the source and the destination resolve to the same repository (${sourceResolved}) — ` +
        `this clone cannot answer the question, and "current" would be an accident.`,
    );
    return EXIT_UNKNOWN;
  }

  const sourceSha = remoteTip(sourceUrl, "refs/heads/main", { cwd, env });
  const destSha = remoteTip(destination, "refs/heads/main", { cwd, env });

  let oldestMissingAt = null;
  let behindBy = null;
  let walked = true;
  if (sourceSha && destSha && sourceSha !== destSha) {
    try {
      // BOTH tips are fetched, and the walk names shas rather than `FETCH_HEAD`.
      // Two reasons, both measured in review. `FETCH_HEAD` is shared mutable state in
      // the clone: the daily fetches `origin` in its own preflight, and one landing
      // between these two lines made the walk compare the destination against itself
      // — zero commits missing, which this file reads as divergence and would have
      // announced as "something wrote to the mirror directly" during an ordinary
      // stall. And the destination's tip is only a local object while it is an
      // ancestor of the source, so in the ONE case `EXIT_DIVERGED` exists for — a
      // commit written straight to the mirror — `rev-list` died with "bad revision"
      // and the catch below turned it into "behind by an unknown number", the exact
      // opposite of the truth.
      git(["fetch", "--quiet", sourceUrl, "main"], { cwd, env });
      git(["fetch", "--quiet", destination, "main"], { cwd, env });
      // `--first-parent`, and this is the correction that matters. Without it the walk
      // includes every commit a MERGE brought in, dated when the branch was written
      // rather than when it landed — and this repository merges with merge commits. So
      // an ordinary merge of a day-old branch made the mirror read as a stall the
      // instant it landed: measured on the last 25 merges, 12 carried a commit older
      // than the window. The first-parent line is the history of what reached `main`,
      // and its dates are landing times, which is the question being asked.
      const missing = git(
        ["rev-list", "--first-parent", "--format=%ct", "--no-commit-header", `${destSha}..${sourceSha}`],
        { cwd, env },
      )
        .split("\n")
        .filter(Boolean)
        .map(Number);
      behindBy = missing.length;
      // `Math.min`, not the tail: rev-list only guarantees parents after children, so a
      // skewed committer date (a bot, a rebase onto an odd clock) can leave the true
      // minimum anywhere in the list — and taking the tail would understate the stall.
      oldestMissingAt = missing.length ? Math.min(...missing) * 1000 : null;
    } catch {
      // A walk that did not happen is not a measurement. Reporting "behind by an
      // unknown number" here asserted staleness the run had not established, and it
      // was indistinguishable from the real empty range that means divergence.
      walked = false;
    }
  }

  const result = walked
    ? verdict({ sourceSha, destSha, oldestMissingAt, now: Date.now(), maxLagMinutes, behindBy })
    : {
        code: EXIT_UNKNOWN,
        headline: "the tips differ and the history could not be walked — the difference is UNKNOWN, neither lag nor divergence",
      };
  const label = {
    [EXIT_CURRENT]: "ok",
    [EXIT_BEHIND]: "BEHIND",
    [EXIT_UNKNOWN]: "UNKNOWN",
    [EXIT_DIVERGED]: "DIVERGED",
  }[result.code];
  console.log(`[mirror] ${label}: ${result.headline}`);
  if (result.code !== EXIT_CURRENT) {
    console.log(`[mirror] source ${sourceSha ? sourceSha.slice(0, 8) : "?"} · destination ${destSha ? destSha.slice(0, 8) : "?"}`);
  }
  return result.code;
}

// The same guard `check-run-integrity.mjs` documents, and for the same reason: a
// `file://${argv[1]}` template stops matching as soon as the path is percent-encoded
// (one space does it) or any ancestor is a symlink, because the loader resolves
// symlinks in `import.meta.url`. Getting it wrong here is SILENT — the script prints
// nothing and exits 0, which reads exactly like "the mirror is current".
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
