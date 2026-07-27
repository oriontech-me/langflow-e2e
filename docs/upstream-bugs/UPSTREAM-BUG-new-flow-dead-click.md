# `New Flow` click is silently dropped when the flows list has not painted its cards yet — the button then becomes non-actionable

| | |
|---|---|
| **Filed upstream** | **LE-2019** — https://datastax.jira.com/browse/LE-2019 (Bug, Minor, status `BUGS`, reporter Rafael Gil, filed 2026-07-27) |
| **Tracked in** | `oriontech-me/langflow-e2e#966` (spun out of daily triage `#962`) |
| **Component** | Langflow — frontend, flows list / `New Flow` entry point |
| **Surfaces** | button `data-testid="new-project-btn"`; expected results `data-testid="flow-builder-welcome-panel"` or `data-testid="modal-title"` |
| **Observed on** | `langflowai/langflow-nightly:latest` — `1.12.0.dev6` (image `sha256:ba51c9762fceed23f06063f495043cf655b9ca34cdb6d171f53b15dfd41d4e34`); an independent pass also ran `1.12.0.dev7` |
| **Affects** | 1.10.1 → `main`. **Not a 1.11 → 1.12 regression** — the nightly frontend tree is byte-identical to the 1.11.x release frontends |
| **Last known good** | 1.10.0 (code/git evidence only — no runtime comparison was executed) |
| **First affected** | 1.10.1, via PR #12575 (`2bfa634dfb`, *"feat: flow builder assistant with real-time canvas updates"*) |
| **Determinism** | Intermittent and environment-sensitive. 5 of 9 attempts dead in the immediate-click shape on dev6; 0 of 8 dead once any readiness wait precedes the click. An independent pass on dev7 got 10/10 alive — do not quote a fixed rate |
| **Captured** | 2026-07-27, local Docker instance, `LANGFLOW_AUTO_LOGIN=true`, `LANGFLOW_WORKERS=1`, single worker, no parallel load |
| **Environment** | Chromium (Playwright 1.58.2, arm64 macOS); reproduced with 2, 10, 11, 12 and 69 flows on the instance |

---

## 1. Summary

Clicking **New Flow** on the flows list produces no visible result when the click lands
before the list has painted its flow cards: no navigation, no flow-builder welcome
overlay, no templates modal, no toast, **no console error**. Subsequent clicks on the
same button then fail actionability (`locator.click` times out at 15 s), so the page is
stuck on the list until a reload.

The failing attempts correlate exactly with one observable: the list shell is mounted
(`cards-wrapper` and `mainpage_title` present) while **zero** `list-card` elements have
painted. Every passing attempt clicked with 10–12 cards painted.

This is not new in 1.12. The nightly frontend equals the 1.11.x release frontend, and the
create-then-navigate behavior on this button was introduced in **1.10.1** by PR #12575;
1.10.0 opened the templates modal and created nothing server-side. Consequence for
triage: the 1.11.x line is affected too, so the fix does not belong to a 1.12-only
milestone.

---

## 2. Steps to reproduce

### 2.1 Manual (UI only)

Chromium, one local instance, at least one existing flow so the header entry point
renders. **Do not reload between the steps** — the page session is part of the trigger.

1. Open any flow (wait for the canvas).
2. Click the header **←** chevron to return to the flows list (lands on `/flows`).
3. Click **New Flow** *immediately*, without waiting for the flow cards to paint.
4. Wait 12–15 s.

**Bug:** nothing opens; the list stays on screen with the button still enabled. Clicking
the button again does not recover it — the click no longer registers as actionable.

Recovery: reload the page, or wait for the cards to paint before clicking.

### 2.2 Automated (Playwright, no test framework)

