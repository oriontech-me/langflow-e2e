# Bulk Delete Traces — span cascade regression (#13955)

**Last validated:** Langflow 1.11.x (green on the fixed release; confirmed red on 1.10.0 with FK enforcement — see Validation criterion)

---

## What this test validates *(required)*

Clearing a flow's traces (`DELETE /api/v1/monitor/traces?flow_id=...`, the wire behind the **Clear All** button) must remove a trace **together with its spans**, even when the trace has a populated span tree.

This is a regression guard for [langflow-ai/langflow#13955](https://github.com/langflow-ai/langflow/issues/13955) — *"Langflow traces - Clear all does not worked"*. Root cause: the `span.trace_id` foreign key was declared **without** `ondelete="CASCADE"` (unlike `trace.flow_id`, which had it). The handler deletes traces with a single raw statement (`sa.delete(TraceTable).where(flow_id == ...)`) that **never goes through the ORM cascade machinery**, so it relied on a database-level cascade that did not exist. Whenever a trace still had spans, the delete violated `span_trace_id_fkey`, returned **500**, and left every trace behind — Clear All silently did nothing. The fix ([PR #13976](https://github.com/langflow-ai/langflow/pull/13976), merged to `release-1.11.0`) adds `ondelete="CASCADE"` plus a migration, so the delete removes the trace and its spans in one statement (**204**).

The test seeds a flow whose run emits a trace with a **guaranteed non-empty span tree**, anchors on `spanCount > 0`, then asserts the delete returns **204**, empties the trace list, and leaves the trace detail **404**.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

---

## Step by step *(required)*

**`describe("Clear traces with a populated span tree (regression #13955)")` — `mode: "serial"`, shared `beforeAll`**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/`, Bearer auth, name `traces-delete-cascade-test-<timestamp>`); capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/`, `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json` (the same fixture as `traces-delete.spec.ts` and the `traces-detail-*` specs), name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow once (`POST /api/v1/run/{flowId}`, `x-api-key` auth). The fixture has no provider configured, so the LanguageModelComponent fails — intentional: the failed run still emits a trace with a populated span tree. Accept HTTP 200 or 500
5. **Stable-count poll on the span count**: repeatedly `GET /api/v1/monitor/traces?flow_id=<flowId>` (capture the first `trace.id`), then `GET /api/v1/monitor/traces/{trace_id}` and read `spans.length`, until the count is the same across two consecutive reads (`stableConfirms >= 1`), up to 30 s with intervals `[500, 500, 1000, 1000, 2000]` ms. Capture the settled count as `spanCount`. The trace row can land a beat before its spans, and spans can be inserted asynchronously — polling on the span count guards both races

**`afterAll`** — delete the flow and the API key, both with the bearer token (flow delete intentionally does **not** use the api_key, so the two deletes do not race), via `Promise.allSettled`.

**Test — `Clearing traces for a flow whose trace has spans succeeds (cascade), leaving no traces behind`**
1. Anchor: `expect(spanCount).toBeGreaterThan(0)` — proves the trace under test actually has a span tree, so the DELETE exercises the span → trace FK. This is what separates this spec from the plain bulk-delete contract test
2. `DELETE /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) → assert HTTP **204** + empty body
3. `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) → HTTP 200, `traces.length === 0`, `total === 0`
4. `GET /api/v1/monitor/traces/{traceId}` (Bearer auth) → HTTP **404** (the trace and its spans are gone)

---

## Validation criterion *(required)*

