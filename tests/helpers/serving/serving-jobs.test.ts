// Unit tests for the pure halves of the serving job-lifecycle helper.
// Run with: npm run test:units
//
// `expectedRefusalBody` is what turns "B gets a 404" into "B's 404 does not leak
// that the job exists": the spec compares B's whole refusal body against the
// body a never-existed job id produces, with the id substituted. If the
// substitution missed an occurrence, or touched a value it should not, the spec
// would either fail on a correct product or pass on a leaking one — so both
// directions are pinned here rather than trusted.
//
// `parseSseEvents` reads the `/events` replay the positive control asserts on.
// It throws on a malformed `data:` line instead of skipping it: a silently
// dropped event would surface as "her message is not in the replay", a product
// failure reported for what is a parsing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEVER_EXISTED_JOB_ID, expectedRefusalBody, parseSseEvents } from "./serving-jobs";

const JOB = "57f732a8-e6da-47c6-9231-ccb3b9564299";

test("every occurrence of the never-existed id is replaced by the real one", () => {
  // The status door's measured body names the id twice: in `message` and in `job_id`.
  const ghost = {
    error: "Workflow job not found",
    code: "JOB_NOT_FOUND",
    message: `Workflow job ${NEVER_EXISTED_JOB_ID} not found`,
    job_id: NEVER_EXISTED_JOB_ID,
  };
  assert.deepEqual(expectedRefusalBody(ghost, JOB), {
    error: "Workflow job not found",
    code: "JOB_NOT_FOUND",
    message: `Workflow job ${JOB} not found`,
    job_id: JOB,
  });
});

test("an id named twice inside one string is replaced both times", () => {
  // Not a measured shape — a first-occurrence `replace` passes every measured
  // body, because each names the id at most once per string, and would then
  // fail a correct product the first time a message repeats it.
  const ghost = { message: `${NEVER_EXISTED_JOB_ID} (job ${NEVER_EXISTED_JOB_ID})` };
  assert.deepEqual(expectedRefusalBody(ghost, JOB), { message: `${JOB} (job ${JOB})` });
});

test("a body that carries no id is returned unchanged", () => {
  const ghost = { error: "Workflow job not found", code: "JOB_NOT_FOUND" };
  assert.deepEqual(expectedRefusalBody(ghost, JOB), ghost);
});

test("nested values and non-strings survive the substitution", () => {
  const ghost = {
    detail: { job_id: NEVER_EXISTED_JOB_ID, attempts: 0, retryable: false, extra: null },
    list: [NEVER_EXISTED_JOB_ID, 1],
  };
  assert.deepEqual(expectedRefusalBody(ghost, JOB), {
    detail: { job_id: JOB, attempts: 0, retryable: false, extra: null },
    list: [JOB, 1],
  });
});

test("the input body is not mutated", () => {
  const ghost = { job_id: NEVER_EXISTED_JOB_ID };
  expectedRefusalBody(ghost, JOB);
  assert.equal(ghost.job_id, NEVER_EXISTED_JOB_ID);
});

test("a body that names the owner is NOT made equal by the substitution", () => {
  // The leak this comparison exists to catch: a refusal that differs from the
  // never-existed one in anything but the id must stay different.
  const ghost = { code: "JOB_NOT_FOUND", message: `Job ${NEVER_EXISTED_JOB_ID} not found` };
  const leaking = { code: "JOB_NOT_FOUND", message: `Job ${JOB} belongs to another end user` };
  assert.notDeepEqual(expectedRefusalBody(ghost, JOB), leaking);
});

test("SSE replay lines parse into events, ignoring id and blank lines", () => {
  // Shape measured from GET /api/v2/workflows/{job_id}/events on 1.13.0.dev30.
  const text = [
    'data: {"event": "vertices_sorted", "data": {"ids": ["ChatInput-FXoDx"]}}',
    "id: 1",
    "",
    'data: {"event": "add_message", "data": {"sender": "User", "session_id": "alice::S", "text": "hi"}}',
    "id: 2",
    "",
    "",
  ].join("\n");
  assert.deepEqual(parseSseEvents(text), [
    { event: "vertices_sorted", data: { ids: ["ChatInput-FXoDx"] } },
    { event: "add_message", data: { sender: "User", session_id: "alice::S", text: "hi" } },
  ]);
});

test("an empty stream yields no events", () => {
  assert.deepEqual(parseSseEvents(""), []);
});

test("a malformed data line throws, naming it, instead of being skipped", () => {
  assert.throws(
    () => parseSseEvents('data: {"event": "add_message", "data": \nid: 1\n'),
    /malformed SSE data line/,
  );
});
