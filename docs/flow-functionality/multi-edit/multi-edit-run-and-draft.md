# Multi-edit safety — a run on a stale canvas, and unsaved work across a reload

**File:** `tests/tests-automations/regression/flow-functionality/multi-edit/multi-edit-run-and-draft.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev14`)

Owning issue: #2345 (Wave 11 — Multi-edit, instance migration & integrations; tracker #2356).
Upstream feature: multi-edit safety, `langflow-ai/langflow#14903`, follow-up `#15824`.
Related specs:
- `multi-edit-conflict-review.spec.ts` (#2342) pins how a conflict is raised, and that a run
  after a history round trip adopts the newer version.
- `multi-edit-conflict-exits.spec.ts` (#2343) and `multi-edit-field-conflict.spec.ts` (#2344)
  pin what the dialog's exits save.

This spec covers the two protections that act **outside** the dialog:
- a run that would execute a version nobody saved;
- unsaved work that a reload would otherwise lose.

---

## What this test validates *(required)*

**A run on a stale canvas.** Running is worse than a refused save: the result looks
current and is not. The editor therefore checks the version before it builds. When the
person has unsaved edits, the run stops and a conflict is raised. When they have none,
the canvas takes the newer version and the run stops so they can see what arrived. The
risk this spec guards against is a run request reaching the server with the graph nobody
saved.

**Unsaved work across a reload.** Between a refused save and the person's decision, the
only copy of their work is the tab. A conflict therefore writes a local draft, and a reload
offers it back. The draft must not become a second copy of the person's secrets: secret
fields are cleared before the draft is stored, and the offer says so.

Every row below was measured on `1.14.0.dev10` with a live scout before any assertion was
written, and measured again on `1.14.0.dev14`:

| Behaviour | Measured |
|---|---|
| **Run with an unsaved edit** (edit, then Run before the 5 s autosave) | The run reads `GET {id}/version-state`, then the flow. It raises the conflict: the banner *"A newer version of this flow is available"* appears. The viewer sends no `PATCH` and no `POST /api/v2/workflows`. |
| **Run while a conflict stands** | The notice *"This flow moved on while you were editing. Review the changes to run it."*. No request reaches `/api/v2/workflows`. |
| **Run with no edit** | `version-state`, then the flow is re-read and adopted. The notice reads *"langflow updated this flow. The canvas now shows the latest version — run again to execute it."*. The field shows the other session's value, and no `POST /api/v2/workflows` is sent. The **next** Run sends `POST /api/v2/workflows` → `200`, and the stored User message carries the other session's text. |
| **The draft** | Written to `localStorage` under `lf_draft_<userId>_<flowId>` as soon as the conflict is registered, whichever way it was found. |
| **Reload with a draft** | `restore-draft-banner`: *"Unsaved changes from {hh:mm AM/PM}"* / *"Restore your work to pick up where you stopped."*, buttons *Discard* and *Restore* (`restore-draft-button`). The conflict banner is not shown at the same time. The canvas shows the server's version. |
| **Restore** | The canvas gets the draft back without saving. The conflict is raised again (banner back), and the draft is **kept**, because the work is still at risk. No `PATCH` is sent. |
| **Discard** | The canvas keeps the server's version, the draft key is removed, nothing is written to the server, and a second reload offers nothing. |
| **A secret in the draft** (`SearchAPI` → `api_key`, typed `sk-e2e-…` with hyphens) | The stored draft holds `api_key.value = ""` and `secretsCleared: true`. The sentinel is in no `localStorage` value. The banner reads *"Restore your work — secret fields need to be entered again."*. After Restore, the key field is empty and the other edit is back. The server never received the key. |
| **Too large to keep** | With a 2.1 M-character value in the flow, the draft is over the 2 000 000-character limit and is not stored. The error *"This flow is too large to keep a local copy of your unsaved changes. Resolve the conflict before reloading, or they will be lost."* appears ~5 s after the **next** edit made while the conflict stands, not on the edit that raised it. |

### Facts that shape the design

- **Two routes to a blocked run.** The pre-run check raises the conflict itself when the
  autosave has not run yet. When a conflict already stands, the run is refused before any
  check. The first test exercises both, in that order.
- **"No run request" is asserted on `POST /api/v2/workflows`**, the request a playground or
  node run sends on 1.12+. The `GET /api/v2/workflows/pending` poll is not a run and is
  excluded.
- **The adopted run is proved to execute the new graph.** It is not enough that the canvas
  shows the new value: the second run's stored User message must carry it.
- **The draft is asserted under its exact key**, built from `whoami` and the flow id. That
  ties it to this flow and this user, not to a leftover from another worker.
- **Two secret shapes are covered.** A hyphenated key is scrubbed, and that is pinned. An
  alphanumeric key is not, and that is pinned as a known defect — see below.
- **The too-large threshold is reachable**, so it is covered rather than recorded as a gap.
  The value is set over the API on both sides, so the browser never types it.
- **Deliberate `409`s** (the viewer's refused autosave) are declared with
  `expectKnownHttpError`, scoped to `PATCH /api/v1/flows/{id}` → `409`. Tests without a
  refused save declare nothing.
- **LLM-free.** Chat Input → Chat Output, plus `SearchAPI` as a holder for a secret field.
  `SearchAPI` is never run.

### Known defect — an alphanumeric `api_key` is kept in the draft

`removeApiKeys` keeps an `api_key` whose value "looks like a variable name", so that an
imported flow can still resolve a global variable. The test is
`/^[A-Z][A-Z0-9_]*$/i`. Because it is case-insensitive, a raw key made only of letters,
digits and `_` that starts with a letter also passes it.

Measured on `1.14.0.dev10` and `1.14.0.dev14`:
- With `a3f9c2e7b1d4e8f0a6c5b2d9e1f7a3c8` typed into `SearchAPI`'s `api_key`, the key is
  stored in plain text in `localStorage`.
- After the reload, the banner does **not** say secret fields need re-entering, and Restore
  puts the key back.
- With a hyphenated key, the same flow is scrubbed.

Test 6 asserts the **correct** behaviour for this key and is marked `test.fail()`, citing
the upstream defect. While the defect stands, the test is expected to fail. When upstream
fixes it, Playwright reports the test as passing unexpectedly, which turns the run red.
That is the signal to remove `test.fail()` and close the reference.

---

## Tags *(required)*

`@workspace` `@database` `@playground`

**No `@stable` yet.** It is a new UI spec with a 5 s autosave debounce in its critical path.
It waits for team validation before promotion.

---

## Step by step *(required)*

Every test builds its flow over the API from the live catalog: Chat Input (`ChatInput-ci001`,
`base text`) wired to Chat Output, plus `SearchAPI` in the secret test. *Another session*
means a `PATCH` over the API that sets Chat Input's text to `their text`. An id-scoped
`afterEach` deletes the flow. Waits key on this flow's responses and on visible state, never
on time.

1. **A run on a stale canvas with an unsaved edit is blocked, and no run request is sent.**
   - Open the flow. Another session saves.
   - Type `my text` into Chat Input, then click Chat Output's run button at once, before
     the 5 s autosave.
   - `version-state` is read and the conflict banner appears.
   - Click run again. The notice *"This flow moved on while you were editing. Review the
     changes to run it."* appears.
   - No `POST /api/v2/workflows` and no `PATCH` were sent. The server still holds
     `their text`.

2. **A run on a stale canvas with no edit adopts the latest version, and only the next run
   executes it.**
   - Open the flow. Another session saves.
   - Click run. The notice *"langflow updated this flow. The canvas now shows the latest
     version — run again to execute it."* appears, Chat Input reads `their text`, no banner
     appears, and no `POST /api/v2/workflows` is sent.
   - Click run again. `POST /api/v2/workflows` → `200`, and the flow's stored User message
     reads `their text`.

3. **Restore brings unsaved work back after a reload, and the conflict stands again.**
   - Raise the conflict: another session saves, the viewer types `my text`, and the
     autosave answers `409`. The draft key exists.
   - Reload. `restore-draft-banner` reads *"Unsaved changes from {time}"* and *"Restore your
     work to pick up where you stopped."*. The conflict banner is absent, and Chat Input
     reads `their text`.
   - Restore. Chat Input reads `my text`, the conflict banner is back, and the draft key is
     still there. No `PATCH` is sent, and the server still holds `their text`.

4. **Discard drops the draft, writes nothing, and the offer does not come back.**
   - Raise the conflict and reload, as above.
   - Discard. The banner is gone, Chat Input reads `their text`, and the draft key is gone.
     No `PATCH` is sent, and the server still holds `their text`.
   - Reload again. No `restore-draft-banner`.

5. **A draft keeps no local copy of a secret, and the restored field is empty.**
   - Open the flow. Another session saves.
   - Type the sentinel `sk-e2e-secret-<random>` into `SearchAPI`'s `api_key`. The field
     holds it, which proves the sentinel was really entered. Then type `my text` into Chat
     Input, and the autosave answers `409`.
   - The draft key exists, and no `localStorage` value contains the sentinel.
   - Reload. The banner reads *"Restore your work — secret fields need to be entered
     again."*.
   - Restore. `api_key` is empty and Chat Input reads `my text`. The server's `api_key` is
     empty.

6. **An alphanumeric API key is not kept in the draft either** *(known defect,
   `test.fail()`)*.
   - As test 5, but the key is a random 32-character hex string that starts with a letter.
   - The draft key exists, and no `localStorage` value contains the key.
   - Reload. The banner reads *"Restore your work — secret fields need to be entered
     again."*. Restore leaves `api_key` empty.

7. **A flow too large to keep a local copy warns, and stores no draft.**
   - The flow and the other session's save both carry a 2.1 M-character Chat Input value.
   - Raise the conflict by moving Chat Output, and the autosave answers `409`.
   - Move Chat Output again. *"This flow is too large to keep a local copy of your unsaved
     changes…"* appears, and there is no draft key.

---

## Validation criterion *(required)*

- All tests pass three consecutive times at `--retries=0 --workers=1` on the current
  nightly, and once at `--workers=4`.
- Each test fails under a mutation of its load-bearing assertion, run in isolation:
  - a run request counted as allowed;
  - the adopted run's message expected to hold the old text;
  - Restore expected to drop the draft;
  - Discard expected to keep it;
  - the sentinel expected in `localStorage`;
  - the alphanumeric test without `test.fail()` must fail (the defect is live);
  - the too-large draft expected to exist.
- Zero flows left behind, and zero undeclared `🚨 Backend Error` lines.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the superuser.
- `src/frontend/src/stores/flowStore.ts`: `buildFlow`'s pre-run gate, and the `runBlocked` / `runAdopted` notices.
- `src/frontend/src/hooks/flows/use-check-flow-version.ts`: `checkFlowVersion` (adopt vs conflict) and `raiseConflictForStaleWork`.
- `src/frontend/src/hooks/flows/conflict-actions.ts`: `persistConflictDraft` and `reinstateDraftBaseline`.
- `src/frontend/src/hooks/flows/use-autosave-flow.ts`: the draft refresh while a conflict stands, and the `draftNotKept` error.
- `src/frontend/src/utils/conflict-draft.ts`: the `lf_draft_<user>_<flow>` key, the 2 000 000-character limit, and the secret scrubbing.
- `src/frontend/src/utils/reactflowUtils.ts`: `removeApiKeys` and `looksLikeVariableName`. The known defect in test 6 lives here.
- `src/frontend/src/components/core/flowConflict/RestoreDraftBanner.tsx`: `restore-draft-banner`, `restore-draft-button`, Restore and Discard.
- `src/frontend/src/stores/flowConflictStore.ts`: the conflict state both protections read.
- `src/frontend/src/hooks/flows/use-save-flow.ts`: the `409` handler that registers the conflict.
- `src/frontend/src/locales/en.json`: the `multiEdit.notice.*`, `multiEdit.draft.*` and `multiEdit.error.draftNotKept` strings.
- No provider key, no model, no network egress.
