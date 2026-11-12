// Unit tests for scripts/destination-reachability-alarm.sh.
// Run with: npm run test:scripts
//
// What these protect is the balance #2422 asked for: a blip that clears by itself
// never reaches the channel, an outage does before the daily pays for it, and each
// outage is one message down and one message back, not one per hour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "destination-reachability-alarm.sh");
const UP = 0;
const DOWN = 1;
const UNKNOWN = 2;

/** Runs the alarm once with the probe stubbed to a fixed answer, and captures any POST. */
function look(
  dir,
  exitCode,
  { webhook = true, httpStatus = "200", announce = false, threshold, reason, extraEnv = {}, lane } = {},
) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const sent = join(dir, "sent.txt");
  rmSync(sent, { force: true });
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\ncat >> ${JSON.stringify(sent)}\nprintf '%s' ${JSON.stringify(httpStatus)}\n`,
    { mode: 0o755 },
  );
  const probe = join(bin, "probe-stub");
  const text =
    reason ??
    {
      [UP]: "ports open",
      [DOWN]: "no connection on port(s) 22 443",
      [UNKNOWN]: "could not tell",
    }[exitCode];
  writeFileSync(probe, `#!/bin/sh\necho '${text}'\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  const secrets = join(dir, "secrets.env");
  const url = typeof webhook === "string" ? webhook : "https://example.invalid/hook";
  writeFileSync(secrets, webhook ? `export SLACK_WEBHOOK_URL=${JSON.stringify(url)}\n` : "\n");
  const laneFile = join(dir, "lane.env");
  writeFileSync(laneFile, lane ?? "ISSUE_HOST=ghe.example.invalid\nISSUE_REPO=org/repo\n");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROBE_BIN: probe,
    STATE_DIR: join(dir, "state"),
    SECRETS_FILE: secrets,
    LANE_FILE: laneFile,
    ANNOUNCE: announce ? "1" : "0",
  };
  Object.assign(env, extraEnv);
  if (exitCode === null) delete env.PROBE_BIN;
  if (threshold !== undefined) env.THRESHOLD = String(threshold);
  else delete env.THRESHOLD;
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
  return { ...r, posted: existsSync(sent) ? readFileSync(sent, "utf8") : "" };
}

const alerted = (dir) => existsSync(join(dir, "state", "destination-reachability.alerted"));