```js
const page = await (await browser.newContext()).newPage();

const opened = async (ms) => {                 // welcome overlay OR templates modal
  const deadline = Date.now() + ms;
  for (;;) {
    for (const id of ["flow-builder-welcome-panel", "modal-title"]) {
      if (await page.getByTestId(id).first().isVisible().catch(() => false)) return id;
    }
    if (Date.now() >= deadline) return "none";
    await page.waitForTimeout(200);
  }
};

const snapshot = () => page.evaluate(() => ({
  url: location.pathname,
  cards: document.querySelectorAll('[data-testid="list-card"]').length,
}));

for (let i = 1; i <= 6; i++) {
  await page.goto(`http://localhost:7860/flow/${EXISTING_FLOW_ID}`);
  await page.getByTestId("canvas_controls_dropdown").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByTestId("icon-ChevronLeft").first().click();   // back to the list
  await page.getByTestId("new-project-btn").waitFor({ timeout: 30000 });

  console.log(`iter ${i} at click:`, await snapshot());          // cards: 0 on the dead ones
  await page.getByTestId("new-project-btn").click({ timeout: 15000 })
    .catch((e) => console.log("  click error:", String(e).split("\n")[0]));
  console.log(`iter ${i} ->`, await opened(12000));              // "none" == the bug
}
```

Add these listeners to settle the two open questions in one pass (see §6):

```js
page.on("framenavigated", (f) =>
  f === page.mainFrame() && console.log("NAV", new URL(f.url()).pathname));
page.on("response", async (r) => {
  const m = r.request().method(), u = r.url();
  if (!u.includes("/api/v1/flows")) return;
  if (m === "POST")   console.log("POST", r.status(), (await r.json().catch(() => ({}))).id);
  if (m === "DELETE") console.log("DELETE", u.split("/").pop());
  if (m === "GET" && u.includes("header_flows"))
    console.log("GET header_flows n=", (await r.json().catch(() => [])).length ?? "?");
});
```

---

## 3. Expected vs actual

**Expected:** the click navigates to the newly created flow and renders the flow-builder
welcome overlay (or the templates modal) — exactly what the first click of a fresh page
session does, in 225–592 ms.

**Actual:** nothing renders, the app stays on the list, and the button stops being
actionable. State captured at click time on the failing attempts:

```json
{ "url": "/flows", "cards": 0, "cardsWrapper": true, "mainpageTitle": true,
  "btnDisabled": false, "btnAria": null, "btnPointer": "auto",
  "btnHasReactProps": true, "btnOnClick": "function", "skeletons": 0 }
```

The button is enabled, has `pointer-events: auto`, carries a wired React `onClick`, and
no skeleton placeholder is on screen — so this is not a disabled, covered or
still-skeleton control.

---

## 4. Measurements

| Shape | Result |
|---|---|
| Click immediately after the chevron back-navigation (no wait) — run A, 5 iterations | **3/5 dead** |
| Same shape — run B, 4 iterations (`no-settle` arm) | **2/4 dead** |
| Combined immediate-click shape | **5/9 dead** |
| 3 s settle before the click (`settle-3s` arm) | **4/4 alive**, first click |
| Wait for the first `list-card` to paint (`wait-card` arm) | **4/4 alive**, first click |
| Straight from a full page load (`goto "/"` then click) — run A | **5/5 alive**, opened in 528–592 ms |
| Independent pass on 1.12.0.dev7, similar loops | **10/10 alive** (counter-evidence; see §6) |
| Instance size | No correlation (2, 10, 11, 12 and 69 flows) |

After a dead click, retry clicks fail actionability:

```
TimeoutError: locator.click: Timeout 15000ms exceeded.
Call log:
  - waiting for getByTestId('new-project-btn')
