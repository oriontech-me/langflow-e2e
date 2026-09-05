// Unit tests for the in-run backend liveness recorder (issue #1030).
// Run with: node --test scripts/watch-backend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProbes, summarizeProbes } from "./watch-backend.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./watch-backend.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe log shaped like the real one: 2 s cadence, backend answers, drops for
// three probes, answers again.
const probeLog = [
  '{"t":"2026-07-29T10:42:00.000Z","ok":true,"ms":11}',
  '{"t":"2026-07-29T10:42:02.000Z","ok":true,"ms":9}',
  '{"t":"2026-07-29T10:42:04.000Z","ok":false,"ms":4001,"reason":"timeout>4000ms"}',
  '{"t":"2026-07-29T10:42:08.000Z","ok":false,"ms":4002,"reason":"timeout>4000ms"}',
  '{"t":"2026-07-29T10:42:12.000Z","ok":false,"ms":4000,"reason":"timeout>4000ms"}',
  '{"t":"2026-07-29T10:42:16.000Z","ok":true,"ms":15}',
  '{"t":"2026-07-29T10:42:18.000Z","ok":true,"ms":12}',
].join("\n");

test("parseProbes reads probe lines and tolerates a torn tail", () => {
  // The recorder is killed mid-append when the job moves on, so the last line
  // can be partial — that must degrade the summary, not break it.
  const probes = parseProbes(probeLog + '\n{"t":"2026-07-29T10:42:2');
  assert.equal(probes.length, 7);
  assert.equal(probes[0].ok, true);
  assert.equal(probes[2].reason, "timeout>4000ms");
});

test("parseProbes sorts by timestamp and drops records without a usable one", () => {
  const probes = parseProbes(
    [
      '{"t":"2026-07-29T10:42:04.000Z","ok":true}',
      '{"t":"2026-07-29T10:42:00.000Z","ok":true}',
      '{"ok":false}',
      '{"t":"not-a-date","ok":false}',
    ].join("\n"),
  );
  assert.deepEqual(
    probes.map((p) => p.t),
    [Date.parse("2026-07-29T10:42:00.000Z"), Date.parse("2026-07-29T10:42:04.000Z")],
  );
});

test("summarizeProbes bounds the outage between the first failure and the recovery", () => {
  const s = summarizeProbes(parseProbes(probeLog));
  assert.equal(s.measured, true);
  assert.equal(s.outageCount, 1);
  assert.equal(s.probeCount, 7);
  assert.equal(s.failedProbes, 3);
  const [w] = s.windows;
  assert.equal(w.startAt, "2026-07-29T10:42:04.000Z");
  assert.equal(w.endAt, "2026-07-29T10:42:16.000Z"); // first probe that answered again
  assert.equal(w.seconds, 12);
  assert.equal(w.openEnded, false);
  assert.equal(s.downSeconds, 12);
  assert.equal(s.spanSeconds, 18);
  assert.equal(s.downPct, 66.7);
});

test("summarizeProbes ignores a single-probe blip but honours minProbes", () => {
  const log = [
    '{"t":"2026-07-29T10:00:00.000Z","ok":true}',
    '{"t":"2026-07-29T10:00:02.000Z","ok":false}',
    '{"t":"2026-07-29T10:00:04.000Z","ok":true}',
  ].join("\n");
  const ignored = summarizeProbes(parseProbes(log));
  assert.equal(ignored.outageCount, 0);
  assert.equal(ignored.ignoredBlips, 1);
  assert.equal(ignored.downSeconds, 0);

  // A caller that wants every failed probe counted can say so.
  const counted = summarizeProbes(parseProbes(log), { minProbes: 1 });
  assert.equal(counted.outageCount, 1);
  assert.equal(counted.ignoredBlips, 0);
});

test("summarizeProbes marks a log that ends while down as open-ended", () => {
  const s = summarizeProbes(
    parseProbes(
      [
        '{"t":"2026-07-29T10:00:00.000Z","ok":true}',
        '{"t":"2026-07-29T10:00:02.000Z","ok":false}',
        '{"t":"2026-07-29T10:00:04.000Z","ok":false}',
        '{"t":"2026-07-29T10:00:06.000Z","ok":false}',
      ].join("\n"),
    ),
  );
  assert.equal(s.outageCount, 1);
  assert.equal(s.windows[0].openEnded, true);
  // Closed at the LAST FAILED probe, never extrapolated past what was observed.
  assert.equal(s.windows[0].endAt, "2026-07-29T10:00:06.000Z");
  assert.equal(s.windows[0].seconds, 4);
});

