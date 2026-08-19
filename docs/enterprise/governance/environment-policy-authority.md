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

### Why every knob is asserted, rather than one and an inference

The invariant is a property of the **surface**, not of a key: whether a runtime
write can undo what the operator declared. Proving it for the component blocklist
and inferring the other three is exactly the inference this product area has
already shown to be unsafe. `governance/catalog-policy/template-blocklist-enforcement`
measures it directly: blocking a template by the display name an operator reads in
the UI is accepted and enforces nothing, while blocking by the internal `name_key`
works. Two inputs, one endpoint, opposite outcomes, and no error either way.

So each knob is asserted on the surface a user would actually notice:

| Knob | Declared as | Surface the assertion reads |
|---|---|---|
| Component blocklist | `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST` | `GET /api/v1/all` — the palette |
| Template blocklist | `LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST` | `GET /api/v1/flows/basic_examples/` |
| Provider allowlist | `LANGFLOW_MODEL_PROVIDER_ALLOWLIST` | `GET /api/v1/models/providers` |
| Model blocklist | `LANGFLOW_MODEL_BLOCKLIST` | `GET /api/v1/policy-bundle` |

The template key is the **internal** one (`saas_pricing`, not `SaaS Pricing`) for
the reason above — a display name would leave the spec green while blocking
nothing, which is the false negative it exists to prevent.

The model blocklist reads the **bundle** and not a listing, and that asymmetry is
deliberate rather than an omission. `GET /api/v1/models` filters by provider and
never by model: its handler calls the policy's `allows`/`filter`, and the only
consumer of the per-model predicate `allows_model` is the option builder behind a
component's model dropdown. Asserting that a blocked model is absent from the REST
listing would assert something the product never promised there, and would go red
for a reason that has nothing to do with authority.

### The shape of each assertion

Each knob is asserted in three parts, which is what makes a failure diagnosable
rather than merely red:

1. **Provenance is reported.** `GET /api/v1/policy-bundle` says `source:
   "environment"`, and the per-resource read agrees by reporting
   `managed_externally: true`. Clients gate the "read-only, managed by your
   operator" state on that field.
2. **The write is refused.** The runtime `PUT` does not succeed while the policy
   is externally owned.
3. **Enforcement survives the attempt.** Whatever the API answered, the surface
   still reflects what the deployment declared. This is the assertion that
   matters: a refusal that leaves the policy cleared anyway would satisfy (2) and
   still be a governance escape.

> **Known state.** This spec is **expected to fail** on current Enterprise
> builds. The failure is a product finding, tracked outside this repository; it
> is not a defect in the spec, and the assertions must not be relaxed to make the
> lane green.
>
> It also needs a **fresh container** per run: the assertions read the policy's
> declared source, and a previous run's write changes it — a stale instance fails
> the spec for a different reason than the one it exists for. The gate skips
> rather than failing when it sees a policy whose source is no longer the
> environment, so that stale state reads as "not the instance this spec needs"
> instead of as a product defect.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@governance`

Reuses `@governance` rather than adding an Enterprise-only functional tag: it is
the same product area as `governance/catalog-policy/`, and the `@enterprise`
lane already separates the editions.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here
would silently never run (#1010).

## Step by step *(required)*

Every test begins the same way — authenticate with password login, then require
the instance to carry the declared policy, skipping and naming the start command
otherwise.

1. **Component blocklist is reported as externally managed.** `GET
   /api/v1/policy-bundle` → `source` is `environment`;
   `GET /api/v1/catalog-policy/components` → `managed_externally` is `true`.
2. **A runtime write cannot clear the component blocklist.** `PUT
   /api/v1/catalog-policy/components` with an empty set → not a success status;
   `GET /api/v1/all` → the component is still absent. Restore on the way out.
3. **A runtime write cannot clear the template blocklist.** Baseline: the
   template is absent from `GET /api/v1/flows/basic_examples/`. `PUT
   /api/v1/catalog-policy/templates` with an empty set → not a success status,
   `managed_externally` is `true`, and the template is still absent afterwards.
   Restore on the way out.
4. **A runtime write cannot widen the provider allowlist.** Baseline: `GET
   /api/v1/models/providers` lists only the approved provider. `PUT
   /api/v1/model-provider-policy` adding a second provider → not a success
   status, and the listing is unchanged afterwards. Restore on the way out.
5. **A runtime write cannot clear the model blocklist.** `PUT
   /api/v1/policy-bundle` with `blocked_model_keys: []` and the rest of the
   bundle carried over → not a success status, and the bundle still carries the
   declared key. Restore on the way out.

## Validation criterion *(required)*

Fails when deployment-declared policy can be observed, overridden or defeated at
runtime: a policy whose source is the environment reported as locally managed, an
accepted write, or a surface that reverts to the unconstrained state after the
attempt.

## External dependencies *(required)*

- A Langflow **Enterprise** instance started with all four knobs declared:

  ```
  LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText \
  LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST=saas_pricing \
  LANGFLOW_MODEL_PROVIDER_ALLOWLIST=openai \
  LANGFLOW_MODEL_BLOCKLIST=gpt-4o-mini \
  ./scripts/start-langflow-enterprise.sh
  ```

  Each test skips independently when its own knob is missing, so a partial
  declaration runs the part it can rather than failing.
- No LLM provider and no network egress. The provider allowlist is asserted on
  the catalog listing, which needs no credential.