```

---

## 5. Code pointers (code/git analysis — not runtime-verified)

- **The button.** `src/frontend/src/pages/MainPage/components/header/index.tsx`
  ```diff
  - onClick={() => setNewProjectModal(true)}                                   // 1.10.0 — opens modal, no POST
  + onClick={() => (onNewFlow ? onNewFlow() : setNewProjectModal(true))}       // 1.10.1+
  ```
- **`onNewFlow` = `useStartNewFlow`**
  (`components/core/flowBuilderWelcome/hooks/use-start-new-flow.ts:23-34`) creates first
  and navigates second:
  ```ts
  const id = await addFlow();      // POST /api/v1/flows -> 201
  openWelcome(id);
  navigate(`/flow/${id}...`);
  ```
- **A silent return to the list**, with no toast and no console error, exists at
  `pages/FlowPage/index.tsx:175-181` — `navigate("/all")` when the flow id is absent from
  the Zustand `flows` array.
- **That array is written as a side effect inside a queryFn**
  (`controllers/API/queries/flows/use-get-refresh-flows-query.ts:74` → `setFlows(flows)`),
  and every create fires `refetchQueries` on that key
  (`controllers/API/queries/flows/use-post-add-flow.ts:52-64`). `api.get` carries no
  `AbortSignal`, so a superseded response still runs its `setFlows` — with a pre-creation
  list.
- **Version boundary.** Tree hashes of `src/frontend/src`: `main @ ce17f022be` ==
  `v1.11.0` == `be52b39a965a7e7e0daa8a0b1b2be189479afa97`; `main @ 3551acb16e` ==
  `v1.11.1` == `81209eb20f51cf8d02cc8c6768a51b40beb824d6`. The diff across the whole New
  Flow path between `v1.11.0` and `v1.11.1` is empty. `1.10.0` has no
  `use-start-new-flow.ts`.
- **Not a gate:** `agentic_experience` default flipped in #14244 (present in 1.11.1 and
  the nightly, absent from 1.11.0 GA) does not gate this path — the welcome overlay mounts
  under `!effectiveLocked` only (`pages/FlowPage/components/PageComponent/index.tsx:1030`).
  When comparing against 1.11.0 GA, still start it with
  `LANGFLOW_AGENTIC_EXPERIENCE=true` so the Assistant hand-off is not a second variable.

**Hypothesis consistent with every observation:** the create succeeds, the app navigates
to `/flow/<id>`, and `FlowPage` bounces straight back because the new id is missing from a
stale `flows` array — which is also why the failure correlates with `cards: 0` (the list
query has not settled at click time).

---

## 6. NOT verified — read before filing

- **Whether the dead click fires `POST /api/v1/flows` and leaves an orphan flow.** The
  create-then-navigate ordering makes it likely, but **per-click attribution was never
  captured** (the local instance went down before that instrumented run). Do not claim
  "creates a flow with no navigation" until the §2.2 listeners confirm it.
- **The bounce itself.** Pre-click URL `/flows` (captured) and post-click URL `/all` on
  dead attempts (captured in a *different* run) are consistent with
  `FlowPage/index.tsx:175-181`, but no `framenavigated` log ties them together in one run.
  Note also that `/all` is reachable only via the two hardcoded `navigate("/all")` calls in
  `FlowPage`, so a post-click `/all` is meaningful — but only when the pre-click URL is
  captured in the same run.
- **No cross-version runtime comparison was executed.** The 1.10.0 / 1.10.1 boundary is
  git + code evidence only.
- **Reproduction rate is environment-sensitive.** An independent pass on `1.12.0.dev7`
  went 10/10 alive with similar loops, so the 5/9 measured here is not a stable rate. A
  report that quotes a rate a maintainer cannot hit gets closed — state the correlation
  (`cards: 0`), not the percentage.
- **The empty-page CTA** (`new_project_btn_empty_page`, `pages/MainPage/pages/empty-page.tsx:163-165`)
  and the `EmptyFolder` CTA (`pages/MainPage/pages/homePage/index.tsx:325`) both call the
  same `startNewFlow`, so they share the path by code — not behaviorally tested.

---

## 7. Impact

**Users.** Returning to the flows list and clicking **New Flow** right away does nothing,
and clicking again does not help; the workaround (reload) is not discoverable. If the
create does fire (§6), each dead click also leaves an empty flow behind.

**Automation.** Any helper that clicks this entry point and waits for the welcome overlay
or the templates modal hangs. A retry loop does not rescue it — the button is no longer
actionable, and if the create fires, each retry adds another orphan flow. In our suite this
is a recurrent flake on the second **New Flow** of a test session (dailies 2026-07-16 and
2026-07-27), which passes on retry precisely because a Playwright retry opens a fresh
browser session.

---

## 8. Suggested confirmation runs (cheapest first)

1. **1.10.0** — click **New Flow**. Prediction: the templates modal opens and **no**
   `POST /api/v1/flows` fires (flow count unchanged). Deterministic, no flake involved:
   this run alone closes the last-known-good boundary.
2. **1.11.1** — drive `regression/flow-functionality/run-flow.spec.ts` (the only path with
   a known failure) rather than a synthetic loop; budget many cycles.
3. **Instrumented dev6/dev7 run** with the §2.2 listeners: `NAV /flow/<id>` followed by
   `NAV /all` confirms the bounce; a `POST 201` on a dead click confirms the orphan.

---

## Appendix A — evidence log: E2E daily runner

Spec `tests/tests-automations/regression/flow-functionality/run-flow.spec.ts`, the second
`New Flow` of the session (line 98 at that commit), reached right after the header chevron.
Run [30261409427](https://github.com/oriontech-me/langflow-e2e/actions/runs/30261409427),
2026-07-27. Same signature on 2026-07-16.

```
--- user should be able to use Run Flow without any issues | attempt 0 failed 58.2 s
   ERR: Error: expect(received).toBe(expected) // Object.is equality

     Expected: true
     Received: false

     Call Log:
     - Timeout 30000ms exceeded while waiting on the predicate

       at helpers/flows/open-new-flow-templates-modal.ts:51

       49 |   // pins the visibility wait to the full timeout.
       50 |   const welcomePanel = page.locator(WELCOME_PANEL);
     > 51 |   await expect
          |   ^
       52 |     .poll(() => overlayOrModalAppeared(page, 0), { timeout: 30000 })
       53 |     .toBe(true);

       at dismissWelcomeOverlayAndWaitForModal (open-new-flow-templates-modal.ts:51:3)
       at openNewFlowTemplatesModal (open-new-flow-templates-modal.ts:117:3)
       at tests-automations/regression/flow-functionality/run-flow.spec.ts:98:7