- **Anchor (`spanCount > 0`)** — blocks the "green for the wrong reason" failure mode: if the trace had no spans, the DELETE would never touch the cascade path and a 204 would prove nothing about #13955.
- **`DELETE` → 204 + empty body** — the core assertion. On an FK-enforcing DB the pre-fix handler raises the FK violation and returns **500** here (confirmed against Langflow 1.10.0 with `foreign_keys=ON`), so a regression fails on this line. This is an API-only test (the `request` fixture), and the fixtures' backend-error monitor listens on `page.on("response")` — it does **not** observe `request`-issued calls — so the explicit status assertion is the sole detection signal, by design.
- **Post-DELETE `traces.length === 0` / `total === 0`** — the buggy path rolls the delete back, so the list would still be non-empty; this pins the row-removal side effect.
- **Trace detail → 404** — confirms the trace (and, via the cascade, its spans) is actually gone, not merely hidden.
- Combined, the test catches the exact #13955 symptom **and** related cascade/orphan regressions: a partial delete that leaves rows behind, a re-introduced FK violation, or a cascade that removes the trace but orphans its spans.

---

## External dependencies *(required)*

> ⚠️ **This bug is only observable when the database enforces foreign keys.** Postgres always does. **SQLite does NOT by default** — Langflow's default `sqlite_pragmas` (`lfx/services/settings/base.py`) omit `foreign_keys`, so `span_trace_id_fkey` is not enforced and the buggy `DELETE` "succeeds" (204, leaving orphaned spans) — the test would then pass for the wrong reason. To exercise the bug against a SQLite SUT, launch Langflow with `LANGFLOW_SQLITE_PRAGMAS` including `"foreign_keys": "ON"` (the dict replaces the default wholesale, so repeat the default pragmas), or run against Postgres. Wiring FK enforcement into the CI SUT (`scripts/start-langflow-docker.sh`) is tracked separately from this spec — see Notes.

References in the **main Langflow repository**:

- `src/backend/base/langflow/services/database/models/traces/model.py` — `SpanTable.trace_id` foreign key; the fix adds `ondelete="CASCADE"` (parity with `TraceTable.flow_id`)
- `src/backend/base/langflow/alembic/versions/e1705947c729_ensure_span_trace_id_foreign_key_has_.py` — migration adding the cascade to existing databases (absent on `release-1.10.0`, present on `release-1.11.0`)
- `src/backend/base/langflow/api/v1/traces.py` — `delete_traces_by_flow` handler; the raw `sa.delete(TraceTable)` that bypasses the ORM cascade

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — provider-less Basic Prompting flow; its run fails but still emits a trace with a populated span tree (shared with `traces-delete.spec.ts` and the `traces-detail-*` specs, which prove it emits `spans.length > 0` on the nightly SUT)
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token (auto_login)
- `tests/helpers/flows/delete-flow.ts` — flow cleanup with failed-deletion surfacing
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-delete.spec.ts` — companion spec covering the delete endpoint's **status-code / ownership contract**

---

## What this test does not cover *(optional)*

- **The delete endpoint status-code / ownership contract** — unknown-flow 404, exact 204 wire contract, idempotent second-delete, ownership lookup. That is `traces-delete.spec.ts`'s job; this spec deliberately does not re-assert it, to avoid duplicating coverage. The two specs are split by dimension: contract vs. cascade/data-integrity.
- **FK-unenforced SQLite** — against the default SUT the bug is invisible through the API (the orphaned spans are not exposed by any public endpoint). See External dependencies.
- **UI surface** — the **Clear All** button, its confirmation dialog, and the post-mutation grid refresh are not exercised here.
- **Per-trace delete** (`DELETE /api/v1/monitor/traces/{trace_id}`) — a distinct handler, not covered by any spec.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The SUT database **enforces foreign keys** (Postgres, or SQLite with `foreign_keys=ON`) — otherwise the test passes without exercising the bug
- The configured auth (`auto_login` or superuser) can issue a token via `getAuthToken`
- No provider keys required — the fixture runs without a model configured

---

## Notes *(optional)*

- The seeding pattern (key + flow + run + stable-count poll) and the fixture are shared with `traces-delete.spec.ts` on purpose; this spec differs only in the poll anchoring on **span count** (via the trace detail) rather than trace count, so it can assert a populated span tree exists before the delete.
- Making this test bite in the daily/nightly CI requires enabling FK enforcement on the CI SUT — a shared-infrastructure change (`scripts/start-langflow-docker.sh`) intentionally kept out of this spec's scope and tracked as a dedicated follow-up.
