// Unit tests for scripts/lib/server-args.mjs.
// Run with: npm run test:scripts
//
// What these protect: the two halves of #1949. The LOUD half is that a positive
// assertion over `server.args` must not read an empty file (`-max-duration NaNs`).
// The QUIET half is the one worth the module — three assertions over that file are
// negative, and an empty read satisfies them with no symptom at all, so the reader
// has to REFUSE rather than return "". Both are asserted here, plus the two shapes
// that made the first draft wrong: a file that is non-empty and still missing the
// server line, and a `g`-flagged pattern carrying `lastIndex` between polls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "./tmp-dir.mjs";
import { readServerArgs } from "./server-args.mjs";

const ANNOUNCE = /^Starting go-httpbin /m;
const SERVER = /^-host /m;

function ctx(name) {
  return join(makeTempDir(`server-args-test-${name}-`), "server.args");
}

test("no launch announced: the file is read once and the answer is immediate", () => {
  const file = ctx("nolaunch");
  const started = Date.now();
  const r = readServerArgs({
    file,
    stdout: "ERROR: OLLAMA_STOP_TIMEOUT_S must be a positive integer\n",
    launchAnnouncement: ANNOUNCE,
    serverLine: SERVER,
    timeoutMs: 3000,
  });
  // The whole point of the branch: a refusal before launch must not pay the deadline,
  // which is what an unconditional wait would cost every such case in both harnesses.
  assert.ok(Date.now() - started < 500, "it waited for a launch that never happened");
  assert.equal(r.launched, false);
  assert.equal(r.text, "");
});

test("no launch announced, but a version probe ran: its line is returned", () => {
  const file = ctx("version-only");
  writeFileSync(file, "-version\n");
  const r = readServerArgs({
    file,
    stdout: "Installed go-httpbin\n",
    launchAnnouncement: ANNOUNCE,
    serverLine: SERVER,
  });
  assert.equal(r.launched, false);
  assert.equal(r.text, "-version\n");
});

test("launch announced and the line is already there: no wait", () => {
  const file = ctx("present");
  writeFileSync(file, "-version\n-host 10.0.0.5 -port 8080 -max-duration 60s\n");
  const started = Date.now();
  const r = readServerArgs({
    file,
    stdout: "Starting go-httpbin 2.18.3 on 10.0.0.5:8080\n",
    launchAnnouncement: ANNOUNCE,
    serverLine: SERVER,
    timeoutMs: 3000,
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(r.launched, true);
  assert.match(r.text, /-max-duration 60s/);
});

test("launch announced and the line arrives late: it is waited for, not missed", async () => {
  const file = ctx("late");
  writeFileSync(file, "-version\n");
  // The real shape: the backgrounded process reaches its first instruction after the
  // starter has already exited 0. Detached so this call does not block on it.
  const writer = spawn(
    "bash",
    ["-c", `sleep 0.5; printf -- '-host 10.0.0.5 -port 8080 -max-duration 60s\\n' >> ${JSON.stringify(file)}`],
    { stdio: "ignore" },
  );
  try {
    const r = readServerArgs({
      file,
      stdout: "Starting go-httpbin 2.18.3 on 10.0.0.5:8080\n",
      launchAnnouncement: ANNOUNCE,
      serverLine: SERVER,
      timeoutMs: 5000,
    });
    assert.equal(r.launched, true);
    // Both lines: the wait must not truncate the file to the line it waited for.
    assert.match(r.text, /^-version$/m);
    assert.equal(Number(r.text.match(/-max-duration (\d+)s/)?.[1]), 60);
  } finally {
    writer.kill();
  }
});

test("launch announced and the line never arrives: it throws, naming the file and the pattern", () => {
  const file = ctx("never");
  const started = Date.now();
  assert.throws(
    () =>
      readServerArgs({
        file,
        stdout: "Starting go-httpbin 2.18.3 on 10.0.0.5:8080\n",
        launchAnnouncement: ANNOUNCE,
        serverLine: SERVER,
        timeoutMs: 400,
      }),
    (err) => {
      assert.match(err.message, /server\.args/);
      assert.match(err.message, /-host/);
      assert.match(err.message, /1949/);
      return true;
    },
  );
  // Refusing is the requirement; paying roughly the stated deadline to do it is how
  // the caller knows the wait ran rather than the pattern being wrong on sight.
  assert.ok(Date.now() - started >= 350, "it gave up before the deadline");
});

test("a non-empty file without the server line is still a miss", () => {
  const file = ctx("partial");
  // The ollama shape: `list` and `pull` go through the same fake binary AFTER the
  // server is backgrounded, so "the file has content" is not "the server registered".
  writeFileSync(file, "--version host=unset\nlist host=10.0.0.5:11434\n");
  assert.throws(() =>
    readServerArgs({
      file,
      stdout: "Starting Ollama 0.12.0 on 10.0.0.5:11434\n",
      launchAnnouncement: /^Starting Ollama /m,
      serverLine: /^serve /m,
      timeoutMs: 300,
    }),
  );
});

test("a g-flagged pattern does not carry lastIndex between calls or polls", () => {
  const file = ctx("global");
  writeFileSync(file, "-host 10.0.0.5 -port 8080 -max-duration 60s\n");
  const sticky = /^-host /gm;
  const stdout = "Starting go-httpbin 2.18.3 on 10.0.0.5:8080\n";
  const args = { file, stdout, launchAnnouncement: /^Starting go-httpbin /gm, serverLine: sticky, timeoutMs: 400 };
  assert.equal(readServerArgs(args).launched, true);
  // Second call: with the flag left on, `lastIndex` sits past the only match and this
  // one waits out the deadline and throws on a file it has already accepted.
  assert.equal(readServerArgs(args).launched, true);
});

test("the wait polls rather than sampling once, so a line written mid-flight is seen", () => {
  const file = ctx("midflight");
  writeFileSync(file, "-version\n");
  const t0 = Date.now();
  const writer = spawn("bash", ["-c", `sleep 0.2; printf -- '-host 1.2.3.4\\n' >> ${JSON.stringify(file)}`], {
    stdio: "ignore",
  });
  try {
    const r = readServerArgs({
      file,
      stdout: "Starting go-httpbin 2.18.3 on 1.2.3.4:8080\n",
      launchAnnouncement: ANNOUNCE,
      serverLine: SERVER,
      timeoutMs: 4000,
      pollMs: 10,
    });
    assert.equal(r.launched, true);
    // Returned well before the deadline: a reader that only re-read at the deadline
    // would also pass the assertion above while costing every caller the full wait.
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    writer.kill();
  }
});

test("a file that grows after the match is not re-read: the returned text is the matching read", () => {
  const file = ctx("stable");
  writeFileSync(file, "-host 1.2.3.4\n");
  const r = readServerArgs({
    file,
    stdout: "Starting go-httpbin 2.18.3 on 1.2.3.4:8080\n",
    launchAnnouncement: ANNOUNCE,
    serverLine: SERVER,
  });
  appendFileSync(file, "-host 5.6.7.8\n");
  assert.equal(r.text, "-host 1.2.3.4\n");
});