--- user should be able to use Run Flow without any issues | attempt 1 passed 21.9 s
```

The polled predicate races **both** expected end states (welcome overlay *or* templates
modal), so its exhaustion means neither surface ever rendered.

## Appendix B — evidence log: run A (entry-point comparison, dev6)

Two variants per iteration on one browser context: `[home]` = full page load then click;
`[back-nav]` = open a canvas, leave via `icon-ChevronLeft`, click immediately. Verbatim:

```
seed flow: 4c9b1486-cd48-4874-9468-740043e870b2 | flows on instance: 3
iter 1 [home]     -> welcome after 579ms {"url":"/flow/37347070-ca30-49fb-8578-b5b47328d5bb","welcome":"visible","modal":"absent","dialogs":[],"newProjectBtn":"absent","emptyBtn":"absent","canvasControls":"absent","welcomeish":["flow-builder-welcome","flow-builder-welcome-backdrop","flow-builder-welcome-faux-rail",...,"flow-builder-welcome-panel","flow-builder-welcome-browse-more"]}
iter 1 [back-nav] -> none (15s, nothing) {"url":"/all","welcome":"absent","modal":"absent","dialogs":[],"newProjectBtn":"visible","emptyBtn":"absent","canvasControls":"absent","welcomeish":[]}
iter 3 [back-nav] -> none (15s, nothing) {"url":"/all","welcome":"absent","modal":"absent","dialogs":[],"newProjectBtn":"visible","emptyBtn":"absent","canvasControls":"absent","welcomeish":[]}
iter 4 [back-nav] -> none (15s, nothing) {"url":"/all","welcome":"absent","modal":"absent","dialogs":[],"newProjectBtn":"visible","emptyBtn":"absent","canvasControls":"absent","welcomeish":[]}
iter 5 [back-nav] -> welcome after 277ms {"url":"/flow/5369ac44-30c0-4788-a39b-b0991035dead","welcome":"visible",...}
TALLY: {"home:welcome":5,"back-nav:none":3,"back-nav:welcome":2}
flows left: 2
```

Reading: the welcome overlay testids (`flow-builder-welcome-panel`,
`flow-builder-welcome-browse-more`) **do** exist on this build — they render on every
passing attempt, which rules out a renamed selector. On the dead attempts the final URL is
`/all` while `new-project-btn` is still visible.

## Appendix C — evidence log: run B (readiness arms, dev6)

Three arms per iteration, all after the same chevron back-navigation: `ARM1` clicks
immediately and re-clicks up to 4×; `ARM2` waits 3 s then clicks once; `ARM3` waits for the
first `list-card` then clicks once. Verbatim tail (iterations 3–4 plus the tally):

```
  iter 3 arm1 attempt 4 click error: TimeoutError: locator.click: Timeout 15000ms exceeded.
