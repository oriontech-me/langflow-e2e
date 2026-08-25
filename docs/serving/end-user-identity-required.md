# Serving-plane end-user identity — required means refused, on every surface

**File:** `tests/tests-automations/regression/serving/end-user-identity-required.spec.ts`

**Last validated:** Langflow 1.12.0.dev38 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`)

---

## What this test validates *(required)*

With `LANGFLOW_SERVING_END_USER_REQUIRED=true` (on top of a configured, trusted header), an
identity-less request is **refused** rather than anonymised — `401`, with a machine-readable
code and a message naming the configured header — while an identified request still runs.

This is the row an operator relies on to guarantee that *no* traffic reaches a flow
unattributed. A regression here does not corrupt data; it silently re-opens the instance to
anonymous traffic, which is why the refusal is asserted as a status **and** a code **and** on
both serving surfaces.

**Measured on `dev38`, `HEADER=X-End-User-Id` + `TRUST=true` + `REQUIRED=true`:**

| request | `POST /api/v2/workflows` | `POST /api/v1/run/{id}` |
|---|---|---|
| `X-End-User-Id: alice` | `200`, session `alice::S` | `200`, session `alice::S` |
| no header | **`401`** | **`401`** |
| `X-End-User-Id: "   "` | **`401`** | — |

The refusal body, byte-for-byte on both surfaces:

```json
{"detail":{"error":"End-user identity required",
           "code":"END_USER_IDENTITY_REQUIRED",
           "message":"End-user identity is required but the 'X-End-User-Id' header is missing."}}
```

**`code` is what the spec asserts on, not the sentence.** A refusal message is copy tuned
over time; the code is the contract a gateway branches on. The message is still asserted for
one specific property — that it **names the configured header** — because an operator who set
a non-default header name needs the error to tell them which one is missing, and a hardcoded
`'X-End-User-Id'` in the message would be a real (if small) defect that only this assertion
would catch.

**The whitespace-only case is refused with the identical body** — including the word
"missing", even though the header was present. That is worth recording rather than
paraphrasing: blank is not an identity, and the product does not distinguish blank from
absent in its message. A spec that asserted a *different* message for the blank case would
fail against correct behaviour.

**Both surfaces, and asserting the `200` half too.** A guard that refuses everything is as
broken as one that refuses nothing, and would pass a spec that only checked the `401`s.

---

## Tags *(required)*

`["@api", "@regression", "@serving"]`

`@serving` is the lane selector; the configuration is unreachable without it. **No
`@stable`** — no scheduled `@serving` lane, so the tag would mark a test that never runs
(#1010).

---

## Precondition *(required)*

```bash
LANGFLOW_SERVING_REQUIRED=1 ./scripts/start-langflow-serving-identity.sh
```

Reads back `serving_end_user_header='X-End-User-Id'`, `serving_trust_proxy_headers=True`,
`serving_end_user_required=True`.

**This spec provokes `401`s on purpose and still needs no `page.allowHttpErrors()`.** The
fixture's HTTP monitor is a `page.on("response")` listener, and the whole spec is
`request`-fixture calls, which never reach it — so there is nothing to quieten and nothing to
declare. The instinct to declare it anyway made it into a first draft of
`api/flows/workflows-v2-job-lifecycle.spec.ts` (#1575) before being measured away. The honest
consequence is worth stating rather than leaving implicit: checklist step 4 ("no
`🚨 Backend Error:` logged") carries no information for this spec, so the refusals are
evidence only because they are asserted directly.

The configuration is not readable through any API, so step 1 probes it behaviourally.

---

## Step by step *(required)*

1. **Guard the configuration, fail-closed.** Create the keyless `Chat Input → Chat Output`
   flow, then `POST /api/v2/workflows` with **no** identity header. It must answer `401` with
   `detail.code === "END_USER_IDENTITY_REQUIRED"`. A `200` means the instance is not in the
   required state — the message names which sibling container it looks like (session verbatim
   ⇒ stock; `anon::` ⇒ untrusted; `<probe>::<session>` ⇒ trusted-but-not-required) and the
   invocation that produces this one.
2. **v2 — identified runs, identity-less and blank refused.** On the flow from step 1:
   `X-End-User-Id: alice` answers `200` reporting `alice::S` and its 2 rows land in
   `alice::S`; no header answers `401`; `X-End-User-Id: "   "` answers `401`. Both refusals
   carry the same `code`, and both messages contain the configured header name
   `X-End-User-Id`.
3. **v1 — the same refusal on the other surface.** Mint an `x-api-key`; `POST /api/v1/run/{id}`
   with no header answers `401` with the same `code`; with `X-End-User-Id: alice` it answers
   `200` reporting `alice::<session>`.
4. **Cleanup.** `afterAll` deletes every recorded flow id and revokes the minted key.

---

## Validation criterion *(required)*

- Both surfaces refuse an identity-less request with `401` and
  `code: "END_USER_IDENTITY_REQUIRED"`, and both accept an identified one with `200` and a
  scoped session — so the guard is shown to discriminate, not merely to refuse.
- Every refusal message contains the configured header name.
- A whitespace-only value is refused exactly like an absent one.
- The configuration guard fails, naming the state found, when pointed at any sibling
  container.

**Force-fail evidence:** the mutation that matters is asserting `200` where the contract says
`401` — the reading a re-opened instance produces. Flipping the accepted request to expect a
refusal is the complementary half and covers the refuse-everything regression.

---

## What this does not cover *(and why)*

- **Non-default header names.** The spec asserts the message *names* the configured header
  but runs only with the script's `X-End-User-Id`; proving the message tracks a renamed
  header would need a fourth container state for one assertion. Recorded here as the known
  limit of that assertion rather than left implicit.
- **Rate limiting or auth interaction with the refusal.** `401` here is the serving-identity
  guard, not authentication; the request carries valid credentials throughout.
- The trusted and untrusted rows — the two sibling files.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/services/settings/groups/security.py` — `serving_end_user_required`
  alongside the header and trust settings.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — raises the
  `END_USER_IDENTITY_REQUIRED` refusal.
- **Langflow API** — `GET /api/v1/auto_login`, `POST /api/v1/flows/`, `POST /api/v1/api_key/`,
  `POST /api/v2/workflows`, `POST /api/v1/run/{id}`, `GET /api/v1/monitor/messages`,
  `DELETE /api/v1/flows/{id}`.
- **`scripts/start-langflow-serving-identity.sh`** with `LANGFLOW_SERVING_REQUIRED=1`, and the
  `PW_SERVING_IDENTITY` lane — both from #1582.
- **No provider key, no model, no external network.**
