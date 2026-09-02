# Serving-plane end-user identity — inert on a default instance

**File:** `tests/tests-automations/regression/api/flows/serving-end-user-identity-default.spec.ts`

**Last validated:** Langflow 1.13.0.dev0 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

On a **default** instance, a client-supplied `X-End-User-Id` header must do **nothing**.

Langflow 1.12 added serving-plane end-user identity (`langflow-ai/langflow`
[#14443](https://github.com/langflow-ai/langflow/pull/14443),
[#14550](https://github.com/langflow-ai/langflow/pull/14550)): a *trusted gateway* header
scopes per-user chat memory, so two end users sharing one `session_id` do not read each
other's history. The feature is off by default and turned on only by instance-global
environment variables — `LANGFLOW_SERVING_END_USER_HEADER` plus
`LANGFLOW_SERVING_TRUST_PROXY_HEADERS`.

**This spec asserts the "off" half of that contract**, which is the configuration every
deployment is in today. If a future change ever honours the header without the trust flag,
an attacker who can set a request header picks which user's memory a run reads and writes —
a cross-user memory-read vector reachable from any client. Nothing in the suite would notice:
the run answers `200`, the output is correct, and the only difference is *which* session row
the message landed in.

**Measured on `dev38`, both serving surfaces, header ignored on each:**

| surface | `alice` on `S` | `bob` on `S` | in `S` | in `alice::S` | in `bob::S` |
|---|---|---|---|---|---|
| `POST /api/v2/workflows` | reports `S` | reports `S` | **4** | 0 | 0 |
| `POST /api/v1/run/{id}` | reports `S` | reports `S` | **4** | 0 | 0 |

**Both surfaces are asserted, not just v2.** #14550's phase 1 describes extending the
v2-only session-scoping behaviour "to all serving APIs", so v1 is the surface where a
partial rollout would first honour the header — and it is also the surface with the wider
blast radius, since `POST /api/v1/run/{id}` is what a deployed integration calls with a
minted `x-api-key`.

**The control is not optional.** "The header did nothing" and "chat memory does not work at
all" produce identical readings for the assertions above — both leave `alice::S` and `bob::S`
empty. So the spec also runs one identity-less request on a **different** `session_id` and
requires that session to hold exactly its own 2 messages. Without it the test passes on an
instance where persistence is broken outright, which is the vacuous-assert failure mode this
suite has paid for before (#570/#1012: a green run that measured nothing).

The header value itself is chosen adversarially rather than cosmetically: the identities are
`alice`/`bob`-shaped, and the assertion looks for the *scoped* session keys
(`alice::<session>`) that a trusting instance produces. A spec that only checked
"the reported `session_id` equals what I sent" would miss an instance that reports the plain
session while persisting to the scoped one.

---

## Tags *(required)*

`["@api", "@regression"]`

`@api` for the layer — the whole spec is `request`-fixture calls, no browser. `@regression`
because it pins an upstream security property rather than exploring a feature.

**Deliberately not `@serving`.** That tag is a *lane selector*: `tests/fixtures/lane.ts`
`grepInvert`s it out of every normal run, so adding it here would move this spec into the
opt-in lane and it would then never run on the default instance — which is the only instance
it has anything to say about. The inert half belongs on the stock lane by construction.

**`@stable` since the validation cycle.** It shipped without the tag, per the repo rule that
the tag is added only after team validation; the run that satisfied that rule is recorded under
*Validation criterion* below. It was always the easy candidate — keyless, no model, no external
network, ~2.5 s — so nothing about the spec changed to earn the tag.

---

## Precondition *(required)*

- A default OSS instance: no `LANGFLOW_SERVING_*` variable set. `./scripts/start-langflow-docker.sh`
  produces one; so does any instance this suite normally targets.
- `auto_login` (the stock nightly), for the bearer token and the minted API key.
- No provider key, no model, no external network.

**A serving-configured instance must not silently pass this spec**, so step 1 is a
fail-closed guard: the spec probes the instance and **fails** if the header is honoured,
naming what it found. Skipping instead would make the spec green on the one instance where
its premise is false (#1010's green all-skip).

---

## Step by step *(required)*

1. **Guard the premise.** Mint a bearer token (`GET /api/v1/auto_login`), create the
   keyless `Chat Input → Chat Output` flow (`createRunnableChatFlowViaApi`), and run it once
   through `POST /api/v2/workflows` carrying `X-End-User-Id: <probe>`. The reported
   `session_id` must equal the session sent, verbatim. A `<probe>::<session>` or `anon::<uuid>`
   reading means the instance is serving-configured — the spec fails naming which, and points
   at the stock start script.
2. **v2, two identities, one session.** Run `POST /api/v2/workflows` twice on the same
   `session_id` with `X-End-User-Id: alice` then `bob`. Both responses report the session
   verbatim. `GET /api/v1/monitor/messages?session_id=<S>` holds **4**;
   `?session_id=alice::<S>` and `?session_id=bob::<S>` hold **0** each.
3. **v1 run, same shape.** Mint an `x-api-key` (`POST /api/v1/api_key/`), run
   `POST /api/v1/run/{flow_id}` twice on a fresh `session_id` with the same two identities.
   Same three counts: 4 / 0 / 0.
4. **Control.** One `POST /api/v2/workflows` with **no** identity header on a third
   `session_id`; that session holds exactly **2**. This is what makes steps 2–3 non-vacuous.
5. **Cleanup.** `afterAll` deletes the flow by id and revokes the minted API key. Ids are
   recorded *before* the asserts that could throw, so a failing assertion cannot leak the
   flow — the ordering bug caught during #1575's force-fail.

---

## Validation criterion *(required)*

Every count above is exact, on both surfaces, with the control session non-empty — and the
premise guard passes, so all of it was measured on an instance whose header is genuinely
unconfigured.

**Force-fail evidence** (what a real regression would look like): inverting any single count
must redden exactly one test. The behavioural mutation that matters is the one that mimics
the vector — asserting `alice::S` holds 2 instead of 0 — because that is the reading a
trusting instance produces.

**Promotion run** (2 Sep 2026). Recorded here because `@stable` is what puts this file in front of
`daily-stable.yml` every weekday, and the tag is only worth the alarm it raises if the run behind
it is stated rather than remembered.

| | |
|---|---|
| Instance | `1.12.0.dev45` · `package: "Langflow Nightly"` · `LANGFLOW_WORKERS=1` |
| Repeats | 4 consecutive runs, `--workers=1 --retries=0` |
| Result | 16 of 16 `expected`, 0 unexpected, 0 flaky, 0 skipped |
| Duration | 2–3 s per run |
| Backend errors | 0 occurrences of `🚨 Backend Error` across every run |
| Re-measured | `nightly:latest` moved to `1.13.0.dev0` mid-promotion, and that is the line `daily-stable.yml` now runs — so the burst was repeated there on a **freshly created container**: 21 of 21 `expected` over 3 runs of the two promoted files together, 21–23 s for both files together, 0 backend errors |
| Flow cleanup | `GET /api/v1/flows/?remove_example_flows=true&header_flows=true` reads **0 before and 0 after** the three 1.13 runs — the file leaks nothing |
| Force-fail | `expect(countMessages(…, `session_id=${BOB}::${session}`)).toBe(0)` → `toBe(99)` reddens exactly one test (3 expected / 1 unexpected); reverted |


---

## What this does not cover *(and why)*

- **The trusted configuration.** `serving/end-user-identity-isolation.spec.ts` — a different
  instance, hence a different lane. The pair is the point: the same header, inert here and
  decisive there. Either alone is weak.
- **Other clients of the header** — the playground UI, MCP, A2A. This is the API contract;
  a UI that sets the header is a separate surface.
- **Whether the plain session is itself isolated per user account.** Out of scope: this is
  about the *end-user* dimension the header adds, not about account ownership.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/services/settings/groups/security.py` — declares
  `serving_end_user_header` and `serving_trust_proxy_headers`, both off by default. The
  defaults are what this spec asserts the behaviour of.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — the resolver that would scope the
  session if the flags were on.
- **Langflow API** — `GET /api/v1/auto_login`, `POST /api/v1/flows/`, `POST /api/v1/api_key/`,
  `POST /api/v2/workflows`, `POST /api/v1/run/{id}`, `GET /api/v1/monitor/messages`,
  `DELETE /api/v1/flows/{id}`.
- **`langflowai/langflow-nightly:latest`** at its stock configuration.
- **No provider key, no model, no external network.**
