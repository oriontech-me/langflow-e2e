# Grouping components raises a false `Error while updating the Component` notification although the grouping fully succeeds

| | |
|---|---|
| **Filed upstream** | **LE-2045** — https://datastax.jira.com/browse/LE-2045 |
| **Tracked in** | `oriontech-me/langflow-e2e#942` (§15.6 Grouping validate-&-promote) |
| **Component** | Langflow — frontend, canvas grouping (`SelectionMenu` → `handleGroupNode`) |
| **Surfaces** | Notification title `Error while updating the Component`, body `An unexpected error occurred while updating the Component. Please try again.` — raised as a toast and persisted in the Notifications panel (`notification_button`) |
| **Observed on** | `langflowai/langflow-nightly:latest` — `1.12.0.dev8` (image `sha256:b40093943c40de5b32744e8617ba7855a58f1e8efa803701e40944dc9d839e1a`, built 2026-07-28T01:37 UTC) |
| **Affects** | Unknown lower bound. Present on every 1.12 build checked; an earlier internal scout recorded the same toast during Wave 2. **No bisect was run** — do not quote a first-affected version |
| **Determinism** | Deterministic. Every grouping attempt raised it; no attempt grouped without it |
| **Captured** | 2026-07-28, local Docker instance, `LANGFLOW_AUTO_LOGIN=true`, `LANGFLOW_WORKERS=1`, single worker, no parallel load |
| **Environment** | Chromium (Playwright, arm64 macOS) **and** an independent manual reproduction in a normal browser session, different flow, dark theme |

---

## 1. Summary

Selecting two connected non-IO components and clicking **Group** works: the two nodes
collapse into a single `Group` node, the sub-flow is encapsulated inside it, the change is
persisted, and ungrouping restores both components and the edge between them.

While doing so, Langflow raises an error notification stating the update failed. The
message is false — no operation failed anywhere in the stack. It is not a transient toast:
it stays in the Notifications panel, with the bell badge lit, until dismissed by hand.

---

## 2. Steps to reproduce

1. Create a flow with two connected **non-IO** components — e.g. `Prompt Template` →
   `Language Model`. IO components are not eligible: `validateSelection` rejects a
   selection containing an input or output component.
2. Shift+drag a selection box across both nodes.
3. Click the **Group** button that appears above the selection.
4. Observe the error notification. Open the Notifications panel — it is still there.

---

## 3. Evidence that nothing actually failed

Captured in a session instrumented at the network layer, in which the notification appeared:

| Signal | Observed |
|---|---|
| `PATCH /api/v1/flows/{id}` (persists the grouped shape) | **200 OK** |
| `POST /api/v1/custom_component/update` (the component update behind the toast) | **200 OK**, twice |
| All requests in the session | **61 of 61 returned `200`** — no non-2xx of any kind |
| Browser console | **0 messages** — no error, no warning, nothing logged |
| Canvas result | one `Group` node exposing `Input` and `Language Model` |
| Persisted flow (`GET /api/v1/flows/{id}`) | exactly one node, `data.type === "GroupNode"`, `data.node.flow` non-null |
| Ungroup round-trip | restores both components **and** the edge between them |

There is no failed operation the message could be reporting.

---

## 3.1 Where the message comes from (source, not speculation)

The notification is raised in
[`src/frontend/src/CustomNodes/helpers/mutate-template.ts`](https://github.com/langflow-ai/langflow/blob/main/src/frontend/src/CustomNodes/helpers/mutate-template.ts),
in the outer `catch` of the debounced update:

```ts
try {
  const newTemplate = await postTemplateValue.mutateAsync({ … });
  if (newTemplate) {
    …
    try {
      setNodeClass(newNode);
    } catch (e) {
      if (e instanceof Error && e.message === "Node not found") {
        console.error("Node not found");
      } else {
        throw e;
      }
    }
  }
  callback?.();
} catch (e) {
  const error = e as ResponseErrorDetailAPI;
  setErrorData({
    title: i18n.t("input.titleErrorUpdatingComponent"),
    list: [error.response?.data?.detail || i18n.t("input.errorUpdatingComponent")],
  });
}
```

Two deductions follow from the measurements above, without guessing:

1. **The failure is client-side, after a successful update.** The generic fallback string
   is only used when `error.response?.data?.detail` is absent, and the update request
   itself returned `200`. Nothing was rejected by the backend.
2. **The existing "node disappeared" guard does not fire.** That branch would emit
   `console.error("Node not found")`, and the console is completely silent. So the error
   reaching the outer `catch` is **not** the `Error("Node not found")` thrown by
   `flowStore.setNode` — it is a different throw inside the same `try`, which is exactly
   why it escapes the guard and surfaces as a toast.

Read together: a debounced component update completes successfully and then tries to apply
its result to a node the grouping has already removed from the canvas, failing through a
path the current guard does not recognise.

**Adjacent prior art:** commit
[`4db7ea16d`](https://github.com/langflow-ai/langflow/commit/4db7ea16d) — *"fix: add error
handling when node stops existing before update completes"* (#8291, 2025-05-30) — added
both the `throw new Error("Node not found")` in `flowStore.setNode` and the guard above.
The class of problem is therefore already recognised upstream; the grouping variant is not
covered by that fix.

**Not established:** which statement throws, and when the grouping variant started. No
version bisect was run — see §6.

---

## 4. Expected behaviour

No error notification for a successful grouping. If some secondary update genuinely fails,
the notification should name what failed and be actionable — *"An unexpected error
occurred… Please try again."* instructs the user to retry an operation that already
succeeded, which would create a duplicate group.

---

## 5. Impact

- Users are told a successful action failed, and the suggested remedy is harmful.
- The notification persists rather than expiring, so repeated grouping accumulates false
  errors in the panel.
- It degrades the Notifications panel as a triage signal, for end users and for anyone
  reading it to diagnose a real failure.

Severity assessed **Medium**: no functional impact or data loss, but user-visible,
deterministic, persistent, and it pollutes the surface used to detect real errors.

---

## 6. Notes for triage

- The string `Error while updating the Component` is **generic** and predates this issue —
  [langflow-ai/langflow#3497](https://github.com/langflow-ai/langflow/issues/3497)
  (August 2024, Langflow 1.0.9) reports the same text from an unrelated Ollama
  drag-and-drop path. This report is specifically about the **grouping** trigger; do not
  close it as a duplicate of that older, unrelated ticket.
- A second grouping-area defect recorded in an earlier internal scout — an intermittent
  `500` on bulk `DELETE /api/v1/flows/` — **did not reproduce** in this session and is not
  claimed here.
- **No version bisect has been run.** Dating the grouping variant requires reproducing the
  three-step repro against older images (`langflowai/langflow:1.10.x`, `1.11.x`). Until
  that is done, treat the affected range as unknown rather than assuming 1.12 introduced
  it — the adjacent fix (#8291) predates 1.12 by a year, so an older lower bound is
  plausible. If the range does start before 1.12, the fix does not belong to a 1.12-only
  milestone (same trap as LE-2019).

---

## 7. Suite status

`tests/tests-automations/regression/core-components/nested-grouping-regression.spec.ts`
covers grouping, ungrouping and collapse/expand, and passes on `1.12.0.dev8`. The specs
deliberately **do not** assert the absence of this notification: doing so would hold the
§15.6 checklist items red on a defect with no functional impact. Revisit once the upstream
fix lands.
