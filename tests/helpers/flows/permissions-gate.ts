// The one budget for the effective-permissions gate (issue #1222).
//
// WHAT THE GATE IS
//
// Upstream renders the flow header as
//
//   <Button data-testid="menu_bar_display" disabled={isReadOnly}>
//
// with `useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId,"write"))`
// (`contexts/permissionsContext.tsx`), so the button is disabled for the whole
// time `POST /api/v1/authz/me/permissions` is in flight — deliberately, per its
// own docstring, so a denied user cannot briefly mutate the in-memory canvas.
// `useAddComponent` bails out silently under the same expression. That makes the
// button's enabled state an exact observable for "a mutation issued now will
// register", and it is why five different places in the suite wait on it.
//
// WHY IT IS ONE CONSTANT
//
// Because it was five. `open-flow-by-id.ts` (#1214) waited 30 s,
// `open-flow-settings.ts` (#1215) 15 s, and `setup-playground.ts`,
// `api-request-component-regression.spec.ts` and `output-modal-copy-button.spec.ts`
// each carried their own inline 30 s. Two of those landed in parallel PRs, which
// is exactly the divergence #1108 describes: a fix to one copy reaches none of
// the others. Neither number was measured — 15 s came from `rename-flow.ts`'s
// `MODAL_TIMEOUT`, sized in #357 for the flow-settings modal's INPUTS, and 30 s
// was argued in #1214 as "shorter than the canvas budget", which fixes a relation
// and not a value.
//
// THE MEASUREMENT
//
// Measured 2026-09-05 against Langflow **1.12.0**, 6 parallel lanes × 8 flow
// opens = 48 samples, on a developer machine sharing one backend — the saturated
// local burst #1222 asks for. Two quantities, because they are not the same one:
//
//   POST /api/v1/authz/me/permissions   min 205 ms   p50 808 ms   p95 2623 ms   max 3770 ms
//   the gate (canvas visible → enabled) min   2 ms   p50  14 ms   p95 1919 ms   max 2939 ms
//
// The gate is usually already satisfied when it is reached — p50 14 ms — because
// the canvas render outlasts the query. The tail is what the budget is for, and
// under saturation it is seconds, not tens of seconds.
//
// WHY 30 s AND NOT 15 s, GIVEN BOTH CLEAR THE MEASUREMENT
//
// Both are safe on this evidence (15 s is ~5× the observed max gate wait, 30 s is
// ~10×). Three things break the tie, and none of them is "bigger is better":
//
//  1. **Blast radius.** Four of the five call sites already wait 30 s. Converging
//     up changes the failure latency of ONE site; converging down changes four,
//     on a burst measured on one machine.
//  2. **The measurement is a floor, not a ceiling.** A GitHub runner is slower
//     than this box and the daily shards it further. ~10× the observed max is the
//     headroom that covers the gap between the machine that was measured and the
//     machine that runs; shrinking it wants a measurement FROM the daily, which
//     the repo does not record today.
//  3. **The costs are asymmetric.** Too short turns a slow round-trip into a red
//     on a green product. Too long only lengthens a run that is already failing —
//     and it stays bounded: in `openFlowById` this gate is serial with the canvas
//     budget, so a dead entry spends at most 100 s + 30 s = 130 s, comfortably
//     inside the suite's 5-minute per-test timeout, so the failure still lands on
//     this assertion with its own message rather than as an unattributed
//     test-level timeout.
//
// WHAT THIS IS NOT
//
// It is NOT `rename-flow.ts`'s `MODAL_TIMEOUT`, and the two are now deliberately
// different numbers. `MODAL_TIMEOUT` budgets the flow-settings modal's inputs
// (#357); the permissions gate left `renameFlow` when #1215 moved the header
// click into `openFlowSettings`, so the 15 s they used to share was a coincidence
// of provenance, not a shared requirement. See the note at `MODAL_TIMEOUT`.
//
// It is also NOT the "editor mounted" wait. `openFlowSettings` still asserts
// `flow_name` is visible first, on its own budget: a header that is absent means
// the caller never landed on the canvas, which is a different failure and sends
// the reader somewhere else.
//
// A leaf module rather than a constant re-exported from either helper: importing
// one entry point from the other would couple them in
// `impacted-specs-by-import.mjs`'s transitive graph, so every spec using
// `openFlowById` would be selected on every edit to `openFlowSettings` and vice
// versa (#1054). This module imports nothing.

/**
 * How long the flow header may stay disabled before the wait is called broken.
 *
 * The full argument, and the measurement behind the number, are at the top of
 * this file. Changing it changes five call sites at once — that is the point —
 * so change it with a measurement, not with an argument.
 */
export const PERMISSIONS_GATE_TIMEOUT_MS = 30000;
