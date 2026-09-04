# API Models — the write surface, on a throwaway user (`default_model`, `enabled_models`, `validate-provider`)

**File:** `tests/tests-automations/regression/api/models/api-models-selection.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1709 (Wave 7 — OSS API coverage, `models` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The four write operations of the family, none of which anything drives today:
`POST`/`DELETE /models/default_model`, `POST /models/enabled_models`, and
`POST /models/validate-provider`.

**The design decision that makes this `@stable` instead of `@destructive`, measured in
both directions.** These endpoints do not write instance settings — they write **the
calling user's global variables** (`variable_service.get_variable_object(user_id=current_user.id, …)`).
On the shared superuser that is still contention: the `core-functionality/model-provider`
specs read this state, so a set-and-restore window would be visible to a parallel worker.
So this file **creates its own user**, acts as it, and deletes it. Proven on
`1.13.0.dev0`: as the throwaway user `POST /default_model` returns the value and the
**superuser still reads `{"default_model": null}`** at the same moment.

The fixture path, measured (this is also why `users` is not a blocker for this file):

| Step | Answer |
|---|---|
| `POST /api/v1/users/` `{username, password}` (as superuser) | `201`, and the new user is **`is_active: false`** |
| `PATCH /api/v1/users/{id}` `{is_active: true}` (as superuser) | `200` with `is_active: true` |
| `POST /api/v1/login` — **form-encoded**, `username` + `password` | `200 {access_token, refresh_token, token_type}` |
| `DELETE /api/v1/users/{id}` (as superuser) | `200 {"detail":"User deleted"}` |

Measured contracts of the four operations:

| Operation | Answer |
|---|---|
| `POST /models/validate-provider` `{provider, variables: {KEY: value}}` with a **fake** key | **`200 {"valid": false, "error": "Invalid API key for OpenAI"}`** — the verdict is in the **body**; a status-only assertion certifies a dead credential |
| `POST /models/validate-provider` with an unknown provider | `404 {"detail":"Model provider not found"}` |
| `POST /models/validate-provider` `{"provider":""}` | `422`, `loc ["body","provider"]`, `type: "value_error"`, msg `Provider cannot be empty` |
| `POST /models/validate-provider` without `variables` | `422`, `loc ["body","variables"]`, `type: "missing"` |
| `POST /models/default_model` `{model_name, provider, model_type}` | `200` echoing `{"default_model": {model_name, provider, model_type}}`; `GET` reads it back |
| `POST /models/default_model` with `model_type: "nope"` | `422`, msg `model_type must be 'language' or 'embedding'` |
| `POST /models/default_model` with `provider: ""` | `422`, `Field cannot be empty` |
| `POST /models/default_model` with an unknown provider | `404 {"detail":"Model provider not found"}` |
| `POST /models/default_model` with a **nonexistent model name** on a real provider | **`200`, and it persists** — only the *provider* is validated, never the model. Pinned as measured behaviour: a default model can be set to a string no provider serves |
| `DELETE /models/default_model` | **`200 {"default_model": null}`** — not `204` |
| `POST /models/enabled_models` with a single object body | `422`, `loc ["body"]`, `type: "list_type"` — the body is a **list** of `{provider, model_id, enabled, model_type?}` |
| `POST /models/enabled_models` `[{provider, model_id, enabled: false}]` | `200 {"disabled_models": ["OpenAI::<model_id>"], "enabled_models": []}` — the write stores a **disabled set**, namespaced `provider::model_id` |
| `POST /models/enabled_models` `[{… enabled: true}]` on an **unconfigured** provider | `200` with **both sets empty** — the disable is lifted, and the enable itself is not stored: there is nothing to enable while the provider has no credential |
| `POST /models/enabled_models` `[]` | `200` echoing both sets **without changing them** — measured: an existing disable survives it, so this is the only read of the stored sets (there is no `GET` for them) |
| `GET /models/enabled_models` flag for that model | stays `false` through all of the above — **the derived flag is computed from the provider's configured state, not from the stored sets** |

---

## Tags *(required)*

`@api` `@model-provider` `@stable`

`@stable` **because of the throwaway user**: no instance-global state is touched, the
shared superuser's model settings are never written, and the whole file is keyless (the
`validate-provider` assertions are all negative or refusals — a *valid* verdict would
need a funded key and is deliberately out of scope).

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`. `beforeAll`
creates and activates the throwaway user and logs in as it; `afterAll` deletes the user
(which takes its variables with it), and the deletion is asserted rather than ignored.
One login per file keeps the OSS `5/min per IP` login budget intact.

