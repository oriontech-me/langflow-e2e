# Serving-plane end-user identity — the isolation boundary, when trusted

**File:** `tests/tests-automations/regression/serving/end-user-identity-isolation.spec.ts`

**Last validated:** Langflow 1.12.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

With the serving-plane identity header **configured and trusted**, two end users sharing one
`session_id` get separate chat memory, on every serving surface — and nothing leaks into the
shared session they nominally sent.

The lane, the container script and the four-configuration contract are specified in
[`docs/serving/end-user-identity-lane.md`](end-user-identity-lane.md) (#1582); read the
contract there rather than here. This document specifies the **trusted** row of it, which is
the row the feature exists for.

**Measured on `dev38`, `HEADER=X-End-User-Id` + `TRUST=true`:**

| surface | `alice` on `S` | `bob` on `S` | in `alice::S` | in `bob::S` | in bare `S` |
|---|---|---|---|---|---|
| `POST /api/v2/workflows` | `alice::S` | `bob::S` | 2 | 2 | **0** |
| `POST /api/v1/run/{id}` | `alice::S` | `bob::S` | 2 | 2 | **0** |

**The bare-`S`-is-empty clause is the boundary, not a tidiness check.** A merge that scoped
the read but also wrote to the unscoped session would leave both per-user reads looking
perfectly correct — `alice::S` has alice's two, `bob::S` has bob's two — while a third client
running on plain `S` reads everybody's history. That third reading is the only one that
catches it, so it is asserted explicitly rather than implied.

**Anonymous persists nothing, asserted over the whole flow.** A run with no identity header
reports `anon::<uuid>` — a **fresh uuid per request**, not per session — and writes zero rows.
The assertion is `GET /api/v1/monitor/messages?flow_id=<id>` (measured **0**), not
`?session_id=<the reported anon session>`: asserting only the reported session would pass on
a run that persisted somewhere else entirely, which is exactly the failure a scoping bug
produces. Checking the flow means "nowhere", not "not there".

**Both surfaces, because a partial rollout is the likely regression.** #14550's phase 1 is
described as extending the v2-only scoping to all serving APIs; v1 (`POST /api/v1/run/{id}`,
through a minted `x-api-key`) is where that extension would come undone first, and it is the
surface deployed integrations actually call.

---

## Tags *(required)*

`["@api", "@regression", "@serving"]`

`@api` for the layer, `@regression` for the upstream property being pinned, and `@serving` —
the **lane selector** added in #1582 — because this spec is unrunnable anywhere else:
`tests/fixtures/lane.ts` `grepInvert`s `@serving` out of every invocation without
`PW_SERVING_IDENTITY=1`, and the configuration it needs cannot be reached from the stock
image's defaults.

**No `@stable`, and it cannot have it**: nothing runs `@serving` on a cron, so a `@stable`
`@serving` test would silently never run — the exact hole #1010 documented for
`@destructive` and `@enterprise`.

---

## Precondition *(required)*

```bash
./scripts/start-langflow-serving-identity.sh
```

The default invocation: `serving_end_user_header='X-End-User-Id'`,
`serving_trust_proxy_headers=True`, `serving_end_user_required=False`. Container
`langflow-serving-identity` on port `7893`; the script reads the three settings back out of
the running process and prints them, and fails when another process shadows its port.

`auto_login` is on (the same image, only the configuration differs), so the bearer token and
the API key are minted the usual way.

**The configuration is not observable through any API.** `GET /api/v1/config` exposes 35
keys and **none** of them mention `serving`, `end_user` or `trust` (measured on `dev38`), and
there is no settings endpoint that does. So the spec cannot read its precondition — it has
to *probe* it, which is why step 1 below is a behavioural guard and why it fails rather than
skips.

---

## Step by step *(required)*

1. **Guard the configuration, fail-closed.** Create the keyless `Chat Input → Chat Output`
   flow and run it once with `X-End-User-Id: <probe>`. The reported `session_id` must be
   `<probe>::<session>`. Two other readings are named distinctly, because they are two
   different mistakes with the same symptom: the session **verbatim** means the header is
   unset (a stock instance — this is `api/flows/serving-end-user-identity-default.spec.ts`'s
   instance, not this one), and `anon::<uuid>` means the header is named but untrusted
   (`end-user-identity-untrusted.spec.ts`'s instance). Each message names the exact script
   invocation that produces the state this spec needs. Same shape as
   `requireRbacInstance()` in the Enterprise lane, for the same reason: a foundation test
   that proves the variant is what it claims, so every later assertion measures the product
   and not a misconfigured container.
2. **v2 isolation.** `POST /api/v2/workflows` twice on one `session_id`, as `alice` then
   `bob`. Responses report `alice::S` and `bob::S`. Counts: `alice::S` = 2, `bob::S` = 2,
   bare `S` = **0**.
3. **v1 isolation.** Mint an `x-api-key`, then `POST /api/v1/run/{flow_id}` twice on a fresh
   `session_id` with the same two identities. Same three readings.
4. **Anonymous writes nothing.** On a **fresh flow** — so the count is unambiguous — one
   `POST /api/v2/workflows` with no identity header. The response reports
   `anon::<uuid>`; `?flow_id=<that flow>` holds **0**.
5. **Cleanup.** `afterAll` deletes every flow by recorded id and revokes the minted key.
   Ids are pushed **before** the asserts that can throw.

---

## Validation criterion *(required)*

- Every count above exact, on both surfaces, with bare `S` empty and the anonymous flow
  holding zero rows — after the guard confirmed the instance is in the trusted state.
- The guard itself is verified in the other direction: pointed at the stock instance it
  **fails** naming "header unset", and pointed at the untrusted container it **fails** naming
  `anon::`. A guard that only ever sees its happy state is not a guard.

**Force-fail evidence:** the mutation that matters is asserting bare `S` holds 2 instead of
0 — the leak reading. Inverting a per-user count reddens the same test more loudly but
proves less, since a broken instance would fail it either way.

---

## What this does not cover *(and why)*

- **`TRUST=false` and `REQUIRED=true`** — `end-user-identity-untrusted.spec.ts` and
  `end-user-identity-required.spec.ts`. One file per container state, because a spec cannot
  restart its own instance and a state-detecting file would have to branch inside its tests,
  hiding which row was actually asserted. The three files also give the pipeline three
  separately-burstable targets.
- **`serving_internal_mcp_hosts`** (#14550 phase 4) — needs an internal MCP host to point at.
- **`serving_trace_end_user`** and the span link (#14616) — need an OTLP collector this repo
  does not have.
- **Job-lifecycle gating by end user** (#14550 phase 3 — `GET /workflows`, `/stop`,
  `/resume` refusing another end user's run). Real, and the natural follow-up now that the
  lane exists; kept out so this issue lands the memory boundary first.
- **A scheduled lane.** None exists for `@serving`; adding one is a separate CI-spend
  decision.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/services/settings/groups/security.py` — declares
  `serving_end_user_header`, `serving_trust_proxy_headers` and `serving_end_user_required`.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — the resolver producing `alice::S` and
  `anon::<uuid>`.
- **Langflow API** — `GET /api/v1/auto_login`, `POST /api/v1/flows/`, `POST /api/v1/api_key/`,
  `POST /api/v2/workflows`, `POST /api/v1/run/{id}`, `GET /api/v1/monitor/messages`,
  `DELETE /api/v1/flows/{id}`.
- **`scripts/start-langflow-serving-identity.sh`** and the `PW_SERVING_IDENTITY` lane, both
  from #1582.
- **No provider key, no model, no external network.**
