# `POST /api/v1/flows/` returns 500 when two flows are created concurrently by the same user

| | |
|---|---|
| **Filed upstream** | Not yet — evidence collected here first |
| **Tracked in** | `oriontech-me/langflow-e2e#988` |
| **Component** | Langflow — backend, `api/v1/flows` create endpoint |
| **Surfaces** | `POST /api/v1/flows/` → `500 {"detail":"An internal error occurred while creating the flow."}` |
| **Observed on** | `langflowai/langflow-nightly:latest` — `1.12.0.dev7`, SQLite, `LANGFLOW_WORKERS=1`, `LANGFLOW_AUTO_LOGIN=true` |
| **Determinism** | Deterministic with a shared name — 3 of 4 simultaneous identical-name POSTs fail. Through the UI it is intermittent, because the collision window is the gap between two requests' name lookups |
| **Captured** | 2026-07-27, local Podman instance |

---

## 1. Summary

Creating two flows at the same time under one user returns **500** for all but one of
them. The endpoint derives a unique name with a **check-then-insert**: it SELECTs the
existing `<name> (N)` rows, computes `N+1`, and INSERTs in a separate statement. Two
requests interleaved between those two steps resolve to the *same* name, so the second
INSERT violates `UNIQUE (flow.user_id, flow.name)`. The resulting `IntegrityError` is
caught by a blanket `except Exception` and re-raised as an opaque 500 — no retry, and
no indication that the cause is a name conflict.

The SPA always posts the same base name for a new flow, so *every* concurrent creation
by one user is a candidate. When it happens the UI stays on the flows list with only a
toast; nothing navigates.

## 2. Steps to reproduce

```bash
TOK=$(curl -s http://localhost:7860/api/v1/auto_login | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# Same name, four at once
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "req$i → %{http_code}\n" -X POST "http://localhost:7860/api/v1/flows/" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d '{"name":"Concurrency Probe","description":"","data":{"nodes":[],"edges":[],"viewport":{"zoom":1,"x":0,"y":0}}}' &
done; wait
```

**Observed**

```
req4 → 201
req2 → 500
req3 → 500
req1 → 500
```

**Expected** — four 201s with de-duplicated names (`Concurrency Probe`,
`Concurrency Probe (1)`, …), which is precisely what the endpoint promises for the
sequential case.

The same four requests with **distinct** names all succeed, isolating the name
derivation as the failing step:

```
unique1 → 201   unique2 → 201   unique3 → 201   unique4 → 201
```

## 3. Server-side evidence

```
IntegrityError: (sqlite3.IntegrityError) UNIQUE constraint failed: flow.user_id, flow.name
[SQL: INSERT INTO flow (name, description, …, user_id, …) VALUES (?, ?, …)]
[parameters: ('New Flow (79)', 'Conversational Cartography Unlocked.', …)]
```

## 4. Code path

`src/backend/base/langflow/api/v1/flows_helpers.py`

```python
async def _deduplicate_flow_name(session, name, user_id) -> str:
    if not (await session.exec(select(Flow).where(Flow.name == name)
                                           .where(Flow.user_id == user_id))).first():
        return name
    flows = (await session.exec(select(Flow).where(Flow.name.like(f"{name} (%"))
                                            .where(Flow.user_id == user_id))).all()
    numbers = [...]
    return f"{name} ({max(numbers) + 1})" if numbers else f"{name} (1)"
```

```python
flow.name = await _deduplicate_flow_name(session, flow.name, user_id)   # ← SELECT
...
session.add(db_flow)
await session.flush()                                                    # ← INSERT
...
except Exception as e:
    logger.exception("Error creating flow")
    raise HTTPException(status_code=500,
                        detail="An internal error occurred while creating the flow.") from e
```

Nothing serialises the two statements, and no branch handles `IntegrityError`.

## 5. Suggested fix

Retry the derive-and-insert on `IntegrityError` (bounded), or make the name unique in a
single statement. Independently: a name conflict the server itself caused is not a 500 —
surfacing it as a 409 with the conflicting name would make the failure diagnosable from
the client.

## 6. Impact on this suite

`setupPlayground` used to create its flow through the UI and therefore inherited this
race — a random member of the playground family died in setup, 30s later, as an
unexplained `waitForURL` timeout. The helper now posts an explicit unique name, which
takes the de-duplication branch out of play entirely. That is a workaround for our own
writes only: any spec that creates a flow through the UI while another worker does the
same remains exposed until this is fixed upstream.

`loadTemplateByName` is the other exposed path (#1002) and it **cannot** take the
same workaround: the flow is created by the SPA when a template is picked, and the
modal journey it drives is itself the subject of
`create-flow-from-template.spec.ts` (including its name assertion), so the name is
not ours to choose. Two shared names collide there — the `New Flow` the entry point
creates on its own, and the template's own name, since many specs load the same
template. It therefore **retries the pick** when the creation POST answers non-2xx,
recovers a lost navigation by going to `/flow/<id>`, and reports the creation status
instead of a bare selector timeout. Still reproducible on **1.12.0.dev9** — 2 of 4
simultaneous same-name POSTs fail, 6 of 8 — so the retry is a survival mechanism,
not a fix.
