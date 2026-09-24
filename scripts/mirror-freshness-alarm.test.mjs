// Unit tests for scripts/mirror-freshness-alarm.sh.
// Run with: npm run test:scripts
//
// What these protect is the split that made the alarm worth keeping: the hourly look
// RECORDS and never posts, and the channel hears about the mirror once, before the
// daily, only when a stale suite would reach a verdict. Posting every change was four
// messages in one night on 2026-09-23/24, for two stalls that touched no verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mirror-freshness-alarm.sh");

/** Runs the alarm with the check stubbed to a fixed verdict, and captures any POST. */
function runAlarm({
  dir,
  exitCode,
  message = "stubbed verdict",
  webhook = true,
  httpStatus = "200",
  announce = false,
  history = join(dir, "history"),
}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  // Truncated per call: the stub appends, and reading the accumulated file would make
  // a later run look like it had posted when it was an earlier run's message.
  const sent = join(dir, "sent.txt");
  rmSync(sent, { force: true });
  // A curl that records instead of sending. Real curl here writes only the status code
  // to stdout (`-o /dev/null -w`), so the stub does the same.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\ncat >> ${JSON.stringify(sent)}\nprintf '%s' ${JSON.stringify(httpStatus)}\n`,
    { mode: 0o755 },
  );
  // The stub is an executable, not a command string — see CHECK_BIN in the script.
  // Single-quoted: inside double quotes sh would run a backtick in the message as a command.
  const check = join(bin, "check-stub");
  const quoted = `'${message.replace(/'/g, "'\\''")}'`;
  writeFileSync(check, `#!/bin/sh\necho ${quoted}\nexit ${exitCode}\n`, { mode: 0o755 });
  const secrets = join(dir, "secrets.env");
  // `webhook` is true for a generic URL, or the URL itself when the transport matters.
  const url = typeof webhook === "string" ? webhook : "https://example.invalid/hook";
  writeFileSync(secrets, webhook ? `export SLACK_WEBHOOK_URL=${JSON.stringify(url)}\n` : "\n");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CHECK_BIN: check,
      HISTORY_FILE: history,
      SECRETS_FILE: secrets,
      ANNOUNCE: announce ? "1" : "0",
    },
  });
  return { ...r, posted: existsSync(sent) ? readFileSync(sent, "utf8") : "" };
}

const states = (file) =>
  readFileSync(file, "utf8").trim().split("\n").map((line) => line.split("\t")[1]);

test("the hourly look never posts, whatever it sees, and records every answer", () => {
  const dir = makeTempDir("alarm-hourly");
  for (const exitCode of [0, 1, 1, 2, 0]) {
    const r = runAlarm({ dir, exitCode });
    assert.equal(r.status, 0);
    assert.equal(r.posted, "", `the hourly look posted on exit ${exitCode}`);
    assert.match(r.stdout, /only at the pre-daily check/);
  }
  assert.deepEqual(states(join(dir, "history")), ["current", "not-current", "not-current", "unknown", "current"]);
  rmSync(dir, { recursive: true, force: true });
});

test("before the daily, a current mirror says nothing", () => {
  const dir = makeTempDir("alarm-announce-current");
  const r = runAlarm({ dir, exitCode: 0, announce: true });
  assert.equal(r.posted, "");
  assert.match(r.stdout, /nothing to say/);
  rmSync(dir, { recursive: true, force: true });
});

test("before the daily, UNKNOWN is not posted: the check could not ask", () => {
  // Saying "behind" would assert what the check refused to, and the daily's preflight
  // asks again thirty minutes later and writes the answer into the run's evidence.
  const dir = makeTempDir("alarm-announce-unknown");
  const r = runAlarm({ dir, exitCode: 2, announce: true });
  assert.equal(r.posted, "");
  assert.match(r.stdout, /could not tell before the daily/);
  rmSync(dir, { recursive: true, force: true });
});

test("before the daily, a mirror that is behind is posted, with the check's verdict", () => {
  const dir = makeTempDir("alarm-announce-behind");
  const r = runAlarm({ dir, exitCode: 1, message: "BEHIND: 41 commit(s)", announce: true });
  assert.match(r.posted, /rotating_light/);
  assert.match(r.posted, /daily starts in about 30 minutes/);
  assert.match(r.posted, /41 commit/, "the verdict did not travel with the alarm");
  assert.match(r.stdout, /posted/);
  rmSync(dir, { recursive: true, force: true });
});

