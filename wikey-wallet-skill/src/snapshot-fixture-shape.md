# snapshot-fixture.json — shape contract

Captured from `wallet-cli query snapshot --address <profileAddr>` (wallet-cli 1.0.0) on the
agent profile `omnistar1e27zadsdt7y0cl7zj95d2n7d7a0ygexkvdhqf4`. The leading stdout URL line
emitted by the CLI is stripped; only the JSON body is committed.

## Contract (as captured — corrected from plan)

```
{ success, data: { address, snapshot[] } }

data.snapshot[]                          ← array of SAFES (the element IS the safe; no `.safe` wrapper)
  { address, name, isMain, balance, assets, lastActive,
    groups[]
      group: { id, name, class, isDeleted, isValid,
               nestedObjects[], nestedPolicies[], nestedUsers[], object, process } }
        nestedObject: { class, id, isDeleted, isValid, name, object, process }
          object: { class, id, SIGNATURE, parentGroup, public_key, ... }
```

**Plan said** `data.snapshot[].safe.{address,name,groups[]...}`. The real shape has **no `.safe`
wrapper** — each `snapshot[]` element directly carries `address`, `name`, `groups[]`. Resolver
code matches `snapshot[i].address === destination`.

## Classes observed in `nestedObjects[].class`

`user`, `policy`, `group`, `profile`, `transaction`, `execution`, `vote`.

## Invariants verified against this fixture

- Soft-deleted entries **do appear** with `isDeleted: true` (2 present: user `1b95e3e7-…`,
  policy `cb691d75-…`).
- `id` is **not** always a UUID — genesis user id is `<profileAddr>-Primary`; genesis policy
  ids are `policy-genesis`, `policy-profile`, etc. Resolvers must NOT validate UUID format.
- `nestedObject.id === nestedObject.object.id` for the rows checked.

## Invariant NOT verifiable from this fixture

- **id-uniqueness per group membership** (a user in >1 group gets distinct ids): this profile
  has a single safe with a single group (`Primary`); all `parentGroup === "Primary"`. The
  multi-group case cannot be exercised here. Phase 1b's "first match wins / no multi-match
  guard" rests on this asserted invariant, not on fixture evidence. Refresh with a multi-group
  profile if stronger coverage is needed.

## Known fixture rows (for tests — refresh when regenerated)

- Live user: `a6c3dccb-bfe5-4f08-835b-72437b3bf4da`, `parentGroup=Primary`, SIGNATURE starts `41F0435A…`.
- Deleted user: `1b95e3e7-ca38-4446-8426-e3b8176679aa`, `isDeleted=true`.
- Genesis user: `omnistar1e27zadsdt7y0cl7zj95d2n7d7a0ygexkvdhqf4-Primary` (non-UUID).
- Live policy: `policy-genesis`, `parentGroup=Primary`.
- Deleted policy: `cb691d75-3cce-46de-ac38-243f370b8912`, `isDeleted=true`.
- Safe address: `omnistar1lveyec7dqdt7ypad3fxj0y8wxsyjdjx7vq70n2` (name `wally.a_safe`).
