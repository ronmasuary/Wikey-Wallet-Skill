# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Bumped skill version from 2.0.0 to 2.1.4 (`src/index.ts` default export and `package.json`).

### Added
- Pure-function unit tests via `node:test` + `tsx` (`buildPolicyQueue`, `buildEditHelpersQueue`, `extractUsernameFromProfile`).
- `npm test` script.
- GitHub Actions CI workflow running build + tests on PRs and pushes to `beta`/`main`.

### Docs
- `SKILL.md`: corrected `create-policy` / `edit-policy` prompt strings, fixed `tx vote` valid values, documented `tx request-recovery` `--username` requirement and skill-side auto-resolution.

## [1.0.0] - 2026-05-11

### Added
- Initial release of `wikey-wallet-skill` as a standalone distributable `.skill` package
- SSP agent-child operational guide (SKILL.md system prompt)
- `install-child-mode.js` asset script — downloads signing-server, ssp-util, and wallet-cli
- GitHub Actions CI: builds and publishes `wikey-wallet-skill.skill` on tag push
- GitLab → GitHub push mirror for distribution via GitHub Releases
