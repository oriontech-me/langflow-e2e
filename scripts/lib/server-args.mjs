// Reads the `server.args` file the native-starter harnesses' fake binaries append to,
// without racing the one invocation that is NOT synchronous.
//
// Both `start-echo-source.test.mjs` and `start-ollama-source.test.mjs` stub the server
// binary with a script whose first line is `echo "$*" >> server.args`, and both
// starters launch that binary BACKGROUNDED (`"${BIN}" ... &`) — deliberately, so the
// PID file names the server rather than a subshell wrapper. The starter then reports
// readiness from a stubbed `curl` that answers whether or not the launched process has
// reached its first instruction, so the script can exit 0 before the line exists.
// Reading the file once, straight after `spawnSync`, is therefore a race.
//
// It lost on PR #1937's first CI run (#1949) — `-max-duration NaNs`, a positive match
// on an empty read. The louder half is the cheaper half: THREE assertions over this
// file are NEGATIVE, and an empty read satisfies them silently. `doesNotMatch(args,
// /use-real-hostname/)` is the guard that keeps an internal hostname off /hostname,
// and `equal(args, "")` IS the assertion "nothing was ever launched". So this reader
// fails loudly instead of falling through to "" — the fall-through is what turns two
// guards off without a symptom (#1012, #1226).
//
// The wait is conditional on the starter having ANNOUNCED a launch, because several
// cases refuse before launching and "" is then the right answer, reached in no time.
// The announcement is the starter's own stdout line, printed immediately before the
// `&` — the last observable point at which the launch is still synchronous.
//
// "Announced" is very nearly "the line is coming", and the gap is why the harnesses
// read this LAZILY rather than eagerly. `start-ollama-source.sh` can SIGTERM what it
// launched a few process-spawns later — probe, `list`, and on a missing model straight
// into `stop_launched_server` — so a fake binary that has not yet been scheduled dies
// without writing anything, and the line never appears at all. Measured: a faithful
// replica missed the write 0/200 idle and 0/300 under 24 CPU hogs, and the real tests
// 0/10 under 12, because the stub `curl` in between is a whole bash process; strip that
// one spawn from the replica and it loses 107/200. Thin, and on the runner class where
// #1949 did lose. Waiting eagerly would therefore turn a harmless lost race into a
// 10-second red in two tests that never look at this file. Behind a getter, only a
// caller that actually asserts on the arguments pays the wait — and for that caller the
// premise holds, since every such test is on a path the starter does not kill.
//
// The ollama harness is why the wait is for the SERVER line and not for a non-empty
// file: `ollama list` and `ollama pull` run through the same fake binary AFTER the
// server is backgrounded (start-ollama-source.sh:410+), so the file is routinely
// non-empty while the `serve` line is still missing.
import { existsSync, readFileSync } from "node:fs";

// Shared, because `Atomics.wait` needs a SharedArrayBuffer and this module is never
// re-entered concurrently — `node --test` runs each file in its own process and the
// harnesses call this synchronously from the test body.
const IDLE = new Int32Array(new SharedArrayBuffer(4));

/** How much of the file to quote when the deadline is reached. */
const QUOTE_LIMIT = 2000;

/**
 * @param {object} o
 * @param {string} o.file              path to the harness's `server.args`
 * @param {string} o.stdout            the starter's captured stdout
 * @param {RegExp} o.launchAnnouncement the stdout line printed immediately before the `&`
 * @param {RegExp} o.serverLine        matches the backgrounded invocation's own line
 * @param {number} [o.timeoutMs]       deadline for that line to appear
 * @param {number} [o.pollMs]
 * @returns {{launched: boolean, text: string}}
 * @throws when a launch was announced and `serverLine` never appeared in time
 */
export function readServerArgs({
  file,
  stdout,
  launchAnnouncement,
  serverLine,
  timeoutMs = 10000,
  pollMs = 20,
}) {
  const line = stateless(serverLine);

  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const launched = launchAnnounced(stdout, launchAnnouncement);
  if (!launched) return { launched, text: read() };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = read();
    if (line.test(text)) return { launched, text };
    if (Date.now() >= deadline) {
      throw new Error(
        `${file}: the starter announced a launch but no line matching ${line} appeared ` +
          `within ${timeoutMs}ms. Read so far: ${JSON.stringify(text.slice(0, QUOTE_LIMIT))}. ` +
          `This is refused rather than returned because an empty or partial read satisfies ` +
          `every negative assertion over server.args silently (#1949).`,
      );
    }
    Atomics.wait(IDLE, 0, 0, pollMs);
  }
}

/** Did the starter reach the line it prints immediately before backgrounding? */
export function launchAnnounced(stdout, launchAnnouncement) {
  return stateless(launchAnnouncement).test(stdout ?? "");
}

/**
 * Drops the two flags that make `.test()` STATEFUL. Both `g` and `y` advance
 * `lastIndex`, so the same pattern matches on one poll and misses on the next — a wait
 * that gives up on a file it has already seen, which is the failure this module exists
 * to remove. `y` is here because it fails identically and `g` alone reads like the
 * whole set: measured, `/^-host /my` answers true then false on the same input.
 */
function stateless(re) {
  return /[gy]/.test(re.flags) ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re;
}
