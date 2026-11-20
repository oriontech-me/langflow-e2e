// Unit tests for the shared post-collect-models health gate (issue #1045).
//
// Two halves, both load-bearing:
//
//   1. BEHAVIOUR — the four backend states the gate exists to tell apart, driven
//      against real `node:http` servers rather than a mocked fetch: healthy,
//      dead port, wedged (accepts the connection, never answers), and
//      wedged-then-recovers. The wedge cannot be reproduced in CI on demand — it
//      depends on the runner's collect-models load — so this is the only place
//      the loop is ever exercised across all four.
//
//   2. ADOPTION — a structural guard over the four workflows. The gate's whole
//      value is landing BETWEEN `Collect models` and the run step; an edit that
//      reorders or drops it would restore exactly the hole #1011/#1019/#1045
//      closed, and nothing else in CI would notice.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import {
  buildProbeUrl,
  buildWriteProbeUrl,
  classifyFailure,
  main,
  probeBackend,
  probeOnce,
  waitForBackend,
  DEFAULTS,
} from "./wait-for-backend.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Fast knobs: the loop's shape is what is under test, not its wall-clock budget.
const FAST = { probeTimeoutMs: 250, intervalS: 0.02, heartbeatEvery: 2 };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── buildProbeUrl ───────────────────────────────────────────────────────────

test("buildProbeUrl normalises the base URL manual.yml can pass in", () => {
  assert.equal(buildProbeUrl("http://localhost:7860/"), "http://localhost:7860/api/v1/version");
  assert.equal(buildProbeUrl("http://localhost:7860"), "http://localhost:7860/api/v1/version");
  assert.equal(buildProbeUrl("https://lf.example.com///"), "https://lf.example.com/api/v1/version");
  assert.equal(buildProbeUrl(""), buildProbeUrl(DEFAULTS.baseUrl));
});

// ── classifyFailure: the distinction the curl exit-code decoding bought ──────

test("classifyFailure separates dead, wedged, http and wiring failures", () => {
  assert.equal(classifyFailure({ code: "ECONNREFUSED" }).kind, "dead");
  assert.equal(classifyFailure({ code: "EHOSTUNREACH" }).kind, "dead");
  assert.equal(classifyFailure({ code: "TIMEOUT" }).kind, "wedged");
  assert.equal(classifyFailure({ code: "UND_ERR_HEADERS_TIMEOUT" }).kind, "wedged");
  assert.equal(classifyFailure({ status: 502, reason: "HTTP 502" }).kind, "http");
  assert.equal(classifyFailure({ code: "ENOTFOUND" }).kind, "other");
  assert.equal(classifyFailure(undefined).kind, "unknown");
});

test("only the wedged state is REPORTED as the wedge", () => {
  // The inline copies asserted "This is the post-collect-models wedge"
  // unconditionally — false on three of the four states, and a false attribution
  // is worse than none: it sends the next reader after the wrong bug.
  assert.match(classifyFailure({ code: "TIMEOUT" }).headline, /post-collect-models wedge \(#922/);
  for (const failure of [{ code: "ECONNREFUSED" }, { status: 503 }, { code: "ENOTFOUND" }]) {
    assert.doesNotMatch(classifyFailure(failure).headline, /This is the post-collect-models wedge/);
  }
  assert.match(classifyFailure({ code: "TIMEOUT" }).diag, /#922\/#927/);
  assert.match(classifyFailure({ status: 503 }).diag, /not the wedge/);
});

// ── State 1: healthy ────────────────────────────────────────────────────────

test("healthy backend: returns ok on the first attempt", async () => {
  const server = http.createServer((_req, res) => res.end('{"version":"1.12.0"}'));
  const port = await listen(server);
  try {
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 5,
      ...FAST,
      log: () => {},
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 1);
  } finally {
    await close(server);
  }
});

test("a backend that answers non-2xx is NOT accepted as healthy", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end("unavailable");
  });
  const port = await listen(server);
  try {
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 0.05,
      ...FAST,
      log: () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal(classifyFailure(outcome.failure).kind, "http");
  } finally {
    await close(server);
  }
});

// ── State 2: dead port ──────────────────────────────────────────────────────

