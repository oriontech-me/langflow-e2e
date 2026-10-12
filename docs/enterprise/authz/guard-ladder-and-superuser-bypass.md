# Enterprise — Three Refusals Are Three Guards, and What Superuser Bypass Actually Switches

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

Two questions the RBAC area left open, and they are one question asked from both ends.

**Are the three `403` messages three guards, or three spellings of one ladder?**
`rbac-instance-baseline` names them and defers them on purpose: `Permission denied`,
`RBAC administrator role required`, and `Superuser required to administer roles.`
(the last is now the refusal a **role-less** caller gets — see *What moved on 1.13*).
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
| `admin` role, global, bypass off | `201` | `200` | `201` (delegated administration, 1.13) |
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
- **Role administration** is satisfied by the superuser flag **or** the global `admin` role
  since the 1.13 line, which delegates user, team, role and assignment administration to
  that role (EE PR 332). The role-less subject is still refused, with the same message.

Each of the two non-superuser subjects is still refused somewhere the other is not — the
role-less one by all three, the global admin by the containment below — and the role-less
superuser still passes the admin guards while being refused by resource policy. That is what
keeps these independent gates rather than one ordering.

### What moved on 1.13, and where the containment went

On 1.12 the containment was "an admin cannot create a role". With role administration
delegated, it moved to the one privilege the delegation does not include: **becoming a
superuser**. Measured on `bbbec5fb`, a global `admin` subject:

| Call | Answer |
|---|---|
| `POST /authz/roles` | `201` — role administration is delegated |
| `PATCH /users/{self}` `{is_superuser: true}` | `403 Only a superuser may promote or demote platform superusers` |
| `POST /authz/check` | `403 Superuser required for authz admin endpoints` — the operator routes stay superuser-only |
| `POST /authz/role-assignments`, itself, `developer`, global | `409` scope conflict — it already holds `admin` at that scope, so this is the one-role-per-scope rule (langflow-ai/langflow#15426), not a guard, and it is no longer used as a containment probe |

So the load-bearing assertion is now the promotion refusal: an admin who could make itself a
superuser would hold every guard on the instance, which is the escalation the containment
exists to prevent.

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

## Note — whose project the probes write into

Tests 2 and 3 ask whether the **superuser** is subject to resource policy, so the project they
write into must be one where nothing *but* policy can answer. Two 1.13-era rules rule out the
obvious targets:

- **The owner override** (#1635): a project the superuser owns answers `201` whatever the
  bypass says.
- **Private Starter Projects** (EE PR 401, on the personal-project flag from langflow-ai/langflow#15404): another user's default project
  excludes global role wildcards, so even an un-stripped superuser holding `admin` is refused
  there — a `403` would not prove the role was what mattered.

So the target is a **non-personal project the shared subject owns** (`authz-foreign-scope`,
created while the subject briefly holds `developer`). Test 2 first asserts the control: the
un-stripped superuser creates a flow there (`201`), and only then strips its assignment and
expects `403`. Creating that project requires `LANGFLOW_ADD_PROJECTS_TO_MCP_SERVERS=false`,
the Editor configuration Enterprise documents; left at the OSS default, project creation also
registers an MCP stdio server, which 1.13 restricts to superusers, and no subject could own a
non-personal project at all.

## Note — the owner override (#1635)

Since the 2026-08-27 Enterprise build, `flow:create` is allowed by an **owner override** when
the destination project belongs to the caller, and a bare `POST /api/v1/flows/` canonicalises
to exactly that project. Any probe here that means "this subject is refused" therefore names a
destination the subject does **not** own, via `attemptFlowCreate(…, folderId)`.

The full reasoning, and the test that pins the override as a scoped rule rather than a hole,
live in `rbac-instance-baseline.md`.

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
2. Grant the subject `admin` at global scope. Re-probe: the resource call, the admin route
   and role administration are all allowed (`201` / `200` / `201`).
3. Assert the containment directly: the same subject asking to become a superuser
   (`PATCH /users/{self}` `{is_superuser: true}`) → `403 Only a superuser may promote or
   demote platform superusers`, and the operator route `POST /authz/check` → `403 Superuser
   required for authz admin endpoints`.
4. Delete anything created, then remove the assignment.

**Test 2 — with bypass off, the superuser is subject to resource policy.** Gates on
`superuser_bypass === false`.

1. Obtain the subject's non-personal project (see the note above).
2. Control: the superuser, still holding its bootstrap `admin` role, creates a flow there →
   `201`. Without this the `403` below could come from the project rather than the role.
3. Read the superuser's own global role assignments and remember them; delete them.
   `authz/status` reports `assignment_count` 0.
4. The identical `POST /flows/` now answers `403 Permission denied`, while the admin route
   answers `200` and role administration `201` — the two guards the flag satisfies.
5. Restore every assignment from a `finally`, and assert the restore landed before the test
   ends. This is the only test in the area that mutates the lane's own principal; leaving it
   role-less would break every spec that runs after it, so the restore is asserted rather
   than attempted.

**Test 3 — with bypass on, the superuser is exempt, and only the superuser.** Gates on
`superuser_bypass === true`, which skips on the enforcing container naming
`LANGFLOW_EE_BYPASS=1 ./scripts/start-langflow-enterprise.sh`.

1. Obtain the subject's non-personal project on this instance, as test 2 does. The 1.12
   version wrote into the superuser's own project, where the owner override answers `201`
   with or without the bypass — so its central assertion could not fail.
2. Strip the superuser's assignments exactly as test 2 does, and confirm `assignment_count` 0.
3. The same `POST /flows/` into the subject's project answers `201` — with no role granting
   it and no ownership, the only remaining source of that allow is the bypass.
4. A role-less peer on the **same** instance is still refused by all three guards, with the
   same three messages — so enforcement is live and the exemption is scoped to one principal.
5. Restore, as in test 2.

## Validation criterion *(required)*

Test 1 fails when two guards answer with the same message, when the global `admin` role can
promote itself to superuser or reach the superuser-only operator routes (self-escalation),
or when a role-less subject is allowed anywhere.

Test 2 fails when the control write does not succeed (the target cannot answer the
question), or when a superuser stripped of its role is still allowed to create a flow on an
instance whose `superuser_bypass` is `false` — the state the whole `authz/` directory gates
on would then be decorative. It also fails when the restore does not land.

Test 3 fails when the bypass instance denies the role-less superuser (the escape hatch does
not work) or when it allows the role-less peer (the flag is an enforcement off-switch, not a
superuser exemption).

## External dependencies *(required)*

- Tests 1 and 2: the Enterprise RBAC variant,
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, with `PLAYWRIGHT_BASE_URL`
  pointed at `http://localhost:7891`. The script sets the two variables the 1.13 line needs
  here: `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true` (user and role creation answer
  `503` without a licence) and `LANGFLOW_ADD_PROJECTS_TO_MCP_SERVERS=false` (see *whose
  project the probes write into*).
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
