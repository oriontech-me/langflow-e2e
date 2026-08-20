# Enterprise — Policy Reconciliation: an Honest Read, and an Idempotent Repair

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

RBAC is enforced from `casbin_rule` rows derived from roles, assignments, teams and shares.
Those two representations can drift, and Enterprise ships the operator surface for it:
`POST /api/v1/authz/policy/reconcile` (diff, optionally repair), `POST /authz/policy/sync`
(clear and rewrite), and a `revision` hash over the derived policy.

An operator acts on what these report, so what needs pinning is not that the endpoints exist
but that their **verdicts are trustworthy**:

- A **read must not write.** `reconcile` without repair reports a diff; if it silently
  repaired, an operator investigating drift would find it gone and conclude they imagined it.
- A **repair must say what it did**, and be **idempotent** — running it twice must not report
  a second round of changes, because an operator who cannot tell "already consistent" from
  "changed again" has to stop running it.
- The **revision must be deterministic**, or it cannot be used to detect drift at all: it has
  to move when policy changes and come back when the change is undone.
- The surface is **superuser-only**, and its refusal is a fourth distinct guard message
  alongside the three separated in #1531.

### Measured

| Call | Verdict |
|---|---|
| `POST /authz/policy/reconcile` (twice, unchanged instance) | identical verdict both times; `inserted_count` / `deleted_count` `0`; `outcome: "clean"` when consistent |
| `POST /authz/policy/reconcile?repair=true` with drift present | `outcome: "repaired"`, `repair: true`, `deleted_count: 1` |
| the same call again | `outcome: "clean"`, every delta `0` |
| `POST /authz/policy/sync` (twice) | identical `counts` — `{p: 64, g: 3, g2: 4}` on a quiet instance |
| grant a project-scoped role → reconcile | `expected_count` 72 → 104, `revision` moves, `outcome: "clean"` |
| revoke it → reconcile | `expected_count` back to 72, `revision` back to the **exact** baseline hash |
| any of them as a non-superuser | `403 Superuser required for authz admin endpoints` |

### Two traps, both of which produced a wrong conclusion first

**`repair` is a QUERY parameter.** `{"repair": true}` in the **body** is silently ignored:
the response echoes `repair: false`, both write counters stay `0`, and the same drift is
reported call after call. The first version of this measurement concluded the repair knob was
dead — it took `?repair=true` to see `outcome: "repaired"` and `deleted_count: 1`. A spec
that asked the wrong way would have "confirmed" a defect that does not exist.

**`expected_count` tracks resources, not only roles.** Creating a project raises it and
deleting one lowers it, so "the revision came back to baseline" is a valid assertion **only**
with the project and flow still in place. Compared across a create/delete of the resources
themselves, it compares two different policies and reads as non-determinism.

Related and deliberately **not** asserted: this instance was found in real drift
(`extra_count: 1`, `changed_count: 1`) and one `?repair=true` cleared it. What produced it
was not isolated — a role, project or assignment lifecycle somewhere in a long measuring
session — and a spec cannot assert a state it cannot induce. The repair half is asserted
against drift the spec **creates itself**, by taking the baseline, granting, and reconciling.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

Gates on an enforcing instance (`authz_enabled` true, `superuser_bypass` false).

**Test 1 — the read is a read, and it is repeatable.** Call `reconcile` twice with no repair.
Both verdicts carry the same `revision`, the same counts, and `inserted_count` /
`deleted_count` of `0`. Then `sync` twice and assert the two `counts` objects are identical.

**Test 2 — the revision is deterministic.** With a project and a flow in place: take the
baseline verdict, grant the subject a project-scoped `developer`, reconcile (the revision
moved, `expected_count` grew), revoke it, reconcile again — the revision is byte-identical to
the baseline and the count is back. The resource set is held constant throughout, for the
reason in the trap above.

**Test 3 — repair reports what it did, and is idempotent.** With `?repair=true`: the verdict
carries `repair: true`, and whatever it found is reflected in `outcome` — `repaired` with a
non-zero delta, or `clean` with zero deltas when there was nothing to fix. Immediately after,
a second `?repair=true` reports `clean` with every delta `0`. That pair is the idempotence
claim: a repair that keeps finding work on an unchanged instance is indistinguishable from one
that never worked.

**Test 4 — the surface is superuser-only.** `reconcile`, `sync` and `reconcile?repair=true`
each answer `403` to the shared subject, with `Superuser required for authz admin endpoints`
— asserted exactly, because it is a **different** guard from the three in
`guard-ladder-and-superuser-bypass` and a single reused message would collapse two distinct
gates for every client that reads them.

## Validation criterion *(required)*

Fails when a plain `reconcile` writes, when two consecutive reads of an unchanged instance
disagree, when the revision does not move for a real grant or does not return for its
revocation, when a repair does not report what it changed, when a second repair reports
further changes, or when a non-superuser reaches any of the three.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  `PLAYWRIGHT_BASE_URL` at `http://localhost:7891`.
- **Zero or one** login per run — the directory's shared subject plus the cached superuser
  token.
- No LLM provider, no network egress.

## Notes

Every count assertion is relative to a baseline the test takes itself. Absolute rule counts
are a property of the container (`policy_rule_count` was 68, 70, 71 and 72 across a single
afternoon as other specs created and removed roles and projects), so a spec pinning one would
measure how much state the instance carries rather than whether reconciliation works.

The grant used to move the revision is project-scoped on purpose: it writes 32 rules, which
is a change no rounding or ordering difference could produce, and it is the same grant shape
`inherited-access-and-deploy` uses — so the two specs fail for the same reason if the
assignment API itself breaks, rather than one of them failing for a subtler one.