test("dead port: gives up at the deadline and classifies as dead", async () => {
  // Bind and immediately release, so the port is known-free rather than guessed.
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);

  const outcome = await waitForBackend({
    url: `http://127.0.0.1:${port}/api/v1/version`,
    timeoutS: 0.1,
    ...FAST,
    log: () => {},
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.attempts >= 1);
  assert.equal(classifyFailure(outcome.failure).kind, "dead");
});

// ── State 3: wedged (accepts, never answers) ────────────────────────────────

test("wedged backend: each probe fails FAST so the loop keeps polling", async () => {
  // The wedge shape of #922/#927: the socket is accepted, no response ever
  // written. Without a per-probe deadline the loop would hang here forever —
  // exactly when it has something to report.
  const server = http.createServer(() => {});
  const port = await listen(server);
  try {
    const started = Date.now();
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 0.6,
      ...FAST,
      log: () => {},
    });
    const elapsed = Date.now() - started;
    assert.equal(outcome.ok, false);
    assert.equal(classifyFailure(outcome.failure).kind, "wedged");
    // Several attempts inside the budget — proof the probe deadline bounded each
    // GET instead of one hung request consuming the whole window.
    assert.ok(outcome.attempts >= 2, `expected repeated attempts, got ${outcome.attempts}`);
    // And the loop respected its own deadline rather than overshooting by a probe.
    assert.ok(elapsed < 3000, `loop took ${elapsed}ms for a 600ms budget`);
  } finally {
    await close(server);
    // A wedged server holds its sockets open; unref so the test process exits.
    server.unref?.();
  }
});

// ── State 4: wedged, then recovers ──────────────────────────────────────────

test("wedged-then-recovers: the budget is what buys the recovery", async () => {
  let wedged = true;
  const server = http.createServer((_req, res) => {
    if (wedged) return; // accepted, never answered
    res.end('{"version":"1.12.0"}');
  });
  const port = await listen(server);
  try {
    // Recovery mid-loop, the way gunicorn's SIGKILL + a fresh worker delivers it.
    const timer = setTimeout(() => {
      wedged = false;
    }, 300);
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 10,
      ...FAST,
      log: () => {},
    });
    clearTimeout(timer);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.attempts >= 2, "recovery must be observed by a LATER attempt, not the first");
  } finally {
    await close(server);
    server.unref?.();
  }
});

// ── Loop contract ───────────────────────────────────────────────────────────

test("a deadline shorter than one interval still gets one real attempt", async () => {
  let calls = 0;
  const outcome = await waitForBackend({
    url: "http://unused.invalid/api/v1/version",
    timeoutS: 0,
    intervalS: 30,
    probe: async () => {
      calls += 1;
      return { ok: false, code: "ECONNREFUSED" };
    },
    log: () => {},
  });
  assert.equal(calls, 1, "the deadline is checked AFTER the probe, never before");
  assert.equal(outcome.ok, false);
});

test("the heartbeat fires on the configured cadence and never after success", async () => {
  const lines = [];
  let attempt = 0;
  await waitForBackend({
    url: "http://unused.invalid/api/v1/version",
    timeoutS: 100,
    intervalS: 0,
    heartbeatEvery: 3,
    now: () => 0, // freeze the clock: only the attempt counter drives the loop
    sleep: async () => {},
    probe: async () => {
      attempt += 1;
      return attempt < 7 ? { ok: false, code: "TIMEOUT" } : { ok: true };
    },
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 2, `expected heartbeats at attempts 3 and 6, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /attempt 3, last failure TIMEOUT, 100s left of 100s/);
  assert.match(lines[1], /attempt 6/);
});

test("heartbeatEvery = 0 disables the heartbeat", async () => {
  const lines = [];
  let attempt = 0;
  await waitForBackend({
    url: "http://unused.invalid/api/v1/version",
    timeoutS: 100,
    heartbeatEvery: 0,
    now: () => 0,
    sleep: async () => {},
    probe: async () => {
      attempt += 1;
      return attempt < 5 ? { ok: false, code: "TIMEOUT" } : { ok: true };
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, []);
});

test("probeOnce recovers the errno from cause.message when cause.code is absent", async () => {
  // Observed on Node 25: some fetch failures arrive with an empty `cause` whose
  // message still carries "connect ECONNREFUSED <addr>". Reading only `cause.code`
  // there would report a DEAD backend as a generic wiring error.
  const stub = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:7860") });
  };
  const result = await probeOnce("http://127.0.0.1:7860/api/v1/version", 100, stub);
  assert.equal(result.code, "ECONNREFUSED");
  assert.equal(classifyFailure(result).kind, "dead");
});

test("probeOnce reports a timeout as TIMEOUT, not as an opaque abort", async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  try {
    const result = await probeOnce(`http://127.0.0.1:${port}/api/v1/version`, 150);
    assert.equal(result.ok, false);
    assert.equal(result.code, "TIMEOUT");
  } finally {
    await close(server);
    server.unref?.();
  }
});

// ── State 5: the database will not take a write (#2405) ─────────────────────

// The od-20261109-e3743682 shape: the event loop answers `/api/v1/version`, while
// `auto_login` (which writes) never returns because SQLite is locked.
function lockedDbServer({ writeStatus, unlockAfter = Infinity } = {}) {
  const seen = [];
  let writes = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/api/v1/auto_login") {
      writes += 1;
      if (writes > unlockAfter) return res.end('{"access_token":"t"}');
      if (writeStatus) {
        res.statusCode = writeStatus;
        return res.end("{}");
      }
      return; // locked: accepted, never answered
    }
    res.end('{"version":"1.14.0"}');
  });
  return { server, seen };
}

