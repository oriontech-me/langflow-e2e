# Credential secrets crossing a graph edge — real to execution, masked to display

**File:** `tests/tests-automations/regression/security/credential-secret-across-edges.spec.ts`

**Last validated:** Langflow 1.12.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

Upstream [#14216](https://github.com/langflow-ai/langflow/pull/14216) — `fix: preserve secret
values across graph edges`, merged 2026-07-22, fixing `langflow-ai/langflow#14152`.

The root cause in the PR's own words: `Component._get_output_result()` sanitized its return
value **in place** before storing it in `Output.value`, and `ComponentVertex._get_result()`
prefers that cache for connected edges — so **a downstream component received the literal mask
instead of the real value**. Moving the masking to `_build_results()` alone was rejected
because downstream would then get the real value without knowing it came from a secret input,
"which can expose it again in terminal flow results". The fix therefore carries runtime-only
secret metadata across the edge, so each downstream sanitizes its own display copies without
altering execution values.

**Nothing in this suite covers the edge.** `security/credential-secret-exposure.spec.ts`
(#7313) proves a resolved credential reaches **one node** and reaches none of the observable
surfaces — and its flow is deliberately several **independent root nodes with no edges at
all**, so the entire mechanism #14216 fixed sits outside it.

### Why either half alone is worthless — and this decides the spec's shape

- **Masking asserted alone passes on the very defect #14216 fixed.** Before the fix the
  downstream received `**********`, so "the secret does not appear in the output" was *more*
  true, not less: the value had already been destroyed. A spec that only asserted absence
  would have been green throughout the bug.
- **Delivery asserted alone passes on a build that masks nothing.** A component that never
  sanitizes anything delivers the real value across the edge perfectly.

Only the two together describe the product, which is why this file measures them on **one
run**.

### The measured contract

One `POST /api/v1/run/{flow_id}?stream=false` with `output_type: "debug"`, on a three-node
custom-component graph fed by a `Credential` global variable holding a **22-character**
sentinel. `A` emits the resolved secret onto its single output; `B` and `C` both read that
same output.

| node | code | `artifacts.output.repr` text | mask | sentinel |
|---|---|---|---|---|
| `A` upstream | `SecretStrInput` → `Message(text=self.<field>)` | `**********` | present | absent |
| `B` measure | `Message(text=f"received_len={len(got)}")` | `received_len=22` | absent | absent |
| `C` echo | `Message(text=got)` | `**********` | present | absent |

Plus: the sentinel literal appears **nowhere** in the whole response body.

Three properties make this worth a spec rather than one assertion.

**`22`, not `10`, is the entire discriminator.** The mask is `**********` — ten characters —
so a sentinel of length 10 makes the delivery assertion impossible to distinguish from the
defect. With the pre-fix behaviour `B` reads `received_len=10`. The spec asserts the sentinel's
length is not 10, in the test, so a future edit that shortens it fails loudly instead of
quietly disarming the file.

**`B` is also the control that the credential resolved.** A length is impossible to produce
without having resolved the credential and discloses nothing (the idea
`credential-secret-exposure.spec.ts` established). Had the variable failed to resolve, `A`
emits `""` and `B` reads `received_len=0` — distinguishable from both 22 and 10. So every
masking assertion in this file is non-vacuous by construction.

**The fan-out makes simultaneity literal.** `B` and `C` read the *same* upstream output on the
*same* run, one measuring it and one re-emitting it. "Real to execution, masked to display" is
therefore one measurement rather than two runs compared after the fact — and `C` is the half
that pins the metadata propagation: a downstream re-emitting a secret it legitimately received
is still masked, which is exactly the exposure `_build_results()`-only masking would have left
open.

---

## Tags *(required)*

`["@api", "@regression"]`

`@api` for the layer — every call goes through the `request` fixture, no browser. `@regression`
because the file pins an upstream fix. Same pair as both `security/` siblings; that directory
is area-by-directory and no functional tag in `CLAUDE.md`'s table names the secret-handling
surface.

**No `@stable` yet**, per the rule that the tag follows team validation. Strong candidate:
keyless, no model, one run, a few seconds.

---

## Preconditions *(required)*

- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`. The image ships it **false** (#668/#746), and with
  it off the custom code never executes — `B` would report nothing and the file must fail
  loudly rather than pass vacuously. Both start scripts and every CI lane set it.
- `auto_login`, for the bearer token and the minted API key.
- No provider key, no model, no external network.

---

## Step by step *(required)*

`beforeAll` does the setup and **the single run**, because every assertion below is a reading
of that one response and the file's claim is that they are simultaneous. It asserts the run
answered `200` and carried all three nodes, so a broken run fails there — with the cause named
— instead of producing three confusing reds downstream.

1. **Seed the credential.** `POST /api/v1/variables/` with `type: "Credential"` and a
   22-character sentinel. Its length is asserted `!== 10` right there.
2. **Build the graph.** Three `CustomComponent` nodes from the live catalog and two edges, both
   from `A`'s single output: `A → B` and `A → C`.
3. **Run once.** `POST /api/v1/run/{flow_id}?stream=false`, `output_type: "debug"` so every
   vertex reports. Readings are keyed by `component_id`, so each assertion names the node it
   is about rather than searching the blob.
4. **`B` proves the edge delivered the real value** — its text is `received_len=22`. Asserted
   as the exact length, not merely "not 10": a wrong-but-plausible length would mean the value
   was transformed on the way.
5. **`A`'s display copy is masked** — its text is exactly `**********`, and does not contain the
   sentinel.
6. **`C` is masked too** — the propagation half. A downstream re-emitting the secret still
   shows the mask.
7. **The sentinel appears nowhere in the response body** — asserted over the whole payload, not
   one node's slice: "not in that node" says nothing about the other surfaces the same run
   writes.
8. **Cleanup.** `afterAll` deletes the flow, revokes the API key, and deletes the credential
   variable. Ids are recorded before any assertion that can throw.

---

## Validation criterion *(required)*

- On one run: `B` reads `received_len=<len(sentinel)>`, `A` and `C` both read exactly the mask,
  and the sentinel literal is absent from the entire response.
- The sentinel's length is not 10, asserted in the spec.

**Force-fail evidence.** The two mutations that matter are opposite, and each is the reading of
a real regression: requiring `B` to read the mask's length (`received_len=10`) is the pre-fix
defect, and requiring `C` to contain the sentinel is the leak that `_build_results()`-only
masking would have produced. A mutation on the "sentinel absent" assertion alone proves less —
it reddens on a healthy build too.

---

## What this test does not cover *(and why)*

- **Raw secret metadata surviving vertex serialization** — #14216's fourth claim, and its own
  issue (#1600). It reaches the `vertex_build` rows rather than the run response, and whether
  it is observable through any API needs measuring before it can be specified at all.
- **The UI.** This is the graph-execution contract; whether the playground renders a mask is a
  separate surface.
- **Secrets that are not `SecretStrInput`.** The masking is type-driven (`password=True`); an
  env-var-sourced value that never becomes a `SecretStrInput` is a different mechanism, and
  `credential-secret-exposure.spec.ts` already covers the type-vs-name distinction that
  #7313 was about.
- **Multi-hop propagation.** One edge is asserted. Whether the metadata survives `A → B → C`
  is a plausible follow-up; a single hop is what #14216's root cause describes and what a
  regression in `Output.value` would break first.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/custom/custom_component/component.py` — `_get_output_result` and
  `_build_results`, where the in-place sanitization was and where the masking moved to.
- `src/lfx/src/lfx/graph/vertex/base.py` — `_get_result`, which prefers the `Output.value`
  cache for connected edges. This preference is what turned an in-place mask into a delivery
  bug.
- **Langflow API** — `GET /api/v1/auto_login`, `GET /api/v1/all` (the `CustomComponent`
  template the nodes are built from), `POST /api/v1/variables/`, `POST /api/v1/flows/`,
  `POST /api/v1/api_key/`, `POST /api/v1/run/{id}`, and the matching `DELETE`s.
- **`LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`** on the instance.
- **No provider key, no model, no external network.**

---

## Two traps the helper encodes *(measured, both silent)*

1. **Edge handles are JSON with every `"` replaced by `œ`** (`scapedJSONStringfy` in the
   frontend) and the **backend reads those strings**. Passing only the `data.sourceHandle` /
   `data.targetHandle` objects yields `Edge between CustomComponent and CustomComponent has no
   matched type` — a message that names neither the encoding nor the field. Already implemented
   as `escapeHandle` in `create-python-interpreter-flow-via-api.ts`; reused rather than
   re-derived.
2. **Pasting custom code does not update the node's declared `outputs`.** The stock
   `CustomComponent` template declares `types: ["JSON"]`; code returning a `Message` therefore
   mismatches, and the failure is reported as the *same* `has no matched type` message rather
   than as a type error — so the two traps are indistinguishable from the message alone. The
   frontend rebuilds the template from the code; an API caller must set `outputs` by hand.
   `create-credential-consumer-flow-via-api.ts` never hit this because all of its nodes are
   roots with no edges.
