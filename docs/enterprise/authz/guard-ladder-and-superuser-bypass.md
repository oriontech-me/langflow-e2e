# Enterprise — Three Refusals Are Three Guards, and What Superuser Bypass Actually Switches

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

Two questions the RBAC area left open, and they are one question asked from both ends.

**Are the three `403` messages three guards, or three spellings of one ladder?**
`rbac-instance-baseline` names them and defers them on purpose: `Permission denied`,
`RBAC administrator role required`, and `Superuser required to administer roles.`
If they were one ladder, a single "privilege" scalar would order every subject and the
three messages would be cosmetic. They are not: each guard reads a *different* predicate,
and no subject satisfies them in a nested order.

**What does `LANGFLOW_AUTHZ_SUPERUSER_BYPASS` switch?** The whole `authz/` directory gates
on it being `false`, on the argument that with it `true` the only account this lane has is
exempt and a deny matrix would pass against an instance that never denied anything. That
argument has never been measured. It is asserted here, on a third container variant, and
it turns out to be *narrower and more useful* than the gate's own wording: bypass changes
exactly one cell of the matrix.

### The matrix, measured

Three routes, one per guard. Subjects are principals, not privilege levels.

| Subject | `POST /flows/` (resource policy) | `GET /authz/admin/users` (admin route) | `POST /authz/roles` (role administration) |
|---|---|---|---|
| no role, bypass off | `403` `Permission denied` | `403` `RBAC administrator role required` | `403` `Superuser required to administer roles.` |
| `admin` role, global, bypass off | `201` | `200` | `403` `Superuser required to administer roles.` |
| superuser with **no** assignment, bypass off | `403` `Permission denied` | `200` | `201` |
| superuser with **no** assignment, bypass **on** | `201` | `200` | `201` |
| no role, bypass **on** | `403` `Permission denied` | `403` `RBAC administrator role required` | `403` `Superuser required to administer roles.` |

Read the third and fourth rows against the second. **The ladder is not monotone**, and that
is the finding worth pinning:

- The **resource policy** guard reads casbin policy alone. A superuser stripped of its role
  assignment is refused a flow it could create a second earlier — the superuser flag does
  not enter this decision at all when bypass is off.
- The **admin route** guard is satisfied by the `admin` role **or** by the superuser flag.
  The role-less superuser passes it while being refused by the guard "below" it.
- **Role administration** is satisfied by the superuser flag **only**. A holder of the
  global `admin` role passes the two guards beneath it and is refused here — so an admin
  cannot grant themselves anything, which is the containment that makes the `admin` role
  safe to hand out. (`POST /authz/role-assignments` refuses with its own wording,
  `Superuser required to administer role assignments.`, so the message names the route
  rather than the guard.)

Each of the two non-superuser subjects passes a guard the other fails. That is what makes
these three independent gates rather than one ordering, and it is unassertable from a
single subject — which is why the previous specs, each built around one subject, could
name the three messages but not separate them.

### What bypass switches

Exactly one cell: the superuser's **resource policy** answer. `403 Permission denied`
becomes `201`. The other two guards were already satisfied by the flag, and every
non-superuser answer on the same instance is unchanged — a role-less peer is still refused
by all three, with the same three messages.

So bypass is neither an authorization off-switch nor a no-op. It is a documented escape
hatch scoped to one principal and one guard: *the superuser stops being subject to
resource policy.* An operator locked out by their own policy can turn it on and recover
without touching the policy; a lane that gates on `false` is asserting that its superuser
is subject to policy like anybody else. Both halves are asserted here, each against the
container that can answer it — and each skipping, named, on the container that cannot.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

**Test 1 — the three guards.** Gates on an enforcing instance (`authz_enabled` true,
`superuser_bypass` false). Uses the directory's shared subject, so it costs no login of
its own.

1. Reset the subject's grants. Probe the three routes → three `403`s, and assert the three
   `detail` strings are **pairwise different**, not merely non-empty.
2. Grant the subject `admin` at global scope. Re-probe: the resource call is now allowed,
   the admin route answers, and role administration is **still** refused with the same
   message as in step 1.
