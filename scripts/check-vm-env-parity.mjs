#!/usr/bin/env node
// Does the VM lane account for every environment variable daily-stable.yml sets on the
// Langflow service it tests?
//
//   node scripts/check-vm-env-parity.mjs --mode=check   # fail-closed verdict, exit 1 on a gap
//   node scripts/check-vm-env-parity.mjs --mode=list    # the table, always exit 0
//
// The reasoning lives in scripts/lib/vm-env-parity.mjs. This file is the entry point,
// so the question can be asked from a terminal on the QA VM — where the person holding
// an odd verdict is — and not only from the unit lane.
//
// `--mode=check` is also what scripts/check-vm-env-parity.test.mjs drives, so the lane
// and the human get the same answer from the same code.

import { checkVmEnvParity, CLASSIFICATION, WORKFLOW_PATH } from "./lib/vm-env-parity.mjs";

const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=check").slice("--mode=".length);

if (!["check", "list"].includes(mode)) {
  console.error(`unknown mode: ${mode} (expected check or list)`);
  process.exit(2);
}

const result = checkVmEnvParity();

if (mode === "list") {
  console.log(`${WORKFLOW_PATH} → the VM lane\n`);
  for (const { name, carrier, reason, sameValue } of result.carried) {
    const where = carrier === null ? "out of scope" : carrier;
    console.log(`  ${name}`);
    console.log(`    carried by : ${where}${sameValue === false ? " (different value, on purpose)" : ""}`);
    console.log(`    because    : ${reason}`);
  }
  for (const f of result.findings) console.log(`  ${f.name ?? "-"}: ${f.message}`);
  process.exit(0);
}

if (result.ok) {
  const scoped = result.carried.filter((c) => c.carrier !== null).length;
  const out = result.carried.length - scoped;
  console.log(
    `VM env parity OK — ${result.carried.length} variables on the daily's service: ` +
      `${scoped} carried to the target, ${out} recorded out of scope.`,
  );
  process.exit(0);
}

// Every finding, not the first: an enumeration guard that stops at one gap makes the
// reader run it once per variable.
for (const f of result.findings) console.error(`::error:: ${f.message}`);
console.error("");
console.error("Why this is fail-closed rather than a warning: half of this class produces");
console.error("AGREEMENT, not failure. A variable the daily sets and the VM lane does not");
console.error("carry can make the VM pass a spec the Actions daily would fail — and the");
console.error("migration's whole product is the comparison between those two verdicts, so");
console.error("no run can find it by going red. See #1717, and CLASSIFICATION in");
console.error("scripts/lib/vm-env-parity.mjs for where to record the decision.");
console.error(`(${Object.keys(CLASSIFICATION).length} variables classified today.)`);
process.exit(1);
