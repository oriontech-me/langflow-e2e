# Enterprise — Operator Surfaces: Scoped Reconcile, Audit Filters, SIEM Status, Directory Sync

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`policy-reconcile-and-repair` covered the instance-wide reconcile. Three operator surfaces
beside it are referenced by no spec, and each one is something an administrator makes a
decision from.

**Scoped reconcile.** `POST /authz/policy/reconcile/entities` narrows a reconcile to named
entities. It works — and only when `entity_key` is the **casbin** key: `role:viewer` answers
`200` with `trigger: "operator:targeted"`, `scope: "entities"`. A role's UUID, its bare name,
and a key matching nothing all answer **`500`** (#1555), with a `message` envelope rather
than the `detail` every other refusal on this surface uses — the signature of an unhandled
exception. `entity_type` itself *is* validated (`bogus` → `422` naming the enum), so the
endpoint validates what it can enumerate and throws on what it cannot.

**Audit filters.** `GET /authz/audit` accepts eleven query parameters and nothing asserts
that any of them filters. Measured, `result=deny` and `action=flow:create` do. An **invalid**
value answers `200` with an empty envelope, byte-identical in shape to "nothing matched"
(#1555) — an auditor asking "were there denials?" with a mistyped filter gets a clean bill of
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
| `reconcile/entities` `[{role, <uuid>}]` / bare name / unknown key | `500` `{"message": "Policy entity target did not match canonical or Casbin policy: role"}` |
| `reconcile/entities` `[{bogus, x}]` | `422`, `Input should be 'role', 'assignment', 'team' or 'share'` |
| `reconcile/entities` as the subject | `403 Superuser required for authz admin endpoints` |
| `audit?result=deny` | `200`, rows whose `result` is `deny` |
| `audit?result=banana` | `200`, `{"items": [], "total": 0}` |
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

**Test 2 (EXPECTED RED, #1555) — an unknown entity key is a client error.** A random UUID
answers `4xx`, not `500`. It answers `500` today.

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
filter stops filtering, when SIEM status reports a half-configured export, when the two
guards collapse onto one message, or when a stale snapshot is accepted. Test 2 fails today by
design and turns green when an unknown key stops being a `500`.

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
