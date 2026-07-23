# Import Flow with Outdated Components — UI Upload Path (§12.4 Export / Import Flow)

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that when a user imports a flow **through the real UI upload button**
(`upload-project-button` → file chooser) and that flow contains components
pinned to an old snapshot, Langflow (a) accepts the import cleanly — an outdated
payload is still a valid, importable flow — and (b) surfaces the **outdated
notification** once the imported flow is opened on the canvas.

Concretely, uploading `tests/assets/flows/outdated_flow.json` (5 components
pinned to a 1.4.0-era snapshot) yields:

1. The **"uploaded successfully"** confirmation and a new flow card on the flows
   page — the outdated content does not break the import ingestion itself.
2. On opening the imported flow, the flow-level banner **"N components need
   updates"** and the toolbar bulk CTA (`update-all-button`, labeled **"Review
   All"** or **"Update All"**), exactly as the outdated diff is computed on open.

If this breaks, a user importing a real (older) exported flow via the upload
button would either see the import fail, or open a flow that silently drops its
outdated state — no update prompt, so the user never learns the components are
behind and cannot bring them current.

**Why this is distinct from existing coverage (dedup).** The outdated
notification itself, its per-node/banner count integrity, and the
breaking-change Review flow are already covered by
`core-components/outdated-component-notification.spec.ts` and
`core-components/component-breaking-change-alert.spec.ts` — but those import the
fixture **via the REST API** (deterministic setup, by design). The UI import
path is covered by `flow-functionality/export-import-flow.spec.ts`, but only
with a **current (non-outdated)** flow. No test drives **outdated content through
the actual UI upload path**; that intersection is this spec's coverage point and
the remaining §12.4 gap (`[~] Import flow with outdated components`).

---

## Tags *(required)*

`@release` `@workspace` `@regression`

Cross-cutting: `@release` (import is a happy-path flow), `@workspace` (flow
management), `@regression` (guards the outdated-on-import behavior). Functional:
covered by `@workspace` (Export/Import Flow, §12.4). Not `@stable` on
introduction — promotion follows team validation per `CONTRIBUTING.md`.

---

## Step by step *(required)*

Shared setup: bootstrap the app (`awaitBootstrapTest(page, { skipModal: true })`)
and wait for `mainpage_title`. The flow this test creates is captured from its
`POST /api/v1/flows` response and deleted id-scoped in `afterEach`
(repo convention #490/#681 — never a global `cleanAllFlows`).

1. Wait for `upload-project-button` to be visible on the flows page.
2. Arm a `filechooser` capture, click `upload-project-button`, and feed
   `tests/assets/flows/outdated_flow.json` (single-flow shape — has `data.nodes`,
   no `flows[]` bundle — so it goes through the single-flow `uploadFlow` path).
3. Capture the created flow's id from the `POST /api/v1/flows` response
   (the UI upload mints a **fresh** id — verified live it does not reuse the
   fixture's frozen `03bae731…`, so parallel uploads never collide on id).
4. Assert the **"uploaded successfully"** message is visible — the outdated
   payload was ingested without error.
5. Open the imported flow deterministically by navigating to `/flow/<capturedId>`
   (opening by captured id, not by the "Memory Chatbot" card, keeps the assertion
   parallel-safe — the fixture's name is frozen, so multiple runs produce
   same-named cards).
6. Assert the flow-level outdated banner **"N components need updates"**
   (count-agnostic regex) is visible.
7. Assert the bulk CTA `update-all-button` is visible and reads **"Review All"**
   or **"Update All"** (either — the breaking-vs-not distinction is the sibling
   breaking-change spec's concern).

---

## Validation criterion *(required)*

After importing `outdated_flow.json` via the `upload-project-button` file chooser
and opening the imported flow by its captured id:

- The **"uploaded successfully"** message appears (import accepted), AND
- The flow-level banner matching `/\d+ components? needs? updates?/i` is visible,
  AND
- `update-all-button` is visible and matches `/Review All|Update All/`.

Each assertion targets a single distinctive observable — no fuzzy OR-chain, no
`.catch(() => false)` swallow, no "app didn't crash" tautology. Mutating the
import (e.g. skipping the upload, or uploading a current flow with no outdated
components) makes the banner assertion fail deterministically; removing the
success assertion would let a rejected import pass silently.

The count is asserted **count-agnostic** on purpose: the fixture's outdated total
(5 on 1.12.0.dev3) is emergent from diffing its 1.4.0 snapshot against the
running nightly and shifts as components evolve — pinning a literal would re-break
on a benign version bump. The exact count and its per-node integrity are the
sibling `outdated-component-notification.spec.ts`'s concern, not this spec's.

---

## External dependencies *(required)*

- `data-testid="upload-project-button"` — the flows-page "Upload a flow" button
  that opens the file chooser (single-flow upload path).
- `data-testid="update-all-button"` — the toolbar bulk update/review CTA that
  accompanies the outdated notification.
- `data-testid="mainpage_title"` — flows page loaded marker.
- `tests/assets/flows/outdated_flow.json` — shared frozen fixture (5 components on
  a 1.4.0-era snapshot). Same fixture used by
  `outdated-component-notification.spec.ts`.
- No API key or provider required — the flow is never executed; only imported and
  opened, and the outdated diff is a client-side computation on open.

---

## What this test does not cover *(optional)*

- The outdated-notification count integrity (banner total == per-node indicators)
  — covered by `core-components/outdated-component-notification.spec.ts`.
- The breaking-change Review flow (Review action, disconnection warning, backup)
  — covered by `core-components/component-breaking-change-alert.spec.ts`.
- Actually applying the update (Update / Review All click and its result) —
  covered by `core-components/update-component-action.spec.ts`.
- The drag-and-drop import mechanism (`cards-wrapper` drop zone) — covered by
  `flow-functionality/export-import-flow.spec.ts` and `import-invalid-json.spec.ts`.
- Importing via the REST API (the deterministic setup the sibling specs use).

---

## Notes *(optional)*

- **Observables verified live on 1.12.0.dev3** via `playwright-cli`: uploading
  `outdated_flow.json` through `upload-project-button` left the app on `/flows`
  with a new "Memory Chatbot" card (fresh id `c37ad69d…`, not the fixture's
  frozen id); opening it showed "5 components need updates" + a "Review All"
  button, with per-node `review-button` indicators present.
- **Upload does not auto-open the flow** — the button adds the card and stays on
  the flows page. The imported flow must be opened explicitly (here by captured
  id) for the outdated diff to compute and the banner to render.
- **Flow cleanup.** The imported flow is a real persisted flow — its id is
  captured from the `POST /api/v1/flows` response and deleted id-scoped in
  `afterEach` (#490/#681), so no "Memory Chatbot" orphan leaks across runs.