test("a blip of two down looks clears by itself and never reaches the channel", () => {
  const dir = makeTempDir("reach-blip");
  for (const code of [UP, DOWN, DOWN, UP]) {
    const r = look(dir, code);
    assert.equal(r.status, 0);
    assert.equal(r.posted, "", `posted on ${code}`);
  }
  assert.equal(alerted(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("the third consecutive down look posts once, and the fourth does not post again", () => {
  const dir = makeTempDir("reach-outage");
  look(dir, DOWN);
  look(dir, DOWN);
  const third = look(dir, DOWN);
  assert.match(third.posted, /cannot reach ghe\.example\.invalid/);
  assert.match(third.posted, /3 checks in a row/);
  assert.match(third.posted, /will not pull the suite or open its umbrella/);
  assert.match(third.posted, /no connection on port\(s\) 22 443/);
  assert.equal(alerted(dir), true);
  const fourth = look(dir, DOWN);
  assert.equal(fourth.posted, "");
  assert.match(fourth.stdout, /already announced/);
  rmSync(dir, { recursive: true, force: true });
});

test("recovery after an announced outage posts once, and only then", () => {
  const dir = makeTempDir("reach-recovery");
  for (let i = 0; i < 3; i++) look(dir, DOWN);
  const back = look(dir, UP);
  assert.match(back.posted, /reaches ghe\.example\.invalid again/);
  assert.equal(alerted(dir), false);
  assert.equal(look(dir, UP).posted, "");
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown look neither breaks nor extends a streak", () => {
  const dir = makeTempDir("reach-unknown");
  look(dir, DOWN);
  look(dir, DOWN);
  assert.equal(look(dir, UNKNOWN).posted, "");
  // Still two downs: the unknown did not count as the third.
  assert.equal(alerted(dir), false);
  assert.match(look(dir, DOWN).posted, /3 checks in a row/);
  rmSync(dir, { recursive: true, force: true });
});

test("THRESHOLD is honoured, and a bad value falls back to 3", () => {
  const dir = makeTempDir("reach-threshold");
  assert.match(look(dir, DOWN, { threshold: 1 }).posted, /1 checks in a row/);
  rmSync(dir, { recursive: true, force: true });
  const bad = makeTempDir("reach-threshold-bad");
  look(bad, DOWN, { threshold: "x" });
  const second = look(bad, DOWN, { threshold: "x" });
  assert.equal(second.posted, "");
  assert.match(second.stdout, /using 3/);
  rmSync(bad, { recursive: true, force: true });
});

test("before the daily, one down look is enough to post; up and unknown say nothing", () => {
  const dir = makeTempDir("reach-announce");
  const r = look(dir, DOWN, { announce: true });
  assert.match(r.posted, /daily starts in about 30 minutes/);
  assert.match(r.posted, /1 check\(s\) in a row/);
  // Announced: the channel heard it is down, so it must hear when it is back.
  assert.equal(alerted(dir), true);
  rmSync(dir, { recursive: true, force: true });
  for (const code of [UP, UNKNOWN]) {
    const d = makeTempDir("reach-announce-quiet");
    assert.equal(look(d, code, { announce: true }).posted, "");
    rmSync(d, { recursive: true, force: true });
  }
});

test("an undelivered alarm is not marked as given, so the next look tries again", () => {
  const dir = makeTempDir("reach-undelivered");
  look(dir, DOWN);
  look(dir, DOWN);
  const failed = look(dir, DOWN, { httpStatus: "404" });
  assert.match(failed.stdout, /not accepted \(HTTP 404\)/);
  assert.equal(alerted(dir), false);
  assert.match(look(dir, DOWN).posted, /4 checks in a row/);
  assert.equal(alerted(dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test("no webhook: it says so on stdout and exits 0", () => {
  const dir = makeTempDir("reach-no-webhook");
  const r = look(dir, DOWN, { webhook: false, threshold: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no SLACK_WEBHOOK_URL — said here only/);
  rmSync(dir, { recursive: true, force: true });
});

test("a Workflow Builder webhook gets the flat variables, a plain one gets text", () => {
  const dir = makeTempDir("reach-transport");
  const wf = JSON.parse(
    look(dir, DOWN, {
      threshold: 1,
      webhook: "https://hooks.slack.com/triggers/T/1/x",
    }).posted,
  );
  assert.deepEqual(Object.keys(wf).sort(), ["body", "headline", "links"]);
  assert.match(wf.headline, /^🚨 QA VM cannot reach the destination/);
  assert.match(wf.links, /^Runbook: https:\/\/\S+\/ops\/runbooks\/destination-unreachable\.md$/);
  rmSync(dir, { recursive: true, force: true });
  const d2 = makeTempDir("reach-transport-text");
  const plain = JSON.parse(look(d2, DOWN, { threshold: 1 }).posted);
  assert.deepEqual(Object.keys(plain), ["text"]);
  assert.match(plain.text, /^:rotating_light: The QA VM cannot reach/);
  assert.match(plain.text, /\nRunbook: <https:\/\/\S+\/ops\/runbooks\/destination-unreachable\.md\|what to do>$/);
  rmSync(d2, { recursive: true, force: true });
});

test("every message links the runbook, recovery included; RUNBOOK_URL='' drops the link", () => {
  const dir = makeTempDir("reach-runbook");
  const runbook = { RUNBOOK_URL: "https://example.test/runbook.md" };
  const down = JSON.parse(look(dir, DOWN, { threshold: 1, extraEnv: runbook }).posted);
  assert.match(down.text, /\nRunbook: <https:\/\/example\.test\/runbook\.md\|what to do>$/);
  const up = JSON.parse(look(dir, UP, { threshold: 1, extraEnv: runbook }).posted);
  assert.match(up.text, /reaches .* again/);
  assert.match(up.text, /\nRunbook: <https:\/\/example\.test\/runbook\.md\|what to do>$/);
  rmSync(dir, { recursive: true, force: true });

  const d2 = makeTempDir("reach-runbook-off");
  const off = JSON.parse(look(d2, DOWN, { threshold: 1, extraEnv: { RUNBOOK_URL: "" } }).posted);
  assert.doesNotMatch(off.text, /Runbook/);
  rmSync(d2, { recursive: true, force: true });
  const d3 = makeTempDir("reach-runbook-off-wf");
  const wf = JSON.parse(
    look(d3, DOWN, {
      threshold: 1,
      webhook: "https://hooks.slack.com/triggers/T/1/x",
      extraEnv: { RUNBOOK_URL: "" },
    }).posted,
  );
  assert.equal(wf.links, "");
  rmSync(d3, { recursive: true, force: true });
});

test("the history keeps one tab-separated line per look, reason included", () => {
  const dir = makeTempDir("reach-history");
  look(dir, UP);
  look(dir, DOWN, { reason: "tab\there" });
  const lines = readFileSync(join(dir, "state", "destination-reachability.history"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => l.split("\t")[1]),
    ["up", "down"],
  );
  assert.equal(lines[1].split("\t").length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("announce then hourly: one alarm, not two, and the recovery still comes", () => {
  const dir = makeTempDir("reach-announce-then-hourly");
  look(dir, DOWN);
  assert.match(look(dir, DOWN, { announce: true }).posted, /daily starts in about 30 minutes/);
  // The announce look is not recorded, and the outage is already announced.
  const hourly = look(dir, DOWN);
  assert.equal(hourly.posted, "");
  assert.match(hourly.stdout, /already announced/);
  assert.match(look(dir, UP).posted, /reaches ghe\.example\.invalid again/);
  assert.equal(alerted(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("an announce look does not count toward the hourly streak", () => {
  const dir = makeTempDir("reach-announce-not-counted");
  look(dir, DOWN);
  look(dir, DOWN, { announce: true, webhook: false });
  const hist = readFileSync(join(dir, "state", "destination-reachability.history"), "utf8")
    .trim()
    .split("\n");
  assert.equal(hist.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("during an announced outage the pre-daily look is a reminder with the outage's start", () => {
  const dir = makeTempDir("reach-reminder");
  for (let i = 0; i < 3; i++) look(dir, DOWN);
  const r = look(dir, DOWN, { announce: true });
  assert.match(r.posted, /Reminder: the daily starts in about 30 minutes and the QA VM still cannot reach/);
  assert.match(r.posted, /since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.doesNotMatch(r.posted, /1970/);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed recovery post is retried at the next up look", () => {
  const dir = makeTempDir("reach-recovery-retry");
  for (let i = 0; i < 3; i++) look(dir, DOWN);
  assert.match(look(dir, UP, { httpStatus: "500" }).stdout, /not accepted \(HTTP 500\)/);
  assert.equal(alerted(dir), true);
  assert.match(look(dir, UP).posted, /again/);
  assert.equal(alerted(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("an unwritable history still counts this look: the alarm is not silenced", () => {
  const dir = makeTempDir("reach-unwritable");
  // A directory where the history file should be: every write is refused.
  mkdirSync(join(dir, "state", "destination-reachability.history"), {
    recursive: true,
  });
  const r = look(dir, DOWN, { threshold: 1 });
  assert.match(r.stdout, /could not write/);
  assert.match(r.posted, /1 checks in a row/);
  assert.doesNotMatch(r.posted, /1970/);
  const a = look(makeTempDir("reach-unwritable-announce"), DOWN, {
    announce: true,
  });
  assert.doesNotMatch(a.posted, /1970/);
  rmSync(dir, { recursive: true, force: true });
});

// The real probe, against real sockets: one port listening, one closed.
async function ports() {
  const listening = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => listening.once("listening", r));
  const closed = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => closed.once("listening", r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  return { listening, open: listening.address().port, closed: closedPort };
}
function credStub(dir, code) {
  const p = join(dir, `cred-${code}`);
  writeFileSync(p, `#!/bin/sh\necho '[credential] stub'\nexit ${code}\n`, {
    mode: 0o755,
  });
  return p;
}
const LOCAL = "ISSUE_HOST=127.0.0.1\nISSUE_REPO=org/repo\n";

test("real probe: a closed port is down, and names the port", async () => {
  const { listening, open, closed } = await ports();
  const dir = makeTempDir("reach-probe-closed");
  let r;
  try {
    r = look(dir, null, {
      threshold: 1,
      lane: LOCAL,
      extraEnv: {
        PROBE_PORTS: `${open} ${closed}`,
        PROBE_TIMEOUT: "3",
        CREDENTIAL_BIN: credStub(dir, 0),
      },
    });
  } finally {
    listening.close();
  }
  assert.match(r.stdout, new RegExp(`\\[reach\\] down: no connection on port\\(s\\) ${closed}$`, "m"));
  rmSync(dir, { recursive: true, force: true });
});

test("real probe: open ports map the credential's answer — 0 up, 2 up, 3 down", async () => {
  const { listening, open } = await ports();
  // Closed in `finally`: a server left listening keeps the test process alive forever.
  try {
    for (const [code, want] of [
      [0, /\[reach\] up: ports open, credential usable/],
      [2, /\[reach\] up: ports open, credential not confirmed \(exit 2\)/],
      [3, /\[reach\] down: ports open, but the credential was refused/],
    ]) {
      const dir = makeTempDir("reach-probe-cred");
      const r = look(dir, null, {
        lane: LOCAL,
        extraEnv: {
          PROBE_PORTS: String(open),
          PROBE_TIMEOUT: "3",
          CREDENTIAL_BIN: credStub(dir, code),
        },
      });
      rmSync(dir, { recursive: true, force: true });
      assert.match(r.stdout, want, `credential exit ${code}`);
    }
  } finally {
    listening.close();
  }
});

test("real probe: no ISSUE_HOST is unknown, not down", () => {
  const dir = makeTempDir("reach-probe-nohost");
  const r = look(dir, null, { threshold: 1, lane: "\n" });
  assert.match(r.stdout, /\[reach\] unknown: no ISSUE_HOST/);
  assert.equal(r.posted, "");
  rmSync(dir, { recursive: true, force: true });
});