**Test 1 — `validating a provider answers 200 with the verdict in the body`**
1. `POST validate-provider {provider: "OpenAI", variables: {OPENAI_API_KEY: "sk-not-a-real-key"}}`
   → `200`, `valid === false`, `error` naming the provider.
2. Unknown provider → `404 "Model provider not found"`.
3. `provider: ""` → `422` on `["body","provider"]`; no `variables` → `422` on
   `["body","variables"]`.

**Test 2 — `the default model round-trips per user, and only the provider is validated`**
1. As the throwaway user: `GET default_model` → `null`.
2. `POST` a real provider with a **nonexistent** model name → `200`, echoed;
   `GET` returns it (the laxity, pinned).
3. **As the superuser**, `GET default_model` → still `null` — the per-user proof.
4. `POST` with `model_type: "nope"` → `422`; with `provider: ""` → `422`; with an
   unknown provider → `404`.
5. Set an **embedding** default, then `GET ?model_type=<garbage>` → the **embedding**
   value comes back (the route branches `language` vs everything else).
6. `DELETE default_model` → `200 {"default_model": null}`; `GET` agrees, for both types.

**Test 3 — `the enabled_models write stores a DISABLED set, and it is per user`**
1. `POST enabled_models` with one `{provider, model_id, enabled}` **object** → `422`
   `list_type` on `["body"]`.
2. The stored sets start empty (read with `POST []`); a `[{… enabled: false}]` write →
   `200` with `disabled_models === ["OpenAI::<model_id>"]`.
3. **At that moment**, the shared superuser's stored sets still read `[]` — the
   isolation proof, and the reason this file is not `@destructive`.
4. `[{… enabled: true}]` → `200` with **both sets empty**: the disable is lifted and
   the enable is not recorded on an unconfigured provider.
5. `GET enabled_models` reads `false` for that model throughout — the derived flag and
   the stored sets are different things, which is the finding this test pins.

The first version of this test asserted a "flip" of the derived flag and **failed
against a healthy instance** (`200` on the write, flag still `false`). That failure is
what produced the contract above: the write is a *disable* store, and the flag is
derived from whether the provider is configured.

---

## Validation criterion *(required)*

The three tests pass three consecutive times at `--retries=0 --workers=1`, with
`validate-provider` asserted on `valid`/`error` in the **body** (never on the `200`),
the per-user isolation asserted from **both** principals in the same test, the
`model_type` misroute asserted by reading back an embedding default, and the declared
coverage — `POST` and `DELETE /api/v1/models/default_model`,
`POST /api/v1/models/enabled_models`, `POST /api/v1/models/validate-provider`, plus the
three `users` operations and `POST /api/v1/login` the fixture drives and asserts —
matching what the fixture recorded.

**The users and login operations the fixture drives are deliberately NOT declared.**
They run in `beforeAll`, whose `request` is not the test-scoped context the
`apiCoverage` fixture patches, so a declaration would be unfulfilled and would fail the
test — the same rule that keeps `page`-driven traffic from earning credit. They are
asserted all the same (`201` plus `is_active: false`, the activation, the form-encoded
login, `200 {"detail":"User deleted"}`), and `/api/v1/users` gets its own issue.

The shared superuser's `default_model` reads `null` and its stored model sets read `[]`
after the run, and the throwaway user is gone.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL` with a superuser able to
  create users (every OSS lane: `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`).
- `src/backend/base/langflow/api/v1/models.py` — the four write routes plus
  `DefaultModelRequest`, `ModelStatusUpdate`, `ValidateProviderRequest`.
- `src/backend/base/langflow/api/v1/users.py` — the throwaway-user fixture path.
- `src/backend/base/langflow/services/variable/service.py` — where the per-user state
  actually lives, and the reason this file is not `@destructive`.
- No provider key (every credential assertion here is a negative), no model, no network
  egress beyond the instance.