test("buildWriteProbeUrl keeps the base URL and any path prefix it carries", () => {
  assert.equal(buildWriteProbeUrl("http://localhost:7860/"), "http://localhost:7860/api/v1/auto_login");
  assert.equal(buildWriteProbeUrl("https://lf.example.com/prefix/"), "https://lf.example.com/prefix/api/v1/auto_login");
});

test("a locked database is NOT accepted as healthy, and is classified as db, not as the wedge", async () => {
  const { server, seen } = lockedDbServer();
  const port = await listen(server);
  try {
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 0.4,
      ...FAST,
      log: () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure.stage, "write");
    const verdict = classifyFailure(outcome.failure);
    assert.equal(verdict.kind, "db");
    assert.match(verdict.diag, /#2405/);
    assert.match(verdict.headline, /NOT the post-collect-models wedge/);
    assert.ok(seen.includes("/api/v1/version") && seen.includes("/api/v1/auto_login"));
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("a database that unlocks within the budget lets the gate pass", async () => {
  const { server } = lockedDbServer({ unlockAfter: 2 });
  const port = await listen(server);
  try {
    const outcome = await waitForBackend({
      url: `http://127.0.0.1:${port}/api/v1/version`,
      timeoutS: 5,
      ...FAST,
      log: () => {},
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.writeUnverified, false);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("a write probe answering 5xx is a db failure that names the status", async () => {
  const { server } = lockedDbServer({ writeStatus: 500 });
  const port = await listen(server);
  try {
    const result = await probeBackend(`http://127.0.0.1:${port}/api/v1/version`, 500);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "write");
    assert.equal(classifyFailure(result).kind, "db");
    assert.match(classifyFailure(result).diag, /answered HTTP 500/);
  } finally {
    await close(server);
  }
});

test("auto-login disabled (403) passes the gate but marks the write path unverified", async () => {
  const { server } = lockedDbServer({ writeStatus: 403 });
  const port = await listen(server);
  const lines = [];
  try {
    const result = await probeBackend(`http://127.0.0.1:${port}/api/v1/version`, 500);
    assert.equal(result.ok, true);
    assert.equal(result.writeUnverified, true);

    const code = await main(
      { WAIT_BASE_URL: `http://127.0.0.1:${port}`, WAIT_TIMEOUT_S: "5", WAIT_PROBE_TIMEOUT_MS: "500" },
      (line) => lines.push(line),
    );
    const out = lines.join("\n");
    assert.equal(code, 0);
    assert.match(out, /::warning::\/api\/v1\/auto_login answered 403/);
    assert.match(out, /could NOT check that the database accepts writes/);
    assert.doesNotMatch(out, /answered \/api\/v1\/version and \/api\/v1\/auto_login/);
  } finally {
    await close(server);
  }
});

test("the write probe is never sent while the version probe is failing", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.statusCode = 503;
    res.end("{}");
  });
  const port = await listen(server);
  try {
    const result = await probeBackend(`http://127.0.0.1:${port}/api/v1/version`, 500);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "version");
    assert.equal(classifyFailure(result).kind, "http");
    assert.deepEqual(seen, ["/api/v1/version"]);
  } finally {
    await close(server);
  }
});

test("main names auto_login and #2405 when the database will not take a write", async () => {
  const { server } = lockedDbServer();
  const port = await listen(server);
  const lines = [];
  try {
    const code = await main(
      {
        WAIT_BASE_URL: `http://127.0.0.1:${port}/`,
        WAIT_TIMEOUT_S: "0.4",
        WAIT_PROBE_TIMEOUT_MS: "150",
        WAIT_INTERVAL_S: "0.02",
        WAIT_NEXT_STEP_LABEL: "the @stable round of shard 2",
      },
      (line) => lines.push(line),
    );
    const out = lines.join("\n");
    assert.equal(code, 1);
    assert.match(out, /::error::Langflow did not answer \/api\/v1\/auto_login within/);
    assert.match(out, /SQLite-lock shape of #2405/);
    assert.match(out, /would fail every test in auth/);
    assert.doesNotMatch(out, /abort in globalSetup/);
    assert.doesNotMatch(out, /This is the post-collect-models wedge/);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("main reports both paths when the backend is healthy", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  const port = await listen(server);
  const lines = [];
  try {
    const code = await main(
      { WAIT_BASE_URL: `http://127.0.0.1:${port}`, WAIT_TIMEOUT_S: "5", WAIT_PROBE_TIMEOUT_MS: "500" },
      (line) => lines.push(line),
    );
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /answered \/api\/v1\/version and \/api\/v1\/auto_login/);
    assert.doesNotMatch(lines.join("\n"), /::warning::/);
  } finally {
    await close(server);
  }
});

// ── main(): the exit code and the message the lane actually reads ────────────

test("main returns 0 and names the next step on a healthy backend", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  const port = await listen(server);
  const lines = [];
  try {
    const code = await main(
      {
        WAIT_BASE_URL: `http://127.0.0.1:${port}`,
        WAIT_TIMEOUT_S: "5",
        WAIT_PROBE_TIMEOUT_MS: "500",
        WAIT_NEXT_STEP_LABEL: "the @stable run",
      },
      (line) => lines.push(line),
    );
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /proceeding to the @stable run/);
    assert.doesNotMatch(lines.join("\n"), /::error::/);
  } finally {
    await close(server);
  }
});

test("main returns 1 and attributes the failure to the wedge, not to the tests", async () => {
  const server = http.createServer(() => {}); // wedged
  const port = await listen(server);
  const lines = [];
  try {
    const code = await main(
      {
        WAIT_BASE_URL: `http://127.0.0.1:${port}/`,
        WAIT_TIMEOUT_S: "0.4",
        WAIT_PROBE_TIMEOUT_MS: "150",
        WAIT_INTERVAL_S: "0.02",
        WAIT_NEXT_STEP_LABEL: "the impacted-specs run",
        WAIT_ATTRIBUTION: "NOT a failure of the specs this PR touches",
      },
      (line) => lines.push(line),
    );
    const out = lines.join("\n");
    assert.equal(code, 1);
    assert.match(out, /::error::/);
    assert.match(out, /WEDGE shape of #922\/#927/);
    assert.match(out, /the impacted-specs run would abort in globalSetup/);
    assert.match(out, /This is the post-collect-models wedge/);
    assert.match(out, /NOT a failure of the specs this PR touches/);
  } finally {
    await close(server);
    server.unref?.();
  }
});

test("a failed Collect models is surfaced as a warning without gating the run", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  const port = await listen(server);
  const lines = [];
  try {
    const code = await main(
      {
        WAIT_BASE_URL: `http://127.0.0.1:${port}`,
        WAIT_TIMEOUT_S: "5",
        WAIT_PROBE_TIMEOUT_MS: "500",
        WAIT_COLLECT_MODELS_OUTCOME: "failure",
      },
      (line) => lines.push(line),
    );
    // The whole point of #980: the sweep's red is reported, never fatal.
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /::warning::Collect models FAILED/);
  } finally {
    await close(server);
  }
});

test("a successful Collect models emits no warning", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  const port = await listen(server);
  const lines = [];
  try {
    await main(
      {
        WAIT_BASE_URL: `http://127.0.0.1:${port}`,
        WAIT_TIMEOUT_S: "5",
        WAIT_PROBE_TIMEOUT_MS: "500",
        WAIT_COLLECT_MODELS_OUTCOME: "success",
      },
      (line) => lines.push(line),
    );
    assert.doesNotMatch(lines.join("\n"), /::warning::/);
  } finally {
    await close(server);
  }
});

