// Unit tests for tests/helpers/instance-migration/migration-walk.ts (#2353).
// Run with: npm run test:units
//
// The spec asserts what a migration left in the destinations through three readers —
// the run's NDJSON events, the bucket's ListObjectsV2 XML, and SQL run inside the two
// database containers. A reader that read nothing would make "the bucket is empty" and
// "the test run wrote nothing" pass for the wrong reason, so each one is pinned here on
// the shapes measured on 1.14.0.dev14, including the ways it must refuse to answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { instanceMigrationLane } from "./instance-migration-lane";
import {
  parseListObjects,
  parseRunEvents,
  sourceSql,
  stepOf,
  targetDatabase,
  targetRowCount,
  targetSql,
  targetVectorTables,
  type Exec,
  type MigrationState,
} from "./migration-walk";

const lane = instanceMigrationLane({});

/** An `Exec` that records each call and answers from a queue. */
function fakeDocker(...answers: string[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (args) => {
    calls.push(args);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected docker call: ${args.join(" ")}`);
    return answer;
  };
  return { exec, calls };
}

test("parseRunEvents reads the server's blank-line-separated NDJSON", () => {
  // As measured: each event is followed by an empty line.
  const body =
    '{"event": "progress", "phase": "checking", "seq": 1}\n\n' +
    '{"event": "error", "code": "interrupted", "seq": 2}\n\n' +
    '{"event": "end", "status": "cancelled", "exit_code": 143, "seq": 3}\n\n';
  const events = parseRunEvents(body);
  assert.deepEqual(
    events.map((e) => e.event),
    ["progress", "error", "end"],
  );
  assert.equal(events[2].status, "cancelled");
});

test("parseRunEvents refuses a line that is not JSON instead of skipping it", () => {
  assert.throws(() => parseRunEvents('{"event": "end"}\n<html>502</html>\n'), /not JSON: <html>502/);
});

test("parseListObjects answers every key with its size", () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    "<Name>langflow-migration</Name><IsTruncated>false</IsTruncated>" +
    "<Contents><Key>langflow/u1/instance-migration-seed-file.txt</Key><ETag>&#34;x&#34;</ETag><Size>29</Size></Contents>" +
    "<Contents><Key>langflow/f1/2026-11-03_23-01-00_a.txt</Key><Size>21</Size></Contents>" +
    "<KeyCount>2</KeyCount></ListBucketResult>";
  assert.deepEqual(parseListObjects(xml), [
    { key: "langflow/u1/instance-migration-seed-file.txt", size: 29 },
    { key: "langflow/f1/2026-11-03_23-01-00_a.txt", size: 21 },
  ]);
});

test("parseListObjects answers an empty bucket as no objects", () => {
  const xml = "<ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>";
  assert.deepEqual(parseListObjects(xml), []);
});

test("parseListObjects refuses an answer that is not a listing — an error page is not an empty bucket", () => {
  assert.throws(
    () => parseListObjects("<Error><Code>NoSuchBucket</Code></Error>"),
    /not a ListObjectsV2 answer/,
  );
});

test("parseListObjects refuses a truncated listing", () => {
  assert.throws(
    () => parseListObjects("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
    /truncated/,
  );
});

test("stepOf finds a step and throws naming one the server no longer lists", () => {
  const state = {
    steps: [{ id: "backup", state: "current", reason: null }],
  } as unknown as MigrationState;
  assert.equal(stepOf(state, "backup").state, "current");
  assert.throws(() => stepOf(state, "copy_files"), /no step 'copy_files'/);
});

test("targetDatabase reads the user and database from the address the source is given", () => {
  assert.deepEqual(targetDatabase(lane), { user: "langflow", database: "langflow_target" });
});

test("targetSql runs psql inside the database container, stopping on the first error", () => {
  const { exec, calls } = fakeDocker(" 3 \n");
  assert.equal(targetSql(lane, "select 3", exec), "3");
  assert.deepEqual(calls[0], [
    "exec",
    "langflow-instance-migration-pg",
    "psql",
    "-U",
    "langflow",
    "-d",
    "langflow_target",
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    "select 3",
  ]);
});

test("targetRowCount answers 0 for a table a stopped copy never created, without counting it", () => {
  const { exec, calls } = fakeDocker("f");
  assert.equal(targetRowCount(lane, "flow", exec), 0);
  assert.equal(calls.length, 1);
});

test("targetRowCount counts an existing table", () => {
  const { exec, calls } = fakeDocker("t", "29");
  assert.equal(targetRowCount(lane, "flow", exec), 29);
  assert.match(calls[1].at(-1) ?? "", /select count\(\*\) from public\."flow"/);
});

test("targetRowCount refuses a table name it would have to quote", () => {
  assert.throws(() => targetRowCount(lane, 'flow"; drop table x; --', fakeDocker().exec), /not a plain table name/);
});

test("targetVectorTables lists the lf_ tables and answers none for empty output", () => {
  assert.deepEqual(targetVectorTables(lane, fakeDocker("lf_49b5\nlf_77aa").exec), ["lf_49b5", "lf_77aa"]);
  assert.deepEqual(targetVectorTables(lane, fakeDocker("").exec), []);
});

test("sourceSql reads the source database read-only and parses the last line of output", () => {
  // The source image prints a transformers notice on some imports; only the last line is the answer.
  const { exec, calls } = fakeDocker("some notice\n[[29]]\n");
  assert.deepEqual(sourceSql(lane, "/app/langflow.db", "select count(*) from flow", exec), [[29]]);
  const [, container, python, flag, script, path, sql] = calls[0];
  assert.equal(container, "langflow-instance-migration");
  assert.equal(python, "python");
  assert.equal(flag, "-c");
  assert.match(script, /mode=ro/);
  assert.equal(path, "/app/langflow.db");
  assert.equal(sql, "select count(*) from flow");
});
