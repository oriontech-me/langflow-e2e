# Serving-plane end-user identity — job-lifecycle gating, when trusted

**File:** `tests/tests-automations/regression/serving/end-user-job-lifecycle-gating.spec.ts`

**Last validated:** Langflow 1.13.0.dev30 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

With the serving-plane identity header **configured and trusted**, a background job started
by end user **A** cannot be read, enumerated, stopped, resumed or re-attached to by end user
**B** — and B's refused attempts leave A's job exactly as it was. This is
`langflow-ai/langflow` [#14550](https://github.com/langflow-ai/langflow/pull/14550)'s phase 3
("Jobs lifecycle isolation", commit `eab1405de2`): the end user is recorded in
`job_metadata['end_user_id']` and every jobs endpoint checks it.

The lane, the container script and the four-configuration contract are specified in
[`docs/serving/end-user-identity-lane.md`](end-user-identity-lane.md); the memory boundary on
the same configuration is [`end-user-identity-isolation.md`](end-user-identity-isolation.md).
This document specifies the **job** boundary, which that one listed as its natural follow-up.

**Why the job needs its own boundary.** On the serving plane every end user rides the same
service account (the SID), so `job.user_id` is the SID for everybody — the SID-level
ownership check every jobs endpoint already had cannot tell two end users apart. The end
user lives only in `job_metadata`, and the endpoint-level check against it is the sole thing
that does.

**Every request in this spec carries the auto-login superuser's bearer token, and that is
the point, not a shortcut.** The jobs endpoints have a superuser bypass. On the serving plane
the SID *is* a superuser, so an unconditional bypass would let any end user act on any other
end user's run. Upstream suppresses the bypass whenever the feature is on. A spec that called
as a non-superuser would pass on an instance where that suppression is missing, so the
superuser token is what makes this spec test it.

**Measured on `1.13.0.dev30`, `HEADER=X-End-User-Id` + `TRUST=true`.** The job is a Human
Input run submitted by `alice` with `mode=background`, parked at `status: "suspended"`.
`bob` and an anonymous caller (no identity header) make the same requests on the same job:

| door | `alice` (the owner) | `bob` | anonymous |
|---|---|---|---|
| `GET /api/v2/workflows?job_id=` | `200`, `status: "suspended"` | `404 JOB_NOT_FOUND` | `404 JOB_NOT_FOUND` |
| `GET /api/v2/workflows/pending?flow_id=` | 1 row: that `job_id`, `session_id: "alice::S"` | `[]` | `[]` |
| `POST /api/v2/workflows/stop` | `200` "cancelled successfully" → `cancelled` | `404 JOB_NOT_FOUND` | `404 JOB_NOT_FOUND` |
| `POST /api/v2/workflows/{job_id}/resume` | `200 resuming` → `completed` | `404 JOB_NOT_FOUND` | `404 JOB_NOT_FOUND` |
| `GET /api/v2/workflows/{job_id}/events` | `200 text/event-stream`, replay carries her message | `404 JOB_NOT_FOUND` | `404 JOB_NOT_FOUND` |

Three properties of that table are what the spec asserts. Each one catches a different way
the boundary could break.

**1 — The refusal does not leak that the job exists.** Upstream answers `404`, not `403`,
on purpose. The measurement backs that up: B's response on each door is **byte-identical**
to the response for a job id that never existed (`00000000-…`), apart from the echoed
`job_id`. So the spec compares the two whole bodies, not just the status. A `403`, a
different `error` string, or a message that names the owner would each tell B that the job
exists. All three still pass a status-only check.

**2 — A refused attempt has no side effect.** After B's `stop` and `resume` are refused,
A's job still reads `suspended` and A's pending list still shows it. A guard that refused
the response *after* acting on the job would pass a status-only check while B cancels A's
run.

**3 — The refusal is about identity, not about the request.** Each refused request is then
sent again **unchanged** except for the identity header, by A, and it succeeds. This matters
most for `resume`. B's body carries the real `request_id` and an allowed decision, and the
pending request is single-use. So if B's resume had been *accepted* behind a `404`, A's
identical resume would answer `409 NOT_RESUMABLE`. A's `200` therefore proves both that B's
request was well-formed and that it consumed nothing. Without this control, an endpoint that
`404`s everyone would pass every refusal row.

**Anonymous is a refused caller in its own right.** Upstream decided that an anonymous
request must not reach an identified run. The check is subtle: a request with no end user
matches only a job that also has none. A regression that compared "no identity" as a
wildcard would let any header-less client act on every identified user's run. So every
refusal is asserted for B **and** for the anonymous caller.

**Why a Human Input run.** A run parked at `suspended` is a live, non-terminal job that
stays put until someone answers it. That makes `stop` and `resume` meaningful. It also makes
"B's attempt changed nothing" observable without racing a run to completion. A plain Chat
Input → Chat Output background job completes in about 1.5 s, so a refused `stop` on it
proves little. The ownership check does run before the terminal-state check, but on a
finished job "nothing changed" is the outcome either way. The flow is the existing
`human-input-branching-fixture.json` (Chat Input → Human Input → two Chat Outputs). No model
is involved.

---

## Tags *(required)*

`["@api", "@regression", "@serving"]`

The same set as the three sibling `serving/` specs, for the same reasons. `@api` for the
layer. `@regression` for the upstream property being pinned. `@serving` is the lane
selector: `tests/fixtures/lane.ts` `grepInvert`s it out of every invocation without
`PW_SERVING_IDENTITY=1`, and the stock image's defaults cannot reach the configuration this
spec needs.

**No `@stable`, and it cannot have it**: nothing runs `@serving` on a cron, so a `@stable`
`@serving` test would silently never run (#1010). Whether `@serving` gets a scheduled lane is
#2051's decision.

---

## Precondition *(required)*

```bash
./scripts/start-langflow-serving-identity.sh
```

The default invocation: `serving_end_user_header='X-End-User-Id'`,
`serving_trust_proxy_headers=True`, `serving_end_user_required=False`, container
`langflow-serving-identity` on port `7893`. `auto_login` is on.

**The guard runs in `beforeAll`, not as a test of its own, and it fails rather than skips.**
On the wrong configuration this spec would report a **false leak** rather than a skip.
Measured from the source:

- **Default instance** (header unset): no end user is stamped and the superuser bypass
  applies, so `bob` reads `alice`'s job with `200`.
- **Untrusted instance**: `alice` is anonymised, so her job carries no end user, and an
  anonymous `bob` matches it.

In both cases the refusal rows go red as "another user can read the job". That is a security
finding against a product that is behaving correctly. So the probe
(`requireServingConfiguration(…, "trusted")`, the helper the siblings use) gates **every**
test. Each test then fails with the configuration named, never with a misattributed leak.

---

## Step by step *(required)*

**Shared setup (`beforeAll`).** Get the auto-login bearer. Create a Chat Input → Chat Output
flow and run the trusted-configuration probe on it. **Each test** then creates its own Human
Input flow, so the pending list for that flow is unambiguous. As `alice`, it submits
`POST /api/v2/workflows` with `mode=background` on a fresh `session_id` `S`. It then polls
`GET /api/v2/workflows?job_id=` as `alice` until `status: "suspended"` (measured ≈ 0.6 s; the
poll is capped at 30 s).

Each test then does the following:

1. **Another end user cannot read or enumerate the job.**
   - `alice`: status `200 suspended`. Pending lists exactly one row, with her `job_id` and
     `session_id: "alice::S"`.
   - `bob`, then anonymous: status `404`, and the body equals the never-existed job's body
     with the job id substituted. Pending on the same flow is `[]`.
2. **Another end user cannot stop the job.**
   - `bob`, then anonymous: `POST /stop {job_id}` returns `404`, with the same body as the
     never-existed job.
   - The job is untouched: `alice` still reads `suspended`, and her pending list still shows
     it.
   - Positive control: `alice` sends the identical request and gets `200` "cancelled
     successfully". Her status read then returns `cancelled`.
3. **Another end user cannot resume the job.**
   - `alice` reads the `request_id` from her pending row.
   - `bob`, then anonymous: `POST /{job_id}/resume {request_id, decision: {action_id: "approve"}}`
     returns `404`, with the same body as the never-existed job.
   - The job is untouched: `alice` still reads `suspended`, and her pending list still shows
     it.
   - Positive control: `alice` sends the **identical** body and gets `200 resuming`. Her
     status read then reaches `completed`.
4. **Another end user cannot re-attach to the job's event stream.** First, `alice` answers
   the run so the job is terminal and its stream replays and closes. A suspended job's stream
   tails until the run ends; an answered job's closes, measured at 17 ms.
   - `bob`, then anonymous: `GET /{job_id}/events` returns `404`, with the same body as the
     never-existed job.
   - Positive control: `alice` gets `200 text/event-stream`, and the replay contains her
     `add_message` event for `alice::S`. That replay is exactly the content B's `404` withholds.
5. **Cleanup.** `afterEach` stops any job its test left suspended (as `alice`, the only
   identity that can) and deletes that test's flow. `afterAll` deletes the probe flow. Ids
   are recorded **before** the assertions that can throw.

---

## Validation criterion *(required)*

- On every door, `bob`'s **and** the anonymous caller's response is `404` with
  `code: "JOB_NOT_FOUND"`. The whole body equals the response for a job id that never
  existed, with the job id substituted.
- After each refused `stop` or `resume`, `alice`'s job still reads `suspended` and is still
  listed for her.
- `alice`'s identical request on each door succeeds: status `200 suspended`, stop →
  `cancelled`, resume → `completed`, events `200` with her message in the replay.
- `bob` and the anonymous caller see `[]` on pending, while `alice` sees exactly her one row.
- On the wrong configuration every test fails with the guard's message naming it, never with
  a refusal assertion.

**Force-fail evidence:** the mutation that matters in each test is the **leak reading**. For
example, assert that `bob`'s status read returns `200`, or that `bob`'s pending list holds
one row. Inverting `alice`'s positive control also reddens the test, but it proves less,
because a broken instance would fail that either way.

---

## What this does not cover *(and why)*

- **The other three configurations.** Default, untrusted and required. On the first two the
  refusal rows are *expected* to fail (see Precondition), and asserting that would be a
  different spec on a different container. Under `required`, the jobs endpoints resolve the
  end user with `require_identity` forced **off** (`resolve_serving_end_user_id` is "a pure
  identifier resolver, never a gate"). So an anonymous status read is `404`, not
  `401 END_USER_IDENTITY_REQUIRED`. That is plausible, and not measured here.
- **Owner canonicalisation.** Both sides derive the owner through
  `derive_message_owner_uuid`, so a raw-string id and its UUID form compare equal. That is a
  property of ids the gateway mints, which a client cannot forge. Testing it would mean
  sending one user's id in two spellings, which no real caller does.
- **Sync-mode jobs.** A `mode=sync` run also creates a job row and is gated the same way:
  `bob` gets `404` on status and stop (measured). Its read-back carries the separate
  `session_id == flow_id` race that `api/flows/workflows-v2-job-lifecycle.spec.ts` pins as
  `test.fail()` (#1575). Its `stop` is refused `409 JOB_NOT_CANCELLABLE` for everyone, which
  leaves no positive control to separate identity from mode. One side observation, not
  asserted: that `409` reports `"mode": "unknown"` for a job submitted as `sync`.
- **The feature-off superuser bypass.** With the header unset, the superuser *does* reach
  every job, which is pre-feature behaviour. That belongs to the stock lane, not this one.
- **`serving_internal_mcp_hosts`** (#14550 phase 4) and **`serving_trace_end_user`**
  (#14616). They need an internal MCP host and an OTLP collector, as the lane doc records.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v2/workflow.py` — `_end_user_matches` and
  `_caller_owns_job_end_user` (the ownership rule and the superuser-bypass suppression), and
  the five doors that apply it.
- `src/backend/base/langflow/api/v2/hitl.py` — `list_pending_human_requests`, which filters
  the enumerating pending list through the same `_end_user_matches`.
- `src/backend/base/langflow/services/jobs/service.py` — stamps
  `job_metadata['end_user_id']` at job creation. `job.user_id` stays the SID.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — `resolve_serving_end_user_id`, the
  non-gating resolver the jobs endpoints call.
- **Langflow API** — `GET /api/v1/auto_login`, `POST /api/v1/flows/`,
  `POST /api/v2/workflows`, `GET /api/v2/workflows`, `GET /api/v2/workflows/pending`,
  `POST /api/v2/workflows/stop`, `POST /api/v2/workflows/{job_id}/resume`,
  `GET /api/v2/workflows/{job_id}/events`, `DELETE /api/v1/flows/{id}`.
- **`tests/assets/flows/human-input-branching-fixture.json`** — the Human Input flow, shared
  with `core-functionality/playground/human-input-pause-resume.spec.ts`.
- **`scripts/start-langflow-serving-identity.sh`** and the `PW_SERVING_IDENTITY` lane (#1582).
- **No provider key, no model, no external network.**