test("a non-numeric or empty timeout falls back to the 420 s default", async () => {
  // `inputs.recover_timeout_s || '420'` cannot produce garbage, but a hand-edited
  // `with:` can — and a deadline silently parsed as 0 would turn the gate into a
  // single probe, which is the failure mode hardest to notice in a green log.
  const lines = [];
  await main(
    { WAIT_BASE_URL: "http://127.0.0.1:1/", WAIT_TIMEOUT_S: "abc", WAIT_PROBE_TIMEOUT_MS: "50", WAIT_INTERVAL_S: "0.01" },
    (line) => {
      lines.push(line);
      // Abort the (real) 420 s wait as soon as the intent is proven.
      if (/Waiting up to 420s/.test(line)) throw new Error("stop");
    },
  ).catch((err) => {
    if (err.message !== "stop") throw err;
  });
  assert.match(lines[0], /Waiting up to 420s/);
});

// ── Adoption guard: the gate must stay wired into every lane ─────────────────

const LANES = [
  { file: "daily-stable.yml", nextRun: "Run @stable tests" },
  { file: "pr-validation.yml", nextRun: "Run impacted specs" },
  { file: "manual.yml", nextRun: "Run tests and upload report" },
];

// Line-based rather than YAML-parsed on purpose: the repo ships no YAML parser,
// and what matters here is ORDER of named steps, which lines express directly.
function stepIndex(text, needle) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  return i;
}

