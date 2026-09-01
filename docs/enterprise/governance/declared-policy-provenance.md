# Enterprise — The History Is the Only Record That the Deployment Declared Anything

**Last validated:** Langflow Enterprise 1.12.0 (image built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`environment-policy-authority` covers the defect: a runtime write **wins** against a policy the
deployment declared. #1559 extends it — the win is **permanent**, the environment variable is
consulted at initialization only, and nothing in the current state says the deployment is being
ignored.

This spec covers the half of that which is neither a defect nor already asserted: **where the
declaration survives, and what depends on it surviving.**

### Measured

Instance started with `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText`:

| Step | `GET /api/v1/policy-bundle` |
|---|---|
| after boot | `revision: 2`, `source: "environment"`, `blocked_component_keys: ["CombineText"]` |
| `PUT /api/v1/catalog-policy/components {"blocked":["Prompt"]}` → `200` | `revision: 3`, `source: "api"`, `["Prompt"]` |

and then, asked which surface still names `CombineText`:

| Surface | Names the superseded declaration |
|---|---|
| `/api/v1/policy-bundle` | **no** |
| `/api/v1/catalog-policy/components` | **no** |
| `/api/v1/policy-bundle/history` | **yes** — `(3, api, ["Prompt"])`, `(2, environment, ["CombineText"])`, `(1, migration, [])` |

## Why this is worth a test of its own

Not because the history is nice to have. Because **this suite's own gate depends on it, and
nothing asserts it.**

`requireEnvironmentPolicy` — the gate every spec in `enterprise/governance/` opens with — decides
whether an instance has an operator-declared policy by reading
`/api/v1/policy-bundle/history` and filtering for `source === "environment"`
(`readDeclaredRevision`). It has to: the live bundle cannot answer the question, since a runtime
write leaves it reporting `source: "api"` and the same shape an API-written policy would have.

So if history stopped retaining the environment revision, the gate would return `undefined`,
`test.skip` would fire, and **every Enterprise governance spec would skip** — with a message
blaming the reader's start command for an instance that is in fact configured correctly. A green
all-skip, misattributed to the environment. That is the exact failure mode #1010 and #1012 exist
to prevent, and it would arrive through a product change no existing test would notice.

The OSS spec `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning` does read
this endpoint, but asserts only that a **revision number** appears. It says nothing about whether
the entry retains its `source` or the keys that revision declared — which is the whole content the
gate reads.

## The second test, and why it is not a pinned defect

Asserting that **history is the only** surface retaining the declaration is what makes the first
test's claim exact rather than decorative. Without it, "history keeps it" reads as a nicety; with
it, the pair says *this is the sole record, so losing it loses the fact.*

It also means a future build that **fixes** #1559 by surfacing the disagreement in the current
state will turn this test red. That is the correct signal, not a false alarm: the premise this spec
is built on would have changed, and both the assertion and this document should move together. The
same both-directions contract the fixture applies to `page.expectKnownHttpError()`.

## Tags *(required)*

`@enterprise` `@regression` `@governance`

Matching its sibling `environment-policy-authority`, which owns the authority question this
extends. No `@api` — the sibling carries the same shape without it.

No `@stable`: there is no scheduled Enterprise lane (#1010).

## Step by step *(required)*

1. Authenticate, and require the deployment to have declared a component blocklist —
   `requireEnvironmentPolicy`, which skips naming the start command otherwise.
2. Record the declared revision and its keys from the history.
3. Write a **different** blocklist through the admin API and confirm it took: the live bundle's
   revision rises and its `source` becomes `api`.
4. Assert the history still holds the environment revision, **with `source: "environment"` and the
   keys the deployment declared** — not merely a revision number.
5. Assert the current-state surfaces name only the API values, so the history is the only record.
6. Restore the declared blocklist through the admin API, so a red run does not leave the instance
   permissive for whatever reads the catalog next.

## Validation criterion *(required)*

Fails when the history stops retaining a superseded environment revision, or retains it without
its source or its declared keys — the content `requireEnvironmentPolicy` reads to tell a declared
instance from an API-written one.

## External dependencies *(required)*

- A Langflow **Enterprise** instance whose **deployment** declares a component blocklist:
  `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`.
  The gate skips, naming this command, on any other instance — including one where the same
  blocklist was written through the API, which is a different thing and the case the sibling spec
  exists to separate.
- No browser, no LLM provider, no network egress, no licence, no additional login.
- No Langflow **source** paths: the Enterprise backend is not in `langflow-ai/langflow`.

## Notes

The restore writes the declared keys back through the admin API. It cannot restore the
*provenance* — that is the defect #1559 records, and the reason the history matters at all: after
the first admin write, `source: "environment"` never returns for that revision, and the deployment's
declaration exists nowhere else.
