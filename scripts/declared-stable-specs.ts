#!/usr/bin/env ts-node
/**
 * Emit the spec files that DECLARE an `@stable` test, as JSON (#1812).
 *
 * Run:
 *   npx ts-node scripts/declared-stable-specs.ts > declared.json
 *
 * This is the second half of the daily's listing-completeness check. The first
 * half is `playwright test --grep @stable --list`, which reports what the runner
 * COLLECTED in this environment; this reports what is ON DISK. The two agree
 * exactly today (247 = 247, measured on `main`), and the whole point of the pair
 * is the case where they do not: a spec file whose tests are generated at
 * COLLECTION time from something the environment did not supply yields zero
 * tests, leaves the shard partition, and is handed to no shard — not skipped,
 * not red, ABSENT, with `--pass-with-no-tests` keeping every shard green (#1764).
 *
 * `scripts/partition-shards.mjs matrix --declared <this file>` does the compare,
 * so the comparison is reported in the same breath as the partition it describes.
 *
 * Stdout is a contract (the caller parses it); every diagnostic goes to stderr.
 *
 * Exit codes:
 *   0  a declaration set was produced
 *   2  it could not be — the walk or the parse broke. A caller must never read
 *      that as "nothing is missing", which is why `partition-shards` reports an
 *      absent/unreadable file as UNVERIFIED rather than as agreement (#1012).
 */
import { declaredStableSpecFiles } from "./lib/stable-tests";

function main(): number {
  try {
    const declared = declaredStableSpecFiles();
    process.stdout.write(JSON.stringify({ version: 1, ...declared }, null, 2) + "\n");
    process.stderr.write(
      `declared: ${declared.files.length} spec file(s) carry an @stable test ` +
        `a normal lane can select` +
        (declared.laneOnly.length
          ? `; ${declared.laneOnly.length} excluded as lane-only (${declared.laneOnly.join(", ")})`
          : "") +
        (declared.unparseable.length
          ? `; ${declared.unparseable.length} carry an unreadable tag array (${declared.unparseable.join(", ")})`
          : "") +
        "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `[declared-stable-specs] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
}

if (require.main === module) {
  process.exit(main());
}