test("summarizeProbes reports an empty log as NOT measured", () => {
  const s = summarizeProbes(parseProbes(""));
  // measured=false is the load-bearing distinction: it must never be rendered
  // as "the backend stayed up".
  assert.equal(s.measured, false);
  assert.equal(s.outageCount, 0);
  assert.equal(s.downPct, 0);
});

test("--summarize writes a shard-labelled summary carrying the shard's spec list", () => {
  const dir = makeTempDir("liveness-");
  const jsonl = join(dir, "probes.jsonl");
  const out = join(dir, "summary.json");
  writeFileSync(jsonl, probeLog + "\n");

  const stdout = execFileSync(process.execPath, [SCRIPT, "--summarize"], {
    encoding: "utf8",
    env: {
      ...process.env,
      WATCH_OUT: jsonl,
      WATCH_SUMMARY: out,
      WATCH_LABEL: "3",
      WATCH_FILES: "tests-automations/regression/a.spec.ts tests-automations/regression/b.spec.ts",
    },
  });

  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.shard, "3");
  assert.equal(summary.outageCount, 1);
  assert.deepEqual(summary.files, [
    "tests-automations/regression/a.spec.ts",
    "tests-automations/regression/b.spec.ts",
  ]);
  assert.match(stdout, /shard 3: 1 outage\(s\)/);
});

test("--summarize on a missing probe log writes an UNMEASURED summary and exits 0", () => {
  const dir = makeTempDir("liveness-");
  const out = join(dir, "summary.json");
  const stdout = execFileSync(process.execPath, [SCRIPT, "--summarize"], {
    encoding: "utf8",
    env: { ...process.env, WATCH_OUT: join(dir, "absent.jsonl"), WATCH_SUMMARY: out, WATCH_LABEL: "2" },
  });
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.measured, false);
  assert.equal(summary.outageCount, 0);
  assert.match(stdout, /NOT MEASURED/);
});

// End-to-end proof that the recorder detects a REAL outage: probe a local
// server, take it away, bring it back. This is the behaviour the whole
// mechanism rests on — a wedged backend accepts nothing and the probe must
// record a failure rather than hang.
test("the recorder records an outage while the target is gone", async () => {
  const dir = makeTempDir("liveness-");
  const jsonl = join(dir, "probes.jsonl");
  const summaryPath = join(dir, "summary.json");

  const server = http.createServer((_req, res) => res.end('{"version":"test"}'));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      WATCH_URL: `http://127.0.0.1:${port}/api/v1/version`,
      WATCH_OUT: jsonl,
      WATCH_INTERVAL_MS: "100",
      WATCH_TIMEOUT_MS: "300",
      WATCH_MAX_SECONDS: "30",
    },
    stdio: "ignore",
  });

  try {
    await sleep(600); // a few healthy probes
    // closeAllConnections(): undici keeps the socket alive, so without this the
    // probe could linger on an established connection instead of failing.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await sleep(900); // several failing probes → one window
    const revived = http.createServer((_req, res) => res.end('{"version":"test"}'));
    await new Promise((resolve) => revived.listen(port, "127.0.0.1", resolve));
    await sleep(600); // recovery probes close the window
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => revived.close(resolve));

    execFileSync(process.execPath, [SCRIPT, "--summarize"], {
      env: { ...process.env, WATCH_OUT: jsonl, WATCH_SUMMARY: summaryPath, WATCH_LABEL: "e2e" },
      stdio: "ignore",
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(summary.measured, true);
    assert.ok(summary.probeCount >= 8, `expected several probes, got ${summary.probeCount}`);
    assert.equal(summary.outageCount, 1, `expected exactly one outage, got ${summary.outageCount}`);
    assert.equal(summary.windows[0].openEnded, false, "the window must close once the target answers again");
    assert.ok(summary.downSeconds > 0.3, `outage looked too short: ${summary.downSeconds}s`);
  } finally {
    child.kill("SIGKILL");
    server.close();
  }
});