test("a stall that lasts days is posted once per daily, not once per stall", () => {
  // Each pre-daily check stands alone: a Monday stall still unfixed on Tuesday is a
  // second daily about to run an older suite, and that is worth a second message.
  const dir = makeTempDir("alarm-announce-days");
  assert.match(runAlarm({ dir, exitCode: 1, announce: true }).posted, /rotating_light/);
  assert.match(runAlarm({ dir, exitCode: 1, announce: true }).posted, /rotating_light/);
  rmSync(dir, { recursive: true, force: true });
});

test("a Workflow Builder trigger gets its three variables, not a `text` it drops", () => {
  // The 2026-09-24 02:01 BRT alarm: the VM's webhook is a `/triggers/` URL, the alarm
  // posted `{"text": …}`, the trigger answered 200 and the channel showed its template
  // with every variable empty. The words have to arrive as the variables the trigger
  // declares, all three present, and as plain text — mrkdwn is not rendered there.
  const hook = "https://hooks.slack.com/triggers/T000/000/abc";
  const dir = makeTempDir("alarm-workflow");
  const r = runAlarm({ dir, exitCode: 1, message: "BEHIND: older suite than `main`", webhook: hook, announce: true });
  const sent = JSON.parse(r.posted);
  assert.deepEqual(Object.keys(sent).sort(), ["body", "headline", "links"]);
  assert.match(sent.headline, /^🚨 The e2e mirror is behind main and the daily starts/);
  assert.doesNotMatch(sent.headline, /`|:rotating_light:/, "markup the trigger would print literally");
  // The check's own verdict carries backticks (the 02:01 journal line did); plain there too.
  assert.equal(sent.body, "BEHIND: older suite than main", "the verdict did not travel, or kept its markup");
  assert.equal(sent.links, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a classic Incoming Webhook keeps the `text` payload it renders", () => {
  const hook = "https://hooks.slack.com/services/T000/B000/abc";
  const dir = makeTempDir("alarm-services");
  const sent = JSON.parse(runAlarm({ dir, exitCode: 1, message: "BEHIND: 2 commit(s)", webhook: hook, announce: true }).posted);
  assert.deepEqual(Object.keys(sent), ["text"]);
  assert.match(sent.text, /^:rotating_light: The e2e mirror is behind `main`.* BEHIND: 2 commit\(s\)$/);
  rmSync(dir, { recursive: true, force: true });
});

test("a webhook that answers 404 is reported, not taken as delivered", () => {
  // `curl -sS` exits 0 for any HTTP response, so a rotated webhook answering
  // `404 no_service` looked exactly like a sent message.
  const dir = makeTempDir("alarm-404");
  const r = runAlarm({ dir, exitCode: 1, httpStatus: "404", announce: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /HTTP 404/, "a rejected webhook was reported as sent");
  rmSync(dir, { recursive: true, force: true });
});

test("no webhook is a quiet log line, never a failure", () => {
  // A broken notifier must not read as a broken mirror: this runs on a timer, and a
  // non-zero exit would show up as a failed unit and send someone to the wrong thing.
  const dir = makeTempDir("alarm-no-webhook");
  const r = runAlarm({ dir, exitCode: 1, webhook: false, announce: true });
  assert.equal(r.status, 0, "a missing webhook failed the unit");
  assert.match(r.stdout, /no SLACK_WEBHOOK_URL — said here only/);
  rmSync(dir, { recursive: true, force: true });
});

test("the history keeps a week and drops what is older", () => {
  const dir = makeTempDir("alarm-trim");
  const now = Math.floor(Date.now() / 1000);
  const history = join(dir, "history");
  writeFileSync(history, `${now - 8 * 86400}\tnot-current\n${now - 86400}\tcurrent\n`);
  runAlarm({ dir, exitCode: 0 });
  assert.deepEqual(states(history), ["current", "current"], "an eight-day-old look survived the trim");
  rmSync(dir, { recursive: true, force: true });
});

test("an unwritable history is said and does not stop the announce", () => {
  const dir = makeTempDir("alarm-unwritable");
  // A directory where the file should be: no write can succeed, root or not.
  const history = join(dir, "history");
  mkdirSync(history);
  const r = runAlarm({ dir, exitCode: 1, announce: true, history });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /could not write/);
  assert.match(r.posted, /rotating_light/, "a history problem swallowed the warning");
  rmSync(dir, { recursive: true, force: true });
});
