// Unit tests for scripts/mirror-freshness-alarm.sh.
// Run with: npm run test:scripts
//
// What these protect is the property that makes an alarm worth having: it speaks when
// the answer CHANGES and stays quiet when it does not. A stall lasts days, and hourly
// repetition of one fact is how a channel learns to mute the alarm — at which point
// the silence it was built to remove is back, wearing a notification badge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mirror-freshness-alarm.sh");

/** Runs the alarm with the check stubbed to a fixed verdict, and captures any POST. */
function runAlarm({ dir, exitCode, message = "stubbed verdict", webhook = true, httpStatus = "200" }) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  // Truncated per call: the stub appends, and reading the accumulated file made the
  // second run look like it had posted when it was the first run's message.
  const sent = join(dir, "sent.txt");
  rmSync(sent, { force: true });
  // A curl that records instead of sending. The alarm must not care which it got.
  // Real curl here writes only the status code to stdout (`-o /dev/null -w`), so the
  // stub does the same — and the status is what the alarm now decides on.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\ncat >> ${JSON.stringify(sent)}\nprintf '%s' ${JSON.stringify(httpStatus)}\n`,
    { mode: 0o755 },
  );
  // The stub is an executable, not a command string — see CHECK_BIN in the script.
  const check = join(bin, "check-stub");
  writeFileSync(check, `#!/bin/sh\necho ${JSON.stringify(message)}\nexit ${exitCode}\n`, { mode: 0o755 });
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, webhook ? 'export SLACK_WEBHOOK_URL="https://example.invalid/hook"\n' : "\n");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CHECK_BIN: check,
      STATE_FILE: join(dir, "state"),
      SECRETS_FILE: secrets,
    },
  });
  return { ...r, posted: existsSync(sent) ? readFileSync(sent, "utf8") : "" };
}

test("the first look at a healthy mirror says nothing to the channel", () => {
  // An alarm that fires on installation is one people learn to dismiss.
  const dir = makeTempDir("alarm-first-ok");
  const r = runAlarm({ dir, exitCode: 0 });
  assert.equal(r.status, 0);
  assert.equal(r.posted, "", "it announced itself on a machine that was fine");
  assert.match(r.stdout, /first observation/);
  rmSync(dir, { recursive: true, force: true });
});

test("it speaks when the mirror stops being current, and only once", () => {
  const dir = makeTempDir("alarm-transition");
  runAlarm({ dir, exitCode: 0 });                       // establishes "current"
  const first = runAlarm({ dir, exitCode: 1, message: "BEHIND: 41 commit(s)" });
  assert.match(first.posted, /rotating_light/, "the transition was not announced");
  assert.match(first.posted, /41 commit/, "the verdict did not travel with the alarm");

  const second = runAlarm({ dir, exitCode: 1, message: "BEHIND: 41 commit(s)" });
  assert.equal(second.posted, "", "it repeated a fact the channel already had");
  assert.match(second.stdout, /unchanged \(not-current\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("recovery is announced too, because a closed alarm has to close", () => {
  const dir = makeTempDir("alarm-recovery");
  runAlarm({ dir, exitCode: 0 });
  runAlarm({ dir, exitCode: 1 });
  const back = runAlarm({ dir, exitCode: 0, message: "ok: current at abcd1234" });
  assert.match(back.posted, /white_check_mark/, "the recovery left the earlier alarm open");
  assert.match(back.posted, /abcd1234/);
  rmSync(dir, { recursive: true, force: true });
});

test("one UNKNOWN is a blip and says nothing; two in a row is a condition and speaks", () => {
  // Exit 2 is "could not tell", and that is NOT "the mirror is stale" — saying so would
  // assert what the check refused to. But it is not nothing either: a question that
  // cannot be asked twice running is a condition. One 60-second DNS blip on an hourly
  // timer must not produce an alarm plus a recovery an hour later.
  const dir = makeTempDir("alarm-unknown");
  runAlarm({ dir, exitCode: 0 });
  const blip = runAlarm({ dir, exitCode: 2, message: "UNKNOWN: could not read the source" });
  assert.equal(blip.posted, "", "a single blip woke the channel");
  assert.match(blip.stdout, /waiting for a second look/);

  const again = runAlarm({ dir, exitCode: 2, message: "UNKNOWN: could not read the source" });
  assert.match(again.posted, /warning/, "a standing inability to ask was never reported");
  assert.doesNotMatch(again.posted, /is not current/, "it asserted staleness it had not measured");
  rmSync(dir, { recursive: true, force: true });
});

test("a notification that did not land does NOT consume the transition", () => {
  // The defect this file existed to have: the state was written BEFORE the POST, so one
  // failed delivery marked the change as handled and every later run said "unchanged".
  // A Friday stall plus one bad minute of network is the weekend-long silence the whole
  // PR is about.
  const dir = makeTempDir("alarm-delivery-failed");
  runAlarm({ dir, exitCode: 0 });
  const failed = runAlarm({ dir, exitCode: 1, message: "BEHIND: 41 commit(s)", httpStatus: "500" });
  assert.match(failed.stdout, /not recording it as said/);

  const retry = runAlarm({ dir, exitCode: 1, message: "BEHIND: 41 commit(s)" });
  assert.match(retry.posted, /rotating_light/, "the alarm was swallowed by the failed delivery");
  rmSync(dir, { recursive: true, force: true });
});

test("a webhook that answers 404 is a failure, not a delivery", () => {
  // `curl -sS` exits 0 for any HTTP response, so a rotated webhook answering
  // `404 no_service` looked exactly like a sent message.
  const dir = makeTempDir("alarm-404");
  runAlarm({ dir, exitCode: 0 });
  const r = runAlarm({ dir, exitCode: 1, httpStatus: "404" });
  assert.match(r.stdout, /HTTP 404/, "a rejected webhook was reported as sent");
  rmSync(dir, { recursive: true, force: true });
});

test("no webhook is a quiet log line, never a failure", () => {
  // A broken notifier must not read as a broken mirror: this runs on a timer, and a
  // non-zero exit here would show up as a failed unit and send someone looking at the
  // wrong thing.
  const dir = makeTempDir("alarm-no-webhook");
  runAlarm({ dir, exitCode: 0, webhook: false });
  const r = runAlarm({ dir, exitCode: 1, webhook: false });
  assert.equal(r.status, 0, "a missing webhook failed the unit");
  assert.match(r.stdout, /no SLACK_WEBHOOK_URL — said here only/);
  rmSync(dir, { recursive: true, force: true });
});
