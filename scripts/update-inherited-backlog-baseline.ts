/**
 * Writes (or verifies) the frozen inventory of the never-validated OSS spec
 * backlog: `tests/assets/triage/inherited-backlog-baseline.json`.
 *
 *   npm run triage:baseline              # write
 *   npm run triage:baseline -- --check   # exit 1 on any drift, printing it
 *
 * The floor (`--min-specs`, default 10) refuses to write an implausibly small
 * baseline. A wrong baseline is permanent and silent -- the guard in
 * `check-stable-ownership.ts` reads it as the set of specs that are ALLOWED to
 * be unowned, so an empty one silently exempts the whole suite.
 *
 * `collectBacklog()` itself throws (via `assertNoWarnings`) rather than
 * compute a silently incomplete population when the AST parser could not
 * fully read the corpus -- an unparseable `tag:` option, or `@stable`
 * declared on a `test.describe` block. That is the right call, but a throw
 * escaping this script would read as a crash instead of a decision, so it is
 * caught here and reported as a named refusal in the same voice as the floor
 * below, in both write and `--check` mode (they share this call).
 */
import * as fs from "fs";
import * as path from "path";
import { REPO_ROOT } from "./lib/stable-tests";
import { collectBacklog, type Backlog, type BacklogSpec } from "./lib/inherited-backlog";

export const BASELINE_PATH = path.join(
  REPO_ROOT, "tests", "assets", "triage", "inherited-backlog-baseline.json",
);

export interface BaselineFile {
  version: 1;
  specs: BacklogSpec[];
  testCount: number;
  titleCollisions: string[];
}

export function renderBaseline(b: Backlog): string {
  const file: BaselineFile = {
    version: 1,
    specs: b.specs.slice().sort((x, y) => x.relativePath.localeCompare(y.relativePath)),
    testCount: b.testCount,
    titleCollisions: b.titleCollisions.slice().sort(),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function diffBaseline(committed: BaselineFile | null, current: Backlog) {
  const before = new Map((committed?.specs ?? []).map((s) => [s.relativePath, s]));
  const after = new Map(current.specs.map((s) => [s.relativePath, s]));
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()]
    .filter((k) => {
      const a = before.get(k);
      const b = after.get(k)!;
      return a !== undefined && JSON.stringify(a) !== JSON.stringify(b);
    })
    .sort();
  return { added, removed, changed };
}

/**
 * Ruling P8 (Task 3 review). Formats a `collectBacklog()` throw as the same
 * kind of named refusal the floor below prints, rather than letting it
 * surface as a raw stack trace out of an npm script. Exported so this is
 * unit-testable without forcing a real parse warning through the AST walk --
 * there are none in the corpus today, matching Task 2's own reasoning for
 * exporting `assertNoWarnings`.
 */
export function formatParseRefusal(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return `[triage-baseline] refusing: the AST parser could not fully read the corpus — ${message}`;
}

function readCommitted(): BaselineFile | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const minArg = argv.find((a) => a.startsWith("--min-specs="));
  const minSpecs = minArg ? Number(minArg.split("=")[1]) : 10;

  // Ruling P8: a corpus the parser could not fully read must never be baselined
  // -- that would be permanent and silent, exactly what the floor below exists
  // to prevent for a merely small one. This call is shared by both the write
  // and --check paths, so the refusal applies to both without special-casing.
  let current: Backlog;
  try {
    current = collectBacklog();
  } catch (e) {
    console.error(formatParseRefusal(e));
    return 1;
  }

  if (current.specs.length < minSpecs) {
    console.error(
      `[triage-baseline] refusing: derived ${current.specs.length} spec(s), below the floor of ` +
        `${minSpecs}. The guard reads this file as the set allowed to be unowned, so an ` +
        "implausibly small baseline silently exempts the suite. Pass --min-specs=<n> " +
        "deliberately if the backlog really has shrunk this far.",
    );
    return 1;
  }

  const rendered = renderBaseline(current);
  const committed = readCommitted();

  if (check) {
    const d = diffBaseline(committed, current);
    const drifted = d.added.length + d.removed.length + d.changed.length;
    if (drifted === 0) {
      console.log(
        `[triage-baseline] in sync: ${current.specs.length} spec(s), ${current.testCount} test(s).`,
      );
      return 0;
    }
    console.error("[triage-baseline] baseline is stale:");
    for (const s of d.added) console.error(`  + ${s} (entered the backlog)`);
    for (const s of d.removed) console.error(`  - ${s} (left the backlog)`);
    for (const s of d.changed) console.error(`  ~ ${s} (tier, tests or facts changed)`);
    console.error("Run `npm run triage:baseline` and commit the result.");
    return 1;
  }

  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, rendered);
  console.log(
    `[triage-baseline] wrote ${current.specs.length} spec(s) / ${current.testCount} test(s) ` +
      `to ${path.relative(REPO_ROOT, BASELINE_PATH)}` +
      (current.titleCollisions.length
        ? ` — WARNING: ${current.titleCollisions.length} title collision(s) recorded; ` +
          "the --grep selector will refuse to build until they are resolved."
        : ""),
  );
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
