# Enterprise — Operator Surfaces: Scoped Reconcile, Audit Filters, SIEM Status, Directory Sync

**Last validated:** 1.12.0 — Langflow Enterprise (image `langflow-enterprise:latest`, built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`policy-reconcile-and-repair` covered the instance-wide reconcile. Three operator surfaces
beside it are referenced by no spec, and each one is something an administrator makes a
decision from.

**Scoped reconcile.** `POST /authz/policy/reconcile/entities` narrows a reconcile to named
entities. It works — and only when `entity_key` is the **casbin** key: `role:viewer` answers
`200` with `trigger: "operator:targeted"`, `scope: "entities"`. Anything else is a key the
operator got wrong, and the natural wrong keys are the ones this surface hands out: a role's
UUID from `GET /authz/roles`, or its bare name. Those — and any key matching nothing — answer
`422` with a `detail` that echoes the key and names the casbin format (`role:<name>`), which
is the only thing that tells the operator the identifier they hold is the wrong one.

That is the **corrected** behaviour. On the 2026-08-18 build all of them answered **`500`**
with a `message` envelope rather than `detail` — an unhandled exception, while `entity_type`
beside it was validated (`bogus` → `422` naming the enum). #1555 recorded it and this spec
carried the test as expected red; it is fixed on the 2026-08-27 build, and the test is now an
ordinary regression guard. It asserts the class (`4xx`) rather than `422` exactly, because the
issue asked for "`404` or `422`" and choosing between them is not this repo's call; what it
does pin is that a wrong key is never a `2xx` — a scoped reconcile of *nothing* reporting
`outcome: "clean"` would be the silent version of the same defect.

**Audit filters.** `GET /authz/audit` accepts eleven query parameters and nothing asserts
that any of them filters. Measured, `result=deny` and `action=flow:create` do. An **invalid**
value answers `200` with an empty envelope, byte-identical in shape to "nothing matched"
(#1555, filed upstream as `LE-2772`) — an auditor asking "were there denials?" with a mistyped filter gets a clean bill of
health. This spec asserts the **positive** side only: that a valid filter returns rows and
that they all match it. The `422`-versus-empty question is a product choice, and pinning
today's answer as correct would be this repo deciding it by assertion.

**SIEM status.** `GET /authz/siem/status` describes audit export. On an instance with no
adapter it must be **coherently disabled** rather than half-configured, and it is behind the
**superuser** guard while `audit` itself is behind the admin-role guard.

**Directory sync.** `POST /authz/directory/memberships/reconcile` ingests an external
membership snapshot. Its guard is the age of the snapshot: a fresh `observed_at` is accepted
with a report (`snapshot_age_seconds`, `authoritative`, `propagation`), and `2020-01-01` is
refused `409 directory membership snapshot is stale`. It is admin-gated — and validated
**before** authorization, so a role-less caller sending `{}` gets the schema back as `422`
rather than a refusal, which is why the permission assertion uses a **valid** body.

### Measured

| Call | Answer |
|---|---|
| `reconcile/entities` `[{role, "role:viewer"}]` | `200`, `trigger: "operator:targeted"`, `scope: "entities"` |
| `reconcile/entities` `[{role, <uuid>}]` / bare name / unknown key | `422` `{"detail": "No role policy entity matches entity_key '<key>'. Entity keys … carry the Casbin subject prefix (a role is ``role:<name>``, not ``<name>``) …"}` — **`500`** `{"message": …}` on the 2026-08-18 build (#1555) |
| `reconcile/entities` `[{assignment, <assignment id>}]` | `422`, same `detail` naming `assignment` |
| `reconcile/entities` `[{bogus, x}]` | `422`, `Input should be 'role', 'assignment', 'team' or 'share'` |
| `reconcile/entities` as the subject | `403 Superuser required for authz admin endpoints` |
| `audit?result=deny` | `200`, rows whose `result` is `deny` |
| `audit?result=banana` / `?actor_type=bogus` / `?action=nonexistent:action` | `200`, `{"items": [], "total": 0}` — unchanged on the 2026-08-27 build (`LE-2772`) |
| `audit?since=not-a-date` | `422` naming the datetime parse error — the one typed filter |
| `audit` as the subject | `403 RBAC administrator role required` |
| `siem/status` as superuser | `200`, `enabled: false`, `active: false`, `adapter_configured: false`, `capture_ready: false`, `bootstrap_state: "disabled"`, `event_schema: "langflow.authz.audit.v1"` |
| `siem/status` as the subject | `403 Superuser required for authz admin endpoints` |
| `directory/memberships/reconcile`, fresh `observed_at`, `users: []` | `200`, `snapshot_age_seconds` under a second, `propagation: "unchanged"` |
| the same with `observed_at: 2020-01-01` | `409 directory membership snapshot is stale` |
| the same, valid body, as the subject | `403 RBAC administrator role required` |

## Note — the owner override (#1635)

Since the 2026-08-27 Enterprise build, `flow:create` is allowed by an **owner override** when
the destination project belongs to the caller, and a bare `POST /api/v1/flows/` canonicalises
to exactly that project. Any probe here that means "this subject is refused" therefore names a
destination the subject does **not** own, via `attemptFlowCreate(…, folderId)`.

The full reasoning, and the test that pins the override as a scoped rule rather than a hole,
live in `rbac-instance-baseline.md`.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

Gates on an enforcing instance and uses the directory's shared subject.

**Test 1 — scoped reconcile, keyed correctly.** `role:viewer` → `200`, and the verdict says
it was targeted (`scope: "entities"`, `trigger: "operator:targeted"`) rather than an
instance-wide pass. `entity_type: "bogus"` → `422`. As the subject → `403` with the superuser
message.

**Test 2 — a mis-keyed or unknown entity is a client error that names the key format.**
Three targets, each one an operator can plausibly send: the `viewer` role's UUID as
`GET /authz/roles` reports it, the bare name `viewer`, and a casbin-shaped key that matches
nothing. Each answers `4xx` — not `5xx` (#1555's defect) and not `2xx` (a reconcile of nothing
reported as clean). The body is a `detail` string, not the generic `message` envelope, and it
echoes the key that was sent. For the two mis-keyed forms the `detail` also names the casbin
prefix `role:` — for those keys it can only come from the format hint, which is the
observable that separates "you used the wrong identifier" from a bare refusal.

**Test 3 — the audit filters filter.** `result=deny` returns rows and **every** row's
`result` is `deny`; `action=<a real action>` likewise. The action asserted is one the run
itself produced, so the test does not depend on the container's history.

**Test 4 — SIEM status is coherently disabled, and superuser-only.** With no adapter,
`enabled`, `active`, `adapter_configured` and `capture_ready` are all `false` **together** —
a half-configured state (`enabled` true while `adapter_configured` false) is the one an
operator would read as "exporting". The subject gets the superuser refusal, while `audit`
gives the admin-role one: the two are asserted side by side, because that difference is the
thing a client has to distinguish.

**Test 5 — the directory snapshot's age is the guard.** Fresh → `200` and the report's
`snapshot_age_seconds` is small; `2020-01-01` → `409`, message asserted. With a valid body,
the subject → `403 RBAC administrator role required`.

## Validation criterion *(required)*

Fails when a correctly-keyed scoped reconcile stops reporting itself as targeted, when a
mis-keyed or unknown target stops being a client error that names the key (a `500` again, a
`2xx`, or a refusal that no longer says which key or which format), when a filter stops
filtering, when SIEM status reports a half-configured export, when the two guards collapse
onto one message, or when a stale snapshot is accepted.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  `PLAYWRIGHT_BASE_URL` at `http://localhost:7891`.
- Zero or one login per run — shared subject plus cached superuser token.
- No SIEM adapter and no identity provider: both surfaces are asserted in their unconfigured
  state, which is the state a test environment can guarantee.
- No LLM provider, no network egress.

## Notes

The directory snapshot is submitted with `users: []`. A snapshot carrying real memberships
would mutate them on a shared instance, and the guard under test is the snapshot's age rather
than what it contains. For the same reason nothing here asserts anything about **replaying**
a snapshot: measured, an identical fresh snapshot is accepted twice, but establishing whether
that is a replay hazard would require submitting real memberships.

`provider_id` is generated per run, so two runs never argue over one provider's snapshot
history.
