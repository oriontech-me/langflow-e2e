# Import Invalid Flow File — Error Notification (§12.4 Export / Import Flow)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that when a user drops an **unimportable file** onto the flows page
(the `cards-wrapper` drop zone), Langflow rejects it and surfaces an explicit,
user-visible error — it never silently creates a broken flow or swallows the
failure. Three rejection modes, each proven by the **persistent** notification
entry (not the auto-dismissing toast):

1. **Malformed JSON syntax (`@stable`, §12.4 "Import invalid JSON — should
   display error message")** — dropping `{ this is not valid json !!!`. The
   notification reads **"Error occurred while uploading file"** with the JSON
   parser detail **"Expected property name or '}' in JSON at position 2 (line 1
   column 3)"** — the distinctive signal that the file failed to parse as JSON.
2. **Non-JSON file type** — dropping a `.txt` file. The notification reads
   **"Error occurred while uploading file"** with detail **"Invalid file type"**.
3. **Valid JSON, invalid flow shape** — dropping well-formed JSON that lacks the
   required `data` field. The notification reads **"Error occurred while
   uploading file"** with detail **"Invalid flow data"** — parseable JSON, but
   not a valid flow.

If this breaks, an unimportable file would fail silently — the user gets no
feedback and cannot tell a rejected import from a successful one, or Langflow
would persist a malformed flow.

---

## Tags *(required)*

All three tests: `@stable` `@release` `@workspace` `@regression`

The `@stable` promotion (this issue, #683) covers the §12.4 bullet. The two
sibling negative cases (non-JSON, invalid flow shape) share the same file and
the same import-rejection surface; all three now assert a distinctive persistent
observable, so all three are promoted together.

---

## Step by step *(required)*

Shared setup: bootstrap the app (`awaitBootstrapTest(page, { skipModal: true })`)
and wait for `mainpage_title`. Any flow this page creates is captured from its
`POST /api/v1/flows → 201` response and deleted id-scoped in `afterEach`
(defensive — a rejected import creates no flow, so the tracker normally captures
nothing). No `page.allowFlowErrors()` is needed: all three rejections are
100% client-side (verified live — zero `/api/` calls fire on the drop), so
neither the fixture's backend-HTTP monitor nor its flow-error monitor trips.

Each test drops one crafted `File` onto `cards-wrapper` via a synthetic
`DataTransfer` (`dispatchEvent("drop", { dataTransfer })`), then:

**Malformed JSON (`@stable`):**
1. Drop `{ this is not valid json !!!` as `invalid.json`
   (`application/json`)
2. Assert the toast **"Error occurred while uploading file"** is visible
3. Open the notifications dropdown (`notification_button`)
4. Assert `notification-dropdown-content` contains **"Error occurred while
   uploading file"** AND the JSON parser detail **"Expected property name or
   '}'..."**
5. Assert no **"uploaded successfully"** message appeared

**Non-JSON file:**
1. Drop plain text as `notaflow.txt` (`text/plain`)
2–3. Same toast + open dropdown
4. Assert `notification-dropdown-content` contains **"Error occurred while
   uploading file"** AND **"Invalid file type"**
5. Assert no success message

**Invalid flow shape:**
1. Drop `{"name":...,"description":...}` (no `data`) as `incomplete.json`
   (`application/json`)
2–3. Same toast + open dropdown
4. Assert `notification-dropdown-content` contains **"Error occurred while
   uploading file"** AND **"Invalid flow data"**
5. Assert no success message

---

## Validation criterion *(required)*

For each of the three files, after the drop:

- The transient toast **"Error occurred while uploading file"** is visible, AND
- The **persistent** `notification-dropdown-content` contains **"Error occurred
  while uploading file"** together with the case-specific detail — **"Expected
  property name or '}'..."** (malformed JSON) / **"Invalid file type"**
  (non-JSON) / **"Invalid flow data"** (invalid shape), AND
- No **"uploaded successfully"** message appears.

Each assertion targets a single, distinctive observable — no fuzzy
`invalid|error|failed` OR-chain, no `.catch(() => false)` swallow, no
"app didn't crash" tautology. A mutated assertion (wrong detail text, or
expecting success) fails deterministically. Asserting the **persistent**
dropdown entry rather than the fading toast makes the detail check race-free.

---

## External dependencies *(required)*

- `data-testid="cards-wrapper"` — the flows-page drop zone that receives imports
- `data-testid="notification_button"` — header notification bell
- `data-testid="notification-dropdown-content"` — persistent notifications list
- `data-testid="mainpage_title"` — flows page loaded marker
- No API key or provider required — the file is rejected client/ingestion-side
  before any flow run.

---

## What this test does not cover *(optional)*

- Successfully importing a valid exported flow (the happy path — separate bullet)
- Importing via the file-picker button (only the drag-and-drop drop zone here)
- Dismissing / clearing the notification entry
- Oversized-file rejection (§5.1 — separate spec)

---

## Notes *(optional)*

- **Hardening (root cause of the promotion work).** The original file had two
  dead tests: the non-JSON case asserted only `successVisible === false` after a
  fixed wait (a silent no-op passed), and the invalid-shape case asserted only
  that `mainpage_title` was still visible ("app didn't crash" — always true).
  Both were rewritten against the scouted persistent observable so they can
  actually fail. The malformed-JSON case's fuzzy `getByText(/invalid|error|...)`
  regex was replaced with the exact toast + dropdown detail.
- **Assert the persistent dropdown, not the toast.** The slide-in upload-error
  toast auto-dismisses; the `notification-dropdown-content` entry persists.
  Asserting the dropdown avoids the toast-fade race (same lesson as #693/#695).
- **Observables verified live on 1.11.0.dev41** via `playwright-cli`: all three
  drops produced the toast "Error occurred while uploading file" plus the
  case-specific detail listed above, and none created a flow.
- **Flow cleanup.** A rejected import creates no flow, but the spec still tracks
  `POST /api/v1/flows → 201` ids and deletes them id-scoped in `afterEach` per
  the repo convention (#490/#681) — a no-op here, present so a future
  behavior change that starts persisting cannot silently leak.
