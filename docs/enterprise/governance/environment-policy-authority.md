# Enterprise — Environment-Declared Policy Is Authoritative

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## Relationship to `governance/catalog-policy/`

`regression/governance/catalog-policy/` covers the surface Langflow 1.12 ships in
**OSS**: write a blocklist through the admin API, and the component leaves the
palette while the write path refuses it. That is enforcement, and it is proven
there.

This spec covers what that API cannot reach and OSS has no setting for — a policy
the **operator** declared in the deployment, which EE reads at boot. The OSS
checklist section names exactly this as the Enterprise remainder.

## What this test validates *(required)*

When policy comes from the **deployment** — the four governance knobs an operator
sets in the Helm chart, the Operator CR or the container environment — a runtime
admin API call must not be able to undo it.

That is the whole premise of catalog governance in EE. The policy exists so that
whoever runs the platform can constrain what its users may place and execute; a
policy any authenticated administrator can clear at runtime constrains nobody,
and it fails silently, because the container still advertises the blocklist in
its environment while the running instance no longer enforces it.

The spec asserts the invariant in three parts, which is what makes a failure
diagnosable rather than merely red:

1. **Provenance is reported.** `GET /api/v1/policy-bundle` says `source:
   "environment"`, and the per-resource read (`GET /api/v1/catalog-policy/components`)
   agrees by reporting `managed_externally: true`. Clients gate the "read-only,
   managed by your operator" state on that field.
2. **The write is refused.** `PUT /api/v1/catalog-policy/components` does not
   succeed while the policy is externally owned.
3. **Enforcement survives the attempt.** Whatever the API answered, the blocked
   component is still absent from `GET /api/v1/all` afterwards. This is the
   assertion that matters: a refusal that leaves the policy cleared anyway would
   satisfy (2) and still be a governance escape.

> **Known state.** This spec is **expected to fail** on current Enterprise
> builds. The failure is a product finding, tracked outside this repository; it
> is not a defect in the spec, and the assertions must not be relaxed to make the
> lane green.
>
> It also needs a **fresh container** per run: the assertions read the policy's
> declared source, and a previous run's write changes it — a stale instance fails
> the spec for a different reason than the one it exists for.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@governance`

Reuses `@governance` rather than adding an Enterprise-only functional tag: it is
the same product area as `governance/catalog-policy/`, and the `@enterprise`
lane already separates the editions.

## Step by step *(required)*

1. Authenticate with password login.
2. Require the instance to block `CombineText` — skip, naming the start command,
   otherwise.
3. `GET /api/v1/policy-bundle` → `source` is `environment` and
   `blocked_component_keys` contains `CombineText`.
4. `GET /api/v1/catalog-policy/components` → `managed_externally` is `true`.
5. Attempt `PUT /api/v1/catalog-policy/components` with an empty blocked set →
   the response is **not** a success status.
6. `GET /api/v1/all` → `CombineText` is still absent.
7. Restore: if step 5 did succeed, write the environment's blocked set back, so a
   failing run does not leave the instance in a state that makes the sibling
   specs report a second, derived failure.

## Validation criterion *(required)*

Fails when deployment-declared policy can be observed, overridden or defeated at
runtime: a policy whose source is the environment reported as locally managed, an
accepted write, or a component that reappears in the palette after the attempt.

## External dependencies *(required)*

- A Langflow **Enterprise** instance started with the component blocked:
  `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText ./scripts/start-langflow-enterprise.sh`
- No LLM provider and no network egress.
