# UPSTREAM BUG — Global Variables grid silently drops interactions while the RBAC permission query loads (dead window up to ~31 s)

- **Upstream ticket:** [LE-2123](https://datastax.jira.com/browse/LE-2123)
- **Introduced by:** [langflow#14215](https://github.com/langflow-ai/langflow/pull/14215) — "Complete release 1.12 RBAC authorization foundations", commit `2e677bf843` (2026-07-22, on `release-1.12.0`; **not** on langflow `main`)
- **Detected by:** daily-stable 2026-07-27 (`30261409427`) and 2026-08-03 (`30809091241`) → triage #1231 → issue #1235
- **Affected specs:** `ui-ux/global-variable-edit.spec.ts:76`, `core-functionality/llm-agents/remove-provider-api-key.spec.ts:17` (both quarantined by PR #1236)
- **Validated on:** Langflow 1.12.0 (nightly Docker image), 2026-08-04

## Behaviour

`GlobalVariablesPage` is wrapped in a `PermissionsProvider` that resolves per-variable
grants via `POST /api/v1/authz/me/permissions`. Every row interaction goes through
`canMutateVariable()` (`GlobalVariablesPage/variableAccess.ts`), which returns `false`
while that query is `isLoading`:

- a row click calls `onRowClicked`, which returns early — the click is **silently
  dropped**, the Update Variable modal never opens;
- `isRowSelectable` is `false`, so ticking the row checkbox selects nothing and the
  header `delete-row-button` never enables.

There is no UI affordance during the window — no spinner, no disabled styling, no
console output. The grid looks interactive and discards input.

The window is normally the request's natural latency (~1–2 s). But the shared query
wrapper (`request-processor.ts`) retries a failed request 5× with exponential backoff
(`min(1000·2^n, 30000)`), so one network error or 5xx on the *first* call holds
`isLoading` — and the dead window — for 1+2+4+8+16 ≈ **31 s**. After the ladder
exhausts, `canMutateVariable` fails open for the user's own variables, which is why
everything works ~32 s in. 4xx does not retry (`isClientError` aborts the ladder).

## Why it surfaced as a recurrent flake, not a hard failure

Both specs interact with the grid a few seconds after navigation. On a healthy backend
the gate is already open by then — most dailies pass. On a day the first permissions
call hits a transient failure (busy shard under collect-models load qualifies), the
window (~31 s) outlasts both specs' waits (10 s for the modal, 20 s for the click
retry loop), producing exactly the two recorded signatures:

- `expect(getByRole('heading', { name: 'Update Variable' })).toBeVisible()` fails —
  the click was dropped;
- `locator.click: Timeout 20000ms exceeded … element is not enabled` on
  `delete-row-button` — nothing ever got selected.

One mechanism, two affordances. Same-run shard split (1 and 4) is consistent: the
shared dimension is the surface, not the container.

## Evidence

1. **Deterministic repro (503 injection).** Intercepting
   `POST /api/v1/authz/me/permissions` and answering 503 produced retry attempts at
   `0.8 / 1.8 / 3.8 / 7.8 / 15.8 / 31.8 s` after page load — the backoff math to the
   decimal. During the whole window the row checkbox would not select and
   `delete-row-button` stayed `disabled`; after 31.8 s the grid behaved normally.
2. **A single transient failure suffices.** Failing only the first call (the retry
   succeeded at 2.3 s), a row click at 3.4 s was still swallowed; the modal opened
   only on the next attempt at 5.3 s.
3. **Gate isolation.** Inside the dead window a real DOM click does nothing, while
   invoking the page's own `onRowClicked` handler — read fresh from the live React
   tree, with the row's real `data` — opens the modal immediately. AG Grid fires
   `rowClicked` with correct data (verified via `api.addEventListener`), React commits
   normally elsewhere on the page (the "Add New" modal opens instantly), and the
   permissions endpoint answers 200 in ~1.1 s with full `read/write/delete` grants
   when not interfered with. The drop happens inside the handler's permission check
   and nowhere else.
4. **Version scoping.** langflow `main` does not carry the gate (the
   `PermissionsProvider` wrap of this page exists only on `release-1.12.0`); the
   behaviour is absent on builds without #14215.

## Re-validation note (for lifting the #1235 quarantine)

The only deterministic client-side observable that the gate is open is the row
becoming selectable (AG Grid `node.selectable` / a non-disabled
`.ag-checkbox-input`). The row-click path exposes no observable of its own but reads
the same context, so checkbox-enabled works as a readiness proxy for both specs if
they are hardened rather than only re-enabled.
