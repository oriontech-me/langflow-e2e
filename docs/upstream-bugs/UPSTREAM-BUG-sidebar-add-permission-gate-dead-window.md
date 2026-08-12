# UPSTREAM BUG — the flow editor silently discards Add Component clicks while the RBAC permission query is in flight (dead window up to ~31 s)

| | |
|---|---|
| **Filed upstream** | **LE-2176** — https://datastax.jira.com/browse/LE-2176 |
| **Sibling ticket** | **LE-2123** — same permission gate, different consumer (Global Variables grid). See `UPSTREAM-BUG-global-variables-permission-gate-dead-window.md` |
| **Tracked in** | `oriontech-me/langflow-e2e#1301` (from daily triage `#1296`), repaired suite-side by PR `#1427`. Earlier surfaces of the same class: `#1304`, `#1335`; still-quarantined caller: `#1365` |
| **Component** | Langflow — frontend, flow editor / RBAC permissions |
| **Surfaces** | `sidebar-custom-component-button`; `add-component-button-<x>` (Components and MCP tabs); drag-and-drop onto the canvas pane |
| **Observed on** | `langflowai/langflow-nightly:latest` — `1.12.0.dev23`; the same class was measured on `dev17`, `dev18` and `dev19` |
| **Affects** | `release-1.12.0` **and** `main` (unlike LE-2123, whose gate is release-line only) |
| **First affected** | 2026-07-15, PR [langflow#14068](https://github.com/langflow-ai/langflow/pull/14068), commit `887f2a552d` — *"fix(authz): close RBAC enforcement and permission UX gaps"* |
| **Last known good** | any build before 2026-07-15 |
| **Determinism** | **Deterministic when the click lands inside the window** (10/10 across two arms, below). In the field it presents as a flake because the window is normally short |
| **Captured** | 2026-08-11, local Docker instance, `LANGFLOW_AUTO_LOGIN=true`, `LANGFLOW_WORKERS=1`, single worker, no parallel load |
| **Environment** | Chromium (Playwright, arm64 macOS) |

---

## 1. Summary

Every component add in the flow editor is gated on `useIsFlowReadOnly`, which **fails
closed while the permissions query is still resolving**. During that window the add
control is rendered, enabled and hit-testable; the user clicks; the action is discarded
with no toast, no cursor change, no console output and **no network call at all**. The
node simply never appears.

The gate itself is a deliberate security decision and is not the report. The defect is
that **the affordance is not gated**: #14068's own commit message says *"close remaining
read-only mutation paths"* — the mutation path was closed, the control that invokes it
was not.

## 2. Mechanism

Source reading was performed against `langflow-ai/langflow` @ `e62f3ee400` on
`release-1.12.0`; the four load-bearing files are byte-identical at that branch's tip
`a0a9a08305`, and the same code is on `main`. The runtime measurements in §3 are ours.

1. `src/frontend/src/hooks/use-add-component.ts:18,26` — `if (isReadOnly) return;`
   precedes `paste()`, the store write, and even the `track("Component Added")` call.
   A bare early return.
2. `src/frontend/src/contexts/permissionsContext.tsx:62-65` —
   `useIsFlowReadOnly` returns `Boolean(flowId) && (isLoading || !can(flowId, "write"))`.
   Its own doc comment states the intent: permission queries fail open on errors and
   when no provider is mounted, but *"while an active provider is still resolving …
   flow editors fail closed so a denied user cannot briefly mutate the in-memory
   canvas."*
3. `src/frontend/src/pages/DashboardWrapperPage/index.tsx:12-14` — a live
   `PermissionsProvider` wraps the flow editor, keyed on the flow id, so this is not the
   fail-open default. `FlowPage` renders inside its `<Outlet/>` (`routes.tsx:176-178`).
4. `.../queries/permissions/use-get-effective-permissions.ts:67` — the query is
   `enabled: cappedIds.length > 0`, so it starts firing the moment `currentFlow.id`
   lands — i.e. at canvas mount.

The instant the canvas mounts, `Boolean(flowId)` flips true **and** the query starts.
For the whole duration of `POST /api/v1/authz/me/permissions`, `isReadOnly === true`,
therefore every add returns silently. Nothing wires `isReadOnly` to the buttons'
`disabled` prop — `sidebarFooterButtons.tsx:42,61` gate on the *canvas* `isLoading`,
not on permissions.

All three add surfaces go through the same hook, which is why they fail as one:

| Surface | Call site |
|---|---|
| Sidebar footer "New Custom Component" | `flowSidebarComponent/index.tsx:217` → `sidebarFooterButtons.tsx:86-90` |
| Components / MCP tab `add-component-button-<x>` | `flowSidebarComponent/components/sidebarDraggableComponent.tsx:67` |
| Drag onto the canvas pane | `FlowPage/components/PageComponent/index.tsx:690` |

## 3. Evidence

### 3.1 The drop tracks the window, not the first click

The confound worth designing against: the suite's own repair (PR #1427) works by
clicking a second time, and "the first add after a mount is always lost" predicts that
too. So both arms **delay the endpoint by 3 s** and click **exactly once**; only the
click's timing varies.

```js
await page.route("**/api/v1/authz/me/permissions", async (route) => {
  await new Promise((r) => setTimeout(r, 3000));
  await route.continue();
});
```

| Arm | in-flight at click | nodes added | runs |
|---|---|---|---|
| Click inside the window (~6.1 s) | 1 | **0** | 5 / 5 |
| Click after the window drained (~10.9 s) | 0 | **1** | 5 / 5 |

Perfect separation; Fisher one-tailed p ≈ 0.004. The same *first* click succeeds once
the query has resolved, which is what rules out the mount-order explanation. The click
never throws — the element is visible, enabled and hit-testable throughout.

### 3.2 The window is not bounded by one round-trip

The shared request wrapper retries a failed permissions call 5× with
`min(1000·2^n, 30000)` backoff — the same ladder documented for LE-2123. Answering the
endpoint with `503`:

```
attempts @ 1578, 1644, 2233, 3248, 5260, 9271, 17281, 33293 ms   (home provider)
attempts @ 34787, 34852, 35866, 37882, 41891, 49898, 65912 ms    (flow-editor provider)
add still discarded at every probe through 65541 ms; first node at 70604 ms
```

Deltas of 1 / 2 / 4 / 8 / 16 s, twice — each mounted provider runs its own ladder. So a
**single transient 5xx on the first call leaves the flow editor discarding adds for
~31–36 s**, after which the gate fails open and behaviour returns to normal. This is the
number that makes the window human-reachable rather than a render race.

### 3.3 Field rate, from the suite

Measured during #1301 on `1.12.0.dev23`, with the repair click suppressed: 9 of 10 first
clicks on `sidebar-custom-component-button` produced no node, and the canvas still held
zero at the end of a 40 s window — **nothing arrives late**. With a 12 s budget and the
repair restored, 14 of 16 first clicks were swallowed and 14 of 14 were repaired by an
identical second click. On `edit-name-description-node` run bare, 5 of 11.

### 3.4 Why our reproduction is the *cheapest* case

Auto-login with no RBAC configured makes the permissions query trivial. A deployment
with role assignments, shares and a project domain does more work per call.
`LANGFLOW_WORKERS=1` with several concurrent sessions is the default Docker deployment
with more than one user — not a synthetic shape.

## 4. Not this bug

- **`div-generic-node` never becoming clickable.** That was the recorded reading at
  triage #1296 and it is refuted: across 26 instrumented attempts, 0 had a node present
  that would not take a click. When the node exists it renders in 3–7 ms and the click
  lands in 16–89 ms. There was no node to click because the **add** was swallowed.
- **`POST /api/v1/flows/` → 500.** Appeared in 2 of the 10 runs in §3.1; that is the
  ambient concurrent-flow-create defect (`UPSTREAM-BUG-concurrent-flow-create-500.md`),
  unrelated to this gate.

## 5. Blast radius

`useIsFlowReadOnly` has 12 consumers on this ref: `GenericNode` and its output field,
status and handle renderers, `NoteNode`, `custom-parameter`, `FlowMenu`,
`flowSettingsComponent`, the assistant panel, `PageComponent`, and `useAddComponent`.
They were **not** audited here, and most are probably fine — rendering a control
disabled is visible and therefore acceptable behaviour. The point is only that they
share the same transient window, and that `useAddComponent` is the one that **accepts an
action and discards it**.

## 6. What was not verified

- **The other 11 consumers** (§5).
- **`langflow#14329`** (a sidebar decomposition) was flagged as a possible cause during
  earlier scouting and never read. Given §2 and the `git log -S'isReadOnly'` result it is
  almost certainly a red herring, but it is not closed.
- **Backend cost of `/api/v1/authz/me/permissions` under concurrent sessions.** The
  latency argument in §3.4 is qualitative; a measurement would make it quantitative.

## 7. Suite impact and re-validation note

- The repair in `addCustomComponentFromSidebar` (PR #1427) re-issues the click once. It
  works because the window is bounded by the permissions response. What
  `swallowedAddMessage()` prints per surface is a **rate and an issue number** — 9/10 and
  14/14 on dev23 for the dedicated button, 4/20 on dev17 for the Components tab, 1/5 on
  dev18 for the drag — and none of the three names a **cause**. All three can now add
  one: *the flow is transiently read-only while `POST /api/v1/authz/me/permissions` is in
  flight — LE-2176*.
- **The repair can double-add.** If a first add was merely *slow* rather than dropped,
  the second gesture leaves two nodes. Any caller asserting an exact node count should be
  checked.
- **The deterministic readiness signal is the permissions response**, not any DOM state:
  the button is enabled the whole time and exposes no observable of its own. A spec that
  wants to be immune without a repair click should wait for
  `POST /api/v1/authz/me/permissions` to resolve before the first add.
- **If the upstream fix lands**, the repair becomes dead code that still spends its
  12 s budget on a genuine future regression.

## 8. Reproducers

`scripts/repro-permission-gate-add.spec.ts` (§3.1, two arms) and
`scripts/repro-permission-gate-ladder.spec.ts` (§3.2, 503 ladder). Both are written for
`tests/tests-automations/regression/core-components/` and must be copied there to run —
they are kept out of `tests/` so the suite never collects them.

```bash
cp docs/upstream-bugs/scripts/repro-permission-gate-*.spec.ts \
   tests/tests-automations/regression/core-components/

npx playwright test tests/tests-automations/regression/core-components/repro-permission-gate-add.spec.ts \
  --workers=1 --retries=0 --repeat-each=5 --reporter=line

# needs --reporter=list: the line reporter's redraw eats the per-probe log
npx playwright test tests/tests-automations/regression/core-components/repro-permission-gate-ladder.spec.ts \
  --workers=1 --retries=0 --reporter=list

rm tests/tests-automations/regression/core-components/repro-permission-gate-*.spec.ts
```

Expected: 10 passed on the first (5 arms with `added=0` and `inFlightAtClick=1`, 5 with
`added=1` and `inFlightAtClick=0`); 1 passed on the second, printing the ladder.
