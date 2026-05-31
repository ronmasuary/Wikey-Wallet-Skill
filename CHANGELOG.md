# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.1] - 2026-05-31

### Fixed
- Skill manifest `version` was hardcoded to `2.2.0` in the default export while `package.json` read `3.0.0` — bumped to `3.0.1` and kept in sync.

### Changed
- `delete-user` / `delete-policy` docs, tool descriptions, and system prompt now state explicitly that **a successful broadcast is not a completed deletion**. These actions are vote-governed: `code: 0` only creates a pending `deleteObject` request. In a single-member group it auto-applies; in a group with ≥2 users it stays pending (target keeps `isDeleted: false`, with a `pending_objects[]` deleteObject entry) until the voting threshold is met. Agents must re-query `wallet_snapshot` and check `isDeleted` rather than inferring success from the tx code, and must not re-broadcast (which only stacks duplicate pending requests).

## [3.0.0] - 2026-05-31

### Changed
- **BREAKING — `wallet_tx_delete_user` now takes `{destination, userId}`** instead of `{destination, user, group?}`. `userId` is the user-object id from `wallet_snapshot` (`safe.groups[].nestedObjects[]` where `class === 'user'`), not an `omnistar1…` address. The skill resolves `--signature` and `--parent-group` from the profile snapshot rather than `query profile`. A non-user id errors with the list of available user ids; an already-deleted user id errors "already deleted". Older prompts passing `user`/`group` get a schema-validation error.
- **BREAKING — `wallet_tx_delete_policy` now takes `{destination, policyId}`** and no longer accepts a `signature` argument. `policyId` is the policy-object id from `wallet_snapshot` (`class === 'policy'`). The skill resolves `--signature` and `--parent-group` from the snapshot. **Regression fix:** wallet-cli's `--parent-group` defaults to `Primary`, so policies in non-Primary groups were silently mis-targeted; the resolver now forwards the policy's real parent group. A non-policy id errors with the list of available policy ids; an already-deleted policy id errors "already deleted".
- `wallet_snapshot` tool description clarified: takes a **profile** address (defaults to configured profile), returns a `safe[]` list; each safe exposes `groups[].nestedObjects[]` keyed by class.

- `wallet_tx_create_user` group resolution now reads from the profile snapshot instead of `query profile`. **Behavior change:** soft-deleted groups (`isDeleted: true`) are excluded — they previously appeared in profile output and could be selected. No agent-facing schema change.

- Operating Rules: explicit prohibition on **tool substitution** — never swap in a different wallet tool (or a raw `wallet-cli` call) to route around a failing tool; quote the error and stop.

### Added
- `src/snapshotResolver.ts` — snapshot-based resolution (`parseSnapshot`, `findSafe`, `extractGroupsFromSafe`, `resolveCreateUserTarget`, `resolveUserDeletion`, `resolvePolicyDeletion`) with `node:test` coverage, including an end-to-end test against the committed `src/snapshot-fixture.json`.
- `src/snapshot-fixture.json` + `src/snapshot-fixture-shape.md` — captured snapshot shape contract guarding against wallet-cli upstream drift.

### Removed
- `src/userResolver.ts` and `src/userResolver.test.ts` — superseded by `snapshotResolver.ts`; all consumers migrated.

## [2.2.0] - 2026-05-18

### Added
- `wallet_tx_create_user` — add a user to a safe's group. Resolves `--parent-group` from the safe's profile when the safe has one group; rejects group **names** (only the literal `Primary` or a UUID id is accepted); rejects `user` values that aren't an `omnistar1…` address.
- `wallet_tx_delete_user` — remove a user from a safe's group. Takes the target's `omnistar1…` address and resolves `--user-id`, `--signature`, and `--parent-group` from the safe's profile. Errors when the address appears in multiple groups unless `group` (an id) disambiguates.
- `src/userResolver.ts` — pure profile-parsing + resolution helpers (`parseProfile`, `extractUsersFromProfile`, `extractGroupsFromProfile`, `resolveCreateUserTarget`, `resolveDeleteUserTarget`) with `node:test` unit coverage.

### Notes
- Hard contract surfaced in tool descriptions, `SKILL.md`, and the system prompt: users go to a **safe's** groups, never a profile's groups; `group` is a group **ID**, never a name.
- Both tools use `runSigningPrompted` with an empty queue — same shape as `wallet_tx_delete_policy`, so the stdin-reader-per-prompt issue does not apply.
- `add-group` is upstream-pending in wallet-cli and out of scope for this release.

## [2.1.4] - 2026-05-18

### Fixed
- `wallet_tx_create_policy` / `wallet_tx_edit_policy`: 60s hang. wallet-cli opens a new readline per prompt; the old `runSigning` wrote all `preProofInputs` upfront and only the first line was readable. Replaced with prompt-driven state machine (`runSigningPrompted` + `buildPolicyQueue`).
- `wallet_tx_vote`: missing answer to wallet-cli's `Add another vote entry? (y/n):` prompt caused a 60s hang. Skill now auto-answers `n`.
- `wallet_tx_request_recovery`: wallet-cli requires `--username` but the tool never passed it. Schema now accepts `username` or `oldAddress` (resolves via `query profile`, reads `.data.profile.name`).
- `wallet_tx_vote` tool description: vote enum reduced to `YES`/`NO` (wallet-cli does not accept `ABSTAIN`).

### Changed
- Consolidated `runSigning` and `runSigningEditHelpers` into a single `runSigningPrompted` runner with per-prompt watchdog (30s default) and overall cap (120s).
- Bumped skill version to 2.1.4 (`src/index.ts` default export and `package.json`).

### Added
- Pure-function unit tests via `node:test` + `tsx` (`buildPolicyQueue`, `buildEditHelpersQueue`, `extractUsernameFromProfile`).
- `npm test` script.
- GitHub Actions CI workflow running build + tests on PRs and pushes to `beta`/`main`.

### Docs
- `SKILL.md`: corrected `create-policy` / `edit-policy` prompt strings, fixed `tx vote` valid values, documented `tx request-recovery` `--username` requirement and skill-side auto-resolution.

## [2.1.1] - 2026-05-17

### Fixed
- `runSigningEditHelpers`: threshold prompt match broken — `ends('1-N:')` never matched dynamic `1-2:` output (primary hang cause)
- `runSigningEditHelpers`: add 90s timeout; Wally could hang indefinitely on any prompt mismatch
- `runSigningEditHelpers`: ANSI escape stripping on stderr (defensive)
- `runSigningEditHelpers`: helper-not-found now hard-rejects instead of silently removing first helper
- `computeProof`: add 20s timeout + SIGKILL fallback at T+22s (compiled binary may ignore SIGTERM)
- `runQuery`: add 30s timeout via `execFile` option
- `runSigning`: add 60s timeout; fix double-reject when proof computation fails
- `runHmacRotation`: inner `ssp-util rotate` spawn now has 10s per-attempt timeout — deadline check was hang-blind before

## [1.0.0] - 2026-05-11

### Added
- Initial release of `wikey-wallet-skill` as a standalone distributable `.skill` package
- SSP agent-child operational guide (SKILL.md system prompt)
- `install-child-mode.js` asset script — downloads signing-server, ssp-util, and wallet-cli
- GitHub Actions CI: builds and publishes `wikey-wallet-skill.skill` on tag push
- GitLab → GitHub push mirror for distribution via GitHub Releases
