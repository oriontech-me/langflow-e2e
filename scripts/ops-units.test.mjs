// Guards over the systemd units in `ops/systemd`, which schedule and contain the VM
// lane's daily.
//
// These files are not executed by CI, so nothing here can prove the machine behaves --
// only that what a reviewer reads still says what it meant. Each guard exists because
// its property is one an ordinary edit removes SILENTLY: the lane keeps running and the
// loss shows up as a wrong verdict, a schedule an hour off, or an alarm that stopped
// covering the case it was written for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const OPS = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "systemd");
const read = (...p) => readFileSync(join(OPS, ...p), "utf8");

/** Every directive line for one key, comments excluded. */
const directives = (text, key) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1).trim());

test("the daily does not pull the ssh tunnel, and that absence is the point", () => {
  // 2026-09-22: the tunnel was disabled and came back anyway at 04:00:13, the second
  // the daily fired, because this unit named it in Wants=. `systemctl disable` cannot
  // reach that, and a drop-in cannot subtract it -- dependency lists accumulate, with
  // no empty-assignment reset documented for Wants= (systemd 259, and the machine
  // refused it). A drop-in CAN add one, though, so the unit and every drop-in beside
  // it are read together: that union is what systemd loads.
  const dropInDir = join(OPS, "e2e-daily.service.d");
  const texts = [
    read("e2e-daily.service"),
    ...readdirSync(dropInDir)
      .filter((f) => f.endsWith(".conf"))
      .map((f) => read("e2e-daily.service.d", f)),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /langflow-tunnel/, "the daily names the tunnel again");
  }
  assert.deepEqual(texts.flatMap((t) => directives(t, "Wants")), ["network-online.target"]);
  assert.deepEqual(texts.flatMap((t) => directives(t, "After")), ["network-online.target"]);
});

test("both calendars say UTC out loud, because this machine's clock does not", () => {
  // The clock is EDT and Debian's cron has no CRON_TZ -- the reason none of this is a
  // crontab line. A calendar without the suffix moves an hour at the DST change, and
  // the lane it is compared against is expressed in UTC.
  for (const unit of ["e2e-daily.timer", "e2e-daily-watchdog.timer"]) {
    const [calendar, ...rest] = directives(read(unit), "OnCalendar");
    assert.equal(rest.length, 0, `${unit} has more than one OnCalendar`);
    assert.match(calendar, /\bUTC$/, `${unit}: OnCalendar carries no UTC suffix`);
    assert.match(calendar, /^Mon\.\.Fri /, `${unit}: the weekend rule left the calendar`);
  }
});

test("Persistent= is opposite between the run and its alarm, deliberately", () => {
  // The tempting edit is to make them agree, and it breaks one of the two: a daily that
  // catches up produces a verdict for a day it did not observe; an alarm that catches
  // up still tells the truth, because "the run did not happen" does not expire.
  assert.deepEqual(directives(read("e2e-daily.timer"), "Persistent"), ["false"]);
  assert.deepEqual(directives(read("e2e-daily-watchdog.timer"), "Persistent"), ["true"]);
});

test("every service declares HOME, because systemd sets none (#1715)", () => {
  // cron does, systemd does not, and run-e2e.sh builds the uv PATH out of $HOME under
  // `set -u` -- so the run dies before doing anything. Found by running a unit, not by
  // reading one.
  for (const unit of ["e2e-daily.service", "e2e-daily-watchdog.service", "e2e-mirror-freshness.service"]) {
    assert.ok(
      directives(read(unit), "Environment").some((v) => v === "HOME=/root"),
      `${unit} does not declare HOME`,
    );
  }
});

test("the target drop-in RESETS ExecStart before setting its own", () => {
  // Without the empty line first, `Type=oneshot` accepts both and runs TWO wrappers:
  // the source-clone one and the distribution one, in sequence, against one target.
  const conf = read("e2e-daily.service.d", "10-target-dist.conf");
  const execs = directives(conf, "ExecStart");
  assert.equal(execs[0], "", "the reset line is missing, so both wrappers would run");
  assert.equal(execs.length, 2, "expected exactly the reset plus one command");
  assert.match(execs[1], /^\/root\/e2e-qa\/ops\/vm\/run-daily\.sh$/);
});