3. Assert the containment directly: the subject that may now read the admin surface still
   cannot create a role or an assignment.
4. Delete anything created, then remove the assignment.

**Test 2 — with bypass off, the superuser is subject to resource policy.** Gates on
`superuser_bypass === false`.

1. Read the superuser's own global role assignments and remember them.
2. Delete them. `authz/status` reports `assignment_count` 0.
3. The identical `POST /flows/` now answers `403 Permission denied`, while the admin route
   answers `200` and role administration `201` — the two guards the flag satisfies.
4. Restore every assignment from a `finally`, and assert the restore landed before the test
   ends. This is the only test in the area that mutates the lane's own principal; leaving it
   role-less would break every spec that runs after it, so the restore is asserted rather
   than attempted.

**Test 3 — with bypass on, the superuser is exempt, and only the superuser.** Gates on
`superuser_bypass === true`, which skips on the enforcing container naming
`LANGFLOW_EE_BYPASS=1 ./scripts/start-langflow-enterprise.sh`.

1. Strip the superuser's assignments exactly as test 2 does, and confirm `assignment_count` 0.
2. The same `POST /flows/` answers `201` — with no role granting it, the only remaining
   source of that allow is the bypass.
3. A role-less peer on the **same** instance is still refused by all three guards, with the
   same three messages — so enforcement is live and the exemption is scoped to one principal.
4. Restore, as in test 2.

## Validation criterion *(required)*

Test 1 fails when two guards answer with the same message, when the `admin` role stops
being refused by role administration (self-escalation), or when a role-less subject is
allowed anywhere.

Test 2 fails when a superuser stripped of its role is still allowed to create a flow on an
instance whose `superuser_bypass` is `false` — the state the whole `authz/` directory gates
on would then be decorative. It also fails when the restore does not land.

Test 3 fails when the bypass instance denies the role-less superuser (the escape hatch does
not work) or when it allows the role-less peer (the flag is an enforcement off-switch, not a
superuser exemption).

## External dependencies *(required)*

- Tests 1 and 2: the Enterprise RBAC variant,
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, with `PLAYWRIGHT_BASE_URL`
  pointed at `http://localhost:7891`.
- Test 3: the bypass variant, `LANGFLOW_EE_BYPASS=1 ./scripts/start-langflow-enterprise.sh`
  — a third container, its own Postgres, on `http://localhost:7892`. It is a **separate
  run**: no lane can satisfy both gates at once, which is why the two halves skip rather
  than fail on the wrong instance.
- **Zero or one** login per run. Tests 1 and 2 reuse the directory's shared subject and the
  cached superuser token; test 3 mints one peer on its own instance, whose per-IP login
  budget is that container's own.
- **One Enterprise container at a time on a 8 GB Docker VM.** Starting the bypass variant
  beside the RBAC one had the kernel `SIGKILL` the RBAC container (`exited (137)`) with ten
  containers running. The start script says so; the two halves of this spec are separate
  runs anyway.
- No LLM provider and no network egress.

## Notes

Tests 2 and 3 do the same mutation and differ only in the expected answer, which is the
point: they are one A/B whose two halves cannot share a process. Written as one
parameterised test they would have needed a way to reach two base URLs from one run; written
as two gated tests, each names the container it needs and the pair reads as the comparison
it is.

`GET /api/v1/authz/roles` answered `503` once while measuring, and `200` on every attempt
after. Not reproduced and not asserted here; recorded because a transient `503` on the role
catalogue would surface as an unrelated failure in whatever step happened to read it.

Measured while writing this, and it corrects a note in the area's own history: the RBAC
bootstrap assigns the superuser `admin` at global scope **even with
`LANGFLOW_RBAC_BOOTSTRAP_ENABLED` unset** — the bypass container comes up with
`assignment_count` 1 and no bootstrap variables set at all. So "no bootstrap flag means
nobody has a role" does not hold on this image, and the stripping in tests 2 and 3 is what
produces a genuinely role-less superuser.