Call log:
  - waiting for
iter 3 ARM1 (no settle):      opened on attempt NEVER | readiness {"url":"/flows","cards":0,"cardsWrapper":true,"mainpageTitle":true,"btnDisabled":false,"btnAria":null,"btnPointer":"auto","btnHasReactProps":true,"btnOnClick":"function","skeletons":0}
iter 3 ARM2 (3s settle):      opened=true            | readiness {"url":"/flows","cards":10,"cardsWrapper":true,"mainpageTitle":true,"btnDisabled":false,"btnAria":null,"btnPointer":"auto","btnHasReactProps":true,"btnOnClick":"function","skeletons":0}
iter 3 ARM3 (wait list-card): opened=true            | readiness {"url":"/flows","cards":11,...}
  iter 4 arm1 attempt 3 click error: TimeoutError: locator.click: Timeout 15000ms exceeded.
  iter 4 arm1 attempt 4 click error: TimeoutError: locator.click: Timeout 15000ms exceeded.
iter 4 ARM1 (no settle):      opened on attempt NEVER | readiness {"url":"/flows","cards":0,...}
iter 4 ARM2 (3s settle):      opened=true            | readiness {"url":"/flows","cards":12,...}
iter 4 ARM3 (wait list-card): opened=true            | readiness {"url":"/flows","cards":12,...}
TALLY: {
 "no-settle:attempt1": 2,
 "settle-3s:attempt1": 4,
 "wait-card:attempt1": 4,
 "no-settle:NEVER": 2
}
flows left: 2
```

Reading: this is the run that produced the `cards: 0` correlation and the
`locator.click` timeouts on the retry clicks. Iterations 1–2 were lost when the shell
buffer rotated; the tally covers all four.

## Appendix D — related but separate defect (file ahead of this one)

While tracing the above, a second defect was found and **runtime-confirmed on 1.12.0.dev7**
by an independent pass: the welcome overlay's "blank placeholder" cleanup
(`components/core/flowBuilderWelcome/flow-builder-welcome-mount.tsx:48-64`) deletes a flow
that is **not** blank. Its guard reads `placeholder.data?.nodes?.length`, but `data` is
always `null` in the `header_flows=true` payload
(`services/database/models/flow/model.py:295-300` blanks it for anything that is not a
component), so **every** flow looks blank. Observed: a placeholder holding two nodes was
`404` after the welcome → *Blank Flow* hand-off, with no prompt and no toast.

That is silent data loss and deterministic — it warrants its own report at higher priority
than this one, and it is likewise **not** a 1.12 regression (same 1.10.1 origin).

**Status: NOT filed yet.** This report's own defect is filed as LE-2019; the placeholder
deletion above still has no card. Draft summary for it:

> Welcome-overlay placeholder cleanup deletes a non-blank flow — the "is blank" guard reads
> `data` from `header_flows`, which is always `null` for flows
