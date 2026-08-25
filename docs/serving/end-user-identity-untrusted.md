# Serving-plane end-user identity — named but untrusted is fail-closed *and* fail-silent

**File:** `tests/tests-automations/regression/serving/end-user-identity-untrusted.spec.ts`

**Last validated:** Langflow 1.12.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

With `LANGFLOW_SERVING_END_USER_HEADER` set but `LANGFLOW_SERVING_TRUST_PROXY_HEADERS`
**false**, the header is not honoured — and the request does **not** fall back to the plain
session either. Every request becomes `anon::<uuid>` and persists nothing, while still
answering `200 completed`.

That second half is the reason this spec exists as its own file rather than a footnote to the
trusted one. The configuration is **fail-closed for security** — no client can pick a
victim's scope by setting a header — and **fail-silent for operations**: an operator who sets
the header name and forgets the trust flag has an instance that runs every flow successfully
and remembers nothing, instance-wide, with no error, no warning and no observable difference
in any response status.

**Measured on `dev38`, `HEADER=X-End-User-Id` + `TRUST=false`, three requests on one session:**

| request | reported `session_id` | rows in `S` | rows in `alice::S` | rows in the whole flow |
|---|---|---|---|---|
| `X-End-User-Id: alice` | `anon::5cc7904c…` | 0 | 0 | **0** |
| no header | `anon::9207374a…` | 0 | 0 | **0** |
| `X-End-User-Id: "   "` | `anon::1ff2bf07…` | 0 | 0 | **0** |

All three `status: "completed"`, HTTP `200`. **Three distinct uuids** — the anonymous scope is
minted per request, not per session, which is what makes "remembers nothing" exact rather
than approximate: even two consecutive requests from the same client share no memory.

**The flow-wide count is the load-bearing assertion.** Reading only the session the response
reported (`anon::<uuid>`) would confirm the run did not write *there* while saying nothing
about whether it wrote somewhere else — and "wrote somewhere else" is precisely what a
scoping bug does. `?flow_id=` is the query that means *nowhere*.

**The whitespace-only value is asserted here too**, not only under `REQUIRED=true`. Blank is
not an identity, and the interesting question in this configuration is that a blank value is
treated exactly like an absent one rather than becoming a scope named `"   "::S` — a scope
every client could trivially collide on.

---

## Tags *(required)*

`["@api", "@regression", "@serving"]`

Same reasoning as the isolation spec: `@serving` is the lane selector, and the configuration
is unreachable outside it. **No `@stable`** — no scheduled `@serving` lane exists, so the tag
would mean a test that never runs (#1010).

---

## Precondition *(required)*

```bash
LANGFLOW_SERVING_TRUST=0 ./scripts/start-langflow-serving-identity.sh
```

Reads back `serving_end_user_header='X-End-User-Id'`, `serving_trust_proxy_headers=False`,
`serving_end_user_required=False`.

The configuration is not readable through any API (`GET /api/v1/config` carries no
`serving`/`end_user`/`trust` key on `dev38`), so step 1 probes it behaviourally and **fails**
on any other state.

---

## Step by step *(required)*

1. **Guard the configuration, fail-closed.** Create the keyless `Chat Input → Chat Output`
   flow, run it once with `X-End-User-Id: <probe>`. The reported `session_id` must start with
   `anon::`. The two other readings are named separately: the session **verbatim** means the
   header is unset (stock instance), and `<probe>::<session>` means it is trusted — that is
   `end-user-identity-isolation.spec.ts`'s container. Each names the invocation that produces
   this spec's state.
2. **An identified request is anonymised and persists nothing.** On a fresh flow, one
   `POST /api/v2/workflows` with `X-End-User-Id: alice` on session `S`. Assert: HTTP `200`,
   `status: "completed"` (the fail-*silent* half — the run succeeds), reported session matches
   `anon::<uuid>`, and **all three** of `?session_id=S`, `?session_id=alice::S` and
   `?flow_id=<flow>` hold 0.
3. **A whitespace-only value is treated as absent, not as a scope.** Same flow, one run with
   `X-End-User-Id: "   "`. Reported session matches `anon::<uuid>`, and the flow still holds 0
   rows. The reported uuid must **differ** from step 2's — same request, same session, no
   shared scope.
4. **Cleanup.** `afterAll` deletes every recorded flow id.

---

## Validation criterion *(required)*

- Every identified request reports `anon::<uuid>` and the flow holds **zero** rows after all
  of them — with the run reporting `200 completed` throughout, so the silence is asserted
  rather than assumed.
- The two `anon::` uuids differ.
- The guard fails, naming the state found, when pointed at either sibling container.

**Force-fail evidence:** the mutation that matters is asserting the flow holds rows — the
reading a leaking instance produces. Asserting `alice::S` non-empty is the same class and
narrower.

---

## What this does not cover *(and why)*

- **A warning or log line for the misconfiguration.** There is none to assert: the
  configuration is silent by design and the point of this spec is to record that. Whether
  Langflow *should* refuse to start in this state is an upstream product question, not a test.
- The trusted and required rows — the two sibling files.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/services/settings/groups/security.py` — `serving_end_user_header`,
  `serving_trust_proxy_headers`.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — the resolver that produces
  `anon::<uuid>` when the header is not trusted.
- **Langflow API** — `GET /api/v1/auto_login`, `POST /api/v1/flows/`,
  `POST /api/v2/workflows`, `GET /api/v1/monitor/messages`, `DELETE /api/v1/flows/{id}`.
- **`scripts/start-langflow-serving-identity.sh`** with `LANGFLOW_SERVING_TRUST=0`, and the
  `PW_SERVING_IDENTITY` lane — both from #1582.
- **No provider key, no model, no external network.**
