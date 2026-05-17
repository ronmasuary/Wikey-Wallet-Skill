# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
