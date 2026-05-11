# Wikey Wallet Skill

SSP agent-child skill for any AI agent that supports `.skill` packages. Provides the Secure Signing Process (SSP) operational guide as an agent system prompt and installs the required binaries (`signing-server`, `ssp-util`, `wallet-cli`).

## Requirements

- Node.js 22+
- An AI agent with `.skill` package support

## Install

### Method 1 — Tell your agent

```
Download https://github.com/ronmasuary/Wikey-Wallet-Skill/releases/latest/download/wikey-wallet-skill.skill
to /tmp/wikey-wallet-skill.skill then install it
```

### Method 2 — HTTP API

```bash
curl -L https://github.com/ronmasuary/Wikey-Wallet-Skill/releases/latest/download/wikey-wallet-skill.skill \
  -o /tmp/wikey-wallet-skill.skill

curl -X POST http://localhost:3456/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"path":"/tmp/wikey-wallet-skill.skill"}'
```

> **Note:** Binaries (`signing-server`, `ssp-util`) are downloaded from the GitLab package registry during install. `wallet-cli` is installed globally via npm. On slow connections the install script may take over a minute.

## What this skill does

Once installed, the agent gains full operational knowledge of:

- Spawning and managing the SSP signing server
- Signing and broadcasting transactions on Omnistar via wallet-cli
- Computing HMAC proofs with ssp-util
- Managing keys, safes, policies, and profiles
- Querying balances and assets

## License

MIT — see [LICENSE](LICENSE)
