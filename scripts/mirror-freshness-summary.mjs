#!/usr/bin/env node
/**
 * The mirror line of the daily's Slack message: was the suite current when the run
 * checked it out, and how did the mirror behave over the last 24 hours?
 *
 * ## Why this exists
 *
 * The freshness alarm used to post every change of state, and the mirror changes state
 * every time the laptop that pushes it falls asleep with a merge pending: four messages
 * in one night on 2026-09-23/24, none about a verdict. The alarm now posts once, before
 * the daily, and only if the mirror is behind at that moment. What it stopped saying
 * lives here instead — one line in a message the channel reads anyway, so a stall that
 * resolved itself overnight is still written down without waking anybody.
 *
 * Input is the history scripts/mirror-freshness-alarm.sh appends on every look:
 * `<epoch seconds>\t<current|not-current|unknown>`, one per line.
 *
 * ## How a stall is counted
 *
 * A stall is a run of `not-current` looks, closed by the first `current` one after it.
 * `unknown` neither opens nor closes one: the check could not ask, which says nothing
 * about the mirror. Its length is first-seen-behind to first-seen-current, so it has the
 * resolution of the timer (an hour) and starts when the check's own lag window had
 * already been exceeded — "about 4h" means four hours past the window, not four hours
 * since the merge.
 *
 * Fail-soft: a missing or unreadable history is itself reported in the line, and the
 * CLI always exits 0. A notifier input must never be the reason a run reports failure.
 *
 * Usage (normally from scripts/run-e2e.sh):
 *   MIRROR_RUN_STATE=current|behind|unknown node scripts/mirror-freshness-summary.mjs
 *   MIRROR_HISTORY_FILE=/path/to/history ...
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_S = 24 * 3600;

/** Parses the history file's text into sorted `{ ts, state }` looks; bad lines are skipped. */
export function parseHistory(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([ts, state]) => /^\d+$/.test(ts) && ["current", "not-current", "unknown"].includes(state))
    .map(([ts, state]) => ({ ts: Number(ts), state }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Stalls that touched the 24h before `now` (epoch seconds).
 *
 * Built over the WHOLE history and then filtered by overlap, not built from the window
 * alone: a stall that opened at 02:00 yesterday and closed at 06:00 would otherwise be
 * cut at the window's edge and reported as one hour when it was four.
 */
export function summarize(looks, now) {
  const since = now - DAY_S;
  const upToNow = looks.filter((l) => l.ts <= now);
  const found = [];
  let openedAt = null;
  for (const { ts, state } of upToNow) {
    if (state === "not-current" && openedAt === null) {
      openedAt = ts;
    } else if (state === "current" && openedAt !== null) {
      found.push({ from: openedAt, to: ts });
      openedAt = null;
    }
  }
  if (openedAt !== null) found.push({ from: openedAt, to: now });
  const touching = found.filter((s) => s.to > since);
  return {
    looks: upToNow.filter((l) => l.ts > since).length,
    stalls: touching.length,
    longestSeconds: touching.reduce((max, s) => Math.max(max, s.to - s.from), 0),
  };
}

function duration(seconds) {
  if (seconds < 3600) return "under an hour";
  return `about ${Math.round(seconds / 3600)}h`;
}

const RUN_STATE_TEXT = {
  current: "current at run time",
  behind: "BEHIND at run time, so this run executed an older suite than main",
  unknown: "could not be checked at run time",
};

/**
 * The line, in plain text: the notifier decides the decoration per transport.
 * `history` is null when the file could not be read.
 */
export function mirrorLine({ runState, history, now }) {
  const parts = [];
  if (RUN_STATE_TEXT[runState]) parts.push(RUN_STATE_TEXT[runState]);
  if (history === null) {
    parts.push("the history of the hourly checks could not be read");
  } else {
    const s = summarize(history, now);
    if (s.looks === 0) {
      parts.push("no hourly check recorded in the last 24h (is e2e-mirror-freshness.timer running?)");
    } else if (s.stalls === 0) {
      parts.push("no stall in the last 24h");
    } else {
      parts.push(
        `fell behind ${s.stalls} time(s) in the last 24h, the longest for ${duration(s.longestSeconds)}`,
      );
    }
  }
  return parts.join(" · ");
}

function main() {
  const env = process.env;
  // Not STATE_DIR, although the alarm reads it: this runs inside the daily, where that
  // generic name can only arrive by collision (the starters use it for their own
  // directories), never on purpose. An override is MIRROR_HISTORY_FILE.
  const stateDir = join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local/state"), "langflow-e2e");
  const file = env.MIRROR_HISTORY_FILE || join(stateDir, "mirror-freshness.history");
  let history = null;
  try {
    history = parseHistory(readFileSync(file, "utf8"));
  } catch {
    history = null;
  }
  console.log(mirrorLine({ runState: env.MIRROR_RUN_STATE, history, now: Math.floor(Date.now() / 1000) }));
  return 0;
}

// The guard check-mirror-freshness.mjs documents: a `file://${argv[1]}` template stops
// matching when the path is percent-encoded or crosses a symlink, and then the script
// prints nothing and exits 0.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