test("every ExecStart into the clone names a script this repository ships", () => {
  // Since #1994 the units run wrappers from /root/e2e-qa, the clone of this repository.
  // A rename here that forgets the unit leaves a daily that fails at 08:00 UTC with
  // "No such file" -- and the watchdog, pointing at the same clone, fails with it.
  const units = [
    ...readdirSync(OPS).filter((f) => f.endsWith(".service")).map((f) => read(f)),
    ...readdirSync(join(OPS, "e2e-daily.service.d")).map((f) => read("e2e-daily.service.d", f)),
  ];
  const targets = units
    .flatMap((t) => directives(t, "ExecStart"))
    .filter((cmd) => cmd.startsWith("/root/e2e-qa/"))
    .map((cmd) => cmd.split(/\s+/)[0].slice("/root/e2e-qa/".length));
  assert.ok(targets.length >= 3, `expected the daily, the watchdog and the mirror alarm, got ${targets}`);
  for (const rel of targets) {
    const mode = statSync(join(OPS, "..", "..", rel)).mode;
    assert.ok(mode & 0o100, `${rel} is not executable`);
  }
});

test("the timers are enablable and the services are not, by design", () => {
  // Each service is pulled by its timer's Unit=, so only timers carry [Install]. A
  // service with one invites `systemctl enable e2e-daily.service`, which would arm the
  // run with no schedule behind it; a timer without one makes `enable` a no-op that
  // warns and is easy to miss.
  for (const unit of ["e2e-daily.timer", "e2e-daily-watchdog.timer", "e2e-mirror-freshness.timer"]) {
    assert.deepEqual(directives(read(unit), "WantedBy"), ["timers.target"], `${unit}`);
  }
  for (const unit of ["e2e-daily.service", "e2e-daily-watchdog.service", "e2e-mirror-freshness.service"]) {
    assert.doesNotMatch(read(unit), /^\[Install\]/m, `${unit} carries an [Install] section`);
  }
});

test("nothing in ops/ names an internal host, alias or address", () => {
  // This repository is public and mirrors to the destination. The topology lives in the
  // destination's wiki, and the reason this is a test rather than a habit is that the
  // next file added here will be added by someone who does not know the habit.
  //
  // The forbidden names are held as SHA-256 digests, never as text. The first version
  // spelled them in a regex, in this file, outside the directory it scanned -- so the
  // guard was the one thing in the repository publishing the names it existed to keep
  // out. A digest of a short hostname can be confirmed by someone who already has a
  // guess, so this is not secrecy; it is not handing the list to everyone who reads.
  //
  // A token matches when it, or any dotted suffix of it, hashes to an entry — so a
  // fully qualified name under a forbidden domain is caught as well as the domain. Any
  // IPv4 literal other than loopback / the unspecified address is refused outright,
  // which keeps the address plan out of this file too.
  const FORBIDDEN_DIGESTS = new Set([
    "e8e6ab2da0e78a412678553f229a7207a5a40d7c7f8797e7b543ec98b6111778",
    "9799bc303dd43750f5a3d186250e2abce3c47ef16610c4996e60af2a6da38563",
    "5508d89d5d283228a43200c206e0bf74f308baf9f3a8415035ac9b509ed3532d",
    "efb77b10984cc890009b2b8f09459c1384c43855b6f15208f2338efe4ee0cd57",
  ]);
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
  const ALLOWED_IPV4 = new Set(["127.0.0.1", "0.0.0.0"]);

  const offending = (text) => {
    const hits = [];
    for (const raw of text.toLowerCase().split(/[^a-z0-9.-]+/)) {
      const token = raw.replace(/^[.-]+|[.-]+$/g, "");
      if (!token) continue;
      const labels = token.split(".");
      for (let i = 0; i < labels.length; i++) {
        if (FORBIDDEN_DIGESTS.has(sha(labels.slice(i).join(".")))) hits.push("a forbidden name");
      }
    }
    for (const m of text.matchAll(IPV4)) {
      if (!ALLOWED_IPV4.has(m[0])) hits.push(`IPv4 ${m[0]}`);
    }
    return hits;
  };

  // The scanner must actually fire: without these, a tokenizer that never produces a
  // match would pass over every file forever.
  // Assembled at run time, because this file is itself scanned below.
  assert.ok(offending(`host ${[10, 1, 2, 3].join(".")}`).length > 0, "an IPv4 literal is not detected");
  assert.equal(offending("bind 127.0.0.1 and 0.0.0.0").length, 0, "loopback is refused");

  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  // This file is scanned too: it is where the names leaked the first time.
  // All of ops/, not only the units: the wrappers in ops/vm/ are where topology lived
  // before #1994, and the likeliest place for it to come back.
  const files = [...walk(join(OPS, "..")), fileURLToPath(import.meta.url)];
  const offenders = files
    .map((p) => ({ p, hits: offending(readFileSync(p, "utf8")) }))
    .filter((r) => r.hits.length > 0)
    .map((r) => `${r.p}: ${[...new Set(r.hits)].join(", ")}`);
  assert.deepEqual(offenders, [], "an internal identifier reached a public repository");
});
