# Enterprise — The Recipient's Side of a Share, and Who May Be Offered One

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

Every share test in this directory so far asserts what the target may **do** with a shared
resource. None asserts that the target can **find** it, and none asks who may be offered a
share in the first place. Those are the two routes covered here, plus the capability flag a
client uses to decide whether to render the share control at all.

**Can the recipient find it?** `GET /authz/shared-with-me` is the recipient's view. A share
that grants access but never surfaces is a share nobody uses; one that lingers after
revocation is worse, because the resource is gone and the entry is a dead link.

**Who may be offered as a target — and can the endpoint be used to enumerate the
directory?** `GET /authz/share-targets` is the picker's backing route. Measured, it is
deliberately built against enumeration, and *that* is the property worth pinning:

- `search` is a **required** query parameter with a **two-character minimum** (`?search=`
  answers `422 String should have at least 2 characters`), so there is no "list everyone"
  call.
- A caller who cannot manage the resource's shares gets `404 Resource not found`, not an
  empty list and not a `403` — the same absent-rather-than-forbidden convention the rest of
  the model uses.

A regression making `search` optional, or dropping its minimum, turns the endpoint into a
user-directory dump. Nothing in the suite would notice today, and it would not look like a
failure anywhere: the picker would simply be more helpful.

### Measured

| Call | Answer |
|---|---|
| `shared-with-me`, before any share | `{"total_count": 0, "items": [], "truncated": false}` |
| `shared-with-me`, after a `read` share | one item carrying `resource_type`, `resource_id`, `name`, `owner_username`, `permission_level: "read"` |
| `shared-with-me`, after deleting the share | back to `total_count: 0` |
| `share-targets` as the owner, `search=authz` | `{"users": [...matching...], "teams": []}` |
| `share-targets` as a non-manager | `404 Resource not found` |
| `share-targets` with `search=` | `422`, minimum length named |
| `share-targets/capability` as the owner | `{"can_manage_shares": true}` |
| `share-targets/capability` as a non-manager | `200 {"can_manage_shares": false}` |

The last two rows are a pair worth keeping: `capability` answers `200 false` where
`share-targets` answers `404`. That is coherent rather than inconsistent — the capability
flag is a question about the **caller**, safe to answer, while the target list is a question
about the **resource**, which a non-manager must not learn about. A client needs the first to
render, and must not be given the second.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

Gates on an enforcing instance. The superuser owns a flow created in `beforeAll`; the
directory's shared subject is the recipient.

1. `shared-with-me` as the subject → empty.
2. Superuser shares the flow with the subject, `permission_level: "read"`.
3. `shared-with-me` → exactly one item **for that flow**, matched by `resource_id` rather
   than by list length, carrying the owner and the permission level.
4. Delete the share → `shared-with-me` no longer lists that flow.
5. `share-targets` as the owner with a two-character search → the subject appears among
   `users`.
6. `share-targets` as the subject → `404`.
7. `share-targets` with an empty `search` → `422`, and the message names the minimum.
8. `capability` for both → `true` for the owner, `false` for the subject.

## Validation criterion *(required)*

Fails when a granted share does not reach the recipient's list, when a revoked one stays,
when a non-manager can read the target list, or when `share-targets` becomes callable
without a search term — the last being the one that would otherwise look like an
improvement.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  `PLAYWRIGHT_BASE_URL` at `http://localhost:7891`.
- Zero or one login per run — the directory's shared subject and the cached superuser token.
- No LLM provider, no network egress.

## Notes

Every list assertion is a membership test on `resource_id`. The instance carries other
users' shares and the subject is shared across the directory, so a count would measure
container state.

The search term used is a prefix of the shared subject's generated username, which is
`authz-shared-<timestamp>-<n>` — so the query is meaningful without hardcoding an identity
the fixture regenerates.