for (const lane of LANES) {
  test(`${lane.file} runs the shared gate between Collect models and ${lane.nextRun}`, () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", lane.file), "utf8");

    const collect = stepIndex(text, "- name: Collect models");
    const gate = stepIndex(text, "uses: ./.github/actions/wait-for-backend");
    const run = stepIndex(text, `- name: ${lane.nextRun}`);

    assert.ok(collect > -1, "no `Collect models` step found");
    assert.ok(gate > -1, "the lane does not use ./.github/actions/wait-for-backend (#1045)");
    assert.ok(run > -1, `no \`${lane.nextRun}\` step found`);
    assert.ok(collect < gate, "the gate must come AFTER Collect models — before it, there is no wedge to wait out");
    assert.ok(gate < run, "the gate must come BEFORE the run step, or globalSetup reports the wedge unattributed");
  });

  test(`${lane.file} no longer carries an inline copy of the polling loop`, () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", lane.file), "utf8");
    // Keyed on the inline loop's own marker variable rather than on `curl`: these
    // workflows legitimately curl /api/v1/version elsewhere (capturing the Langflow
    // version for the run summary), and a guard that banned the URL outright would
    // fail on those instead of on a resurrected gate.
    const inline = text.split("\n").filter((l) => l.includes("RECOVER_TIMEOUT_S"));
    assert.deepEqual(inline, [], `inline gate loop still present in ${lane.file}`);
  });
}

test("pr-validation gates the health check on the same condition as Collect models", () => {
  // The gate exists to wait out the SWEEP. Running it when the sweep was skipped
  // (an LLM-free PR, #953) would make an unrelated startup failure this step's
  // problem instead of globalSetup's, and would bill every LLM-free PR for the
  // wait. Both steps must therefore carry `needs_models == 'true'`.
  const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"), "utf8");
  const lines = text.split("\n");
  const gate = lines.findIndex((l) => l.includes("uses: ./.github/actions/wait-for-backend"));
  assert.ok(gate > -1);
  // The `if:` sits within the same step block, just above or below the `uses:`.
  const block = lines.slice(Math.max(0, gate - 4), gate + 6).join("\n");
  assert.match(block, /needs\.detect-specs\.outputs\.needs_models == 'true'/);
});

test("the daily still honours its recover_timeout_s dispatch input", () => {
  // The input is how a validation dispatch shortens the wait without editing the
  // file; extracting the loop must not have orphaned it.
  const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8");
  assert.match(text, /recover_timeout_s:/);
  assert.match(text, /timeout_s: \$\{\{ inputs\.recover_timeout_s \|\| '420' \}\}/);
});
