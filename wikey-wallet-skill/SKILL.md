---
name: wikey-wallet-skill
description: >
  Complete operational guide for interacting with the Omnistar blockchain via
  the Secure Signing Process (SSP) in agent-child mode. Use this skill whenever
  the task involves: spawning the SSP signing server, managing blockchain keys
  or safes on Omnistar, signing or broadcasting transactions via wallet-cli,
  computing HMAC proofs with ssp-util, querying profiles/balances/assets,
  creating or editing policies, voting, recovering accounts, or handling any
  wallet-cli command. Also use this skill when the user asks to install the SSP
  agent-child binaries. Trigger on any mention of: SSP, signing-server,
  ssp-util, wallet-cli, Omnistar, omnistar1..., safe, policy, HMAC proof,
  agent-child mode, or Wikey.
---

# SSP Agent-Child Mode — Operational Guide

## Tool Usage

When skill tools are registered, use them for all wallet operations. Never use
`shell_exec` for any wallet operation — all operations have dedicated tools.
`shell_exec` is not a fallback, not a last resort, not acceptable under any
circumstance for wallet work.

Session tools:
- `wallet_session_start` — call once at the beginning of every session before any `wallet_tx_*` or `wallet_notification_configure` tools
- `wallet_session_status` — check if a session is already active before starting a new one

Tools handle the full execution including SSP proof flow for tx commands. The manual
Node.js driver described in "Signing Transactions" is a reference only — it is not
needed when tools are available.

## HMAC Key Rotation

Call `wallet_hmac_rotate` every 15 minutes between requests — never mid-signing-flow.
The skill swaps the key internally; nothing is returned to the agent and no agent-side
action is needed after the call.

Rotation does NOT reset the nonce file. The nonce continues monotonically across rotations.

## SSP Restart

Never restart, kill, or respawn the SSP signing-server process mid-session.
If SSP dies, the session is over — terminate the agent and start a fresh one.
Restarting SSP loses the session HMAC key and likely makes the keystore unrecoverable.

This document is the complete reference for operating the Omnistar blockchain
via the Secure Signing Process (SSP) in **agent-child mode**: the agent spawns
SSP, holds the HMAC key in memory, and drives all chain operations exclusively
through `wallet-cli` and `ssp-util`.

---

## Installation

The installer script is bundled at `assets/install-child-mode.js` (relative to
this SKILL.md). Run it with Node.js 22+:

```bash
node assets/install-child-mode.js
```

Environment overrides (all optional):

| Variable        | Default        | Purpose                              |
|----------------|----------------|--------------------------------------|
| `SSP_VERSION`  | `latest`       | Pin a specific release tag           |
| `SSP_INSTALL_DIR` | `~/.ssp`    | Where binaries are installed         |
| `SSP_CLOUD`    | unset          | Set to `1` for cloud KMS variant     |
| `SSP_BASE_URL` | GitLab registry| Override artifact download base URL  |

Installs: `signing-server`, `ssp-util` (to `~/.ssp/bin`), and `wallet-cli`
(globally via npm). Adds `~/.ssp/bin` to PATH in `.bashrc`/`.zshrc`.

---

## Operating Rules — Read Before Any Action

**Only two tools may interact with SSP and the chain:**
1. `wallet-cli ...` — all blockchain operations (queries, key creation, transactions, broadcasts).
2. `ssp-util proof ...` — HMAC proof computation only.

**Never:**
- Call SSP HTTP endpoints (`/v1/sign`, `/v1/keys`, `/v1/metadata`, etc.) directly via `curl`, `fetch`, `requests`, or any HTTP client.
- Implement HMAC-SHA256 yourself — always shell out to `ssp-util proof`.
- Log, write, persist, or transmit the value of `SSP_HMAC_KEY`.
- Modify, patch, recompile, or replace `wallet-cli` or `ssp-util` in any way (including edits to `node_modules/`, runtime shims, or forked binaries). These are externally-released packages; local changes are invisible to others, get wiped on reinstall, and paper over real problems.
- **Never use `shell_exec` for any wallet operation** — all wallet operations have dedicated tools. `shell_exec` is not a fallback. Do not pass `hmacKey` to any tool; the skill manages it internally.
- **Never substitute a different wallet tool to bypass an error.** If a tool fails, quote the error verbatim and ask the user before trying any alternative tool or raw `wallet-cli` invocation. Example anti-pattern: calling `wallet_tx_delete_policy` with a user's id when `wallet_tx_delete_user` errors — this is an unauthorized tool swap, not a workaround. Same for `wallet_tx_delete_user` with a policy id, or any `wallet-cli` shell call outside the dedicated tools.

### When `wallet-cli` appears broken

Treat the tool as **read-only**. Never edit it to fix a symptom. In order:

1. **Read the error.** `wallet-cli` writes structured JSON errors to stdout on non-zero exit; quote `error.message` back to the user.
2. **Check inputs.** Wrong address, missing `--broadcast`, wrong asset units (see smallCoin rule), stale `--signature`, `--name` used as a CLI flag instead of stdin, etc.
3. **Check versions.** Run `wallet-cli --version` and `signing-server --version`. Version drift is a known failure class — report it and stop.
4. **Check the chain.** RPC reachable? Account funded? Safe validated yet (~30s after broadcast)?
5. **Stop and report.** Surface the exact command, exact error, and what was already checked — then ask the user. Do **not** reach for a different tool to route around the failure (see the tool-substitution rule above) — a failing tool is a stop signal, not a prompt to improvise.

---

## Architecture

```
Agent generates random 32-byte HMAC key
  └── sets SSP_HMAC_KEY=<key> in child process environment only
       └── spawns: signing-server -spawned-by-agent -keystore secure [flags]
            └── SSP reads + clears SSP_HMAC_KEY from env
                 └── SSP enforces HMAC proof on every signing call
                      └── wallet-cli makes those calls; agent drives wallet-cli
```

The agent holds the HMAC key. Responsibilities:
1. Keep the key in memory — never log, write, or print it.
2. Produce a valid HMAC proof **only via `ssp-util proof`** when `wallet-cli` requests one.
3. Erase the key from memory when the session ends.

### Session Startup — Signing Server

**On every session start**, call `wallet_session_start`. The tool handles everything:

1. Kills any existing signing-server
2. Deletes the stale `.ssp-nonce` file (each new SSP session resets the nonce to 0)
3. Generates a fresh HMAC key in memory — never exposed to the agent
4. Spawns signing-server with that key in `SSP_HMAC_KEY` env
5. Waits for SSP to be ready (port probe, max 10s)

Use `wallet_session_status` to check if a session is already active before calling `wallet_session_start`.

**Nonce file across rotations:** The nonce file is NOT deleted on rotation — the nonce continues monotonically across rotations. Only `wallet_session_start` (SSP restart) deletes it.

---

## Spawning SSP

Generate a cryptographically random 32-byte key and set it **only in the child
process environment** — not in the agent's own environment. Always use
`-keystore secure`; production binaries refuse `memory` and `fs`.

**Node.js:**
```js
const key = require('crypto').randomBytes(32).toString('hex');
const child = spawn('signing-server', ['-spawned-by-agent', '-keystore', 'secure'], {
  env: { ...process.env, SSP_HMAC_KEY: key }
});
```

**Python:**
```python
import os, subprocess
key = os.urandom(32).hex()
proc = subprocess.Popen(
  ['signing-server', '-spawned-by-agent', '-keystore', 'secure'],
  env={**os.environ, 'SSP_HMAC_KEY': key}
)
```

**Go:**
```go
key := make([]byte, 32); rand.Read(key)
keyHex := hex.EncodeToString(key)
cmd := exec.Command("signing-server", "-spawned-by-agent", "-keystore", "secure")
cmd.Env = append(os.Environ(), "SSP_HMAC_KEY="+keyHex)
```

---

## Startup Checklist

Run these on first wake-up to orient:

```bash
wallet-cli config show        # Who am I? (address, pubkey, RPC endpoint)
wallet-cli query profile      # My on-chain profile: address, pubkey, policies, linked safes
wallet-cli query balances --address <MY_ADDR>  # OST gas balance on my profile address
```

If `config show` shows an empty address: create a key (see Key Management), share the address with the user, wait for OST funding, then run `tx create-safe` to create your profile and safe on-chain.

---

## Key Concepts

### Profile vs. Safe

Both profile and safe are on-chain safe constructs. The difference is their role.

| | Profile | Safe |
|---|---|---|
| What it is | The key's identity safe on-chain | An asset-holding safe the key operates on behalf of |
| What it holds | Address, pubkey, policies, list of linked safes | Asset balances (BTC/ETH/OST/…), policies, authorized signers |
| How created | Created together with the safe via `tx create-safe` | Created via `tx create-safe` |
| How to query | `wallet-cli query profile` | `wallet-cli query snapshot` (defaults to configured profile) |

When you want to know **"what can I do / what safes do I control?"** → query the profile.
When you want to know **"what does this safe hold / what policies govern it?"** → query the safe.

> **`wallet_snapshot` takes a *profile* address** (defaults to the configured user), not a safe address. It returns a `safe[]` list — find the target safe in the list (`safe.address === destination`) rather than passing a safe address. Each safe has `groups[].nestedObjects[]` keyed by class (`user`, `policy`, `group`, `transaction`, `vote`, …); the `object` of each holds its `SIGNATURE` and `parentGroup`.

### `SIGNATURE` vs. target-chain `transfer_id`

When any command is broadcast to Omnistar, the result is an **Omnistar tx hash**. This hash is stored on every on-chain object as its `SIGNATURE` field, and is what `--signature` flags consume.

Do **not** confuse this with a **target-chain transfer id** (Bitcoin txid, Ethereum tx hash, Solana signature). That id tracks the external transfer in its own chain's explorer and is never passed back to `wallet-cli`.

| What | Source | Used for |
|---|---|---|
| `SIGNATURE` on a snapshot object | Omnistar broadcast result | `--signature` flag on `tx ...` commands |
| Target-chain `transfer_id` | BTC/ETH/SOL/etc. after the safe's transfer executes | Lookup in the target chain's explorer only |

---

## Golden Rules

1. **Never use `--name` or `--description` flags** on `tx create-policy` or `tx edit-policy`. They break JSON encoding. Feed name/description via stdin instead.
2. **Blockchain deletes are soft-deletes only.** Data stays on-chain. Think before broadcasting.
3. **Always `--broadcast` to finalize.** Without it, nothing hits the chain.
4. **Profile address needs OST for every on-chain action.** `ACCOUNT_NOT_FOUND` means the address has never received tokens — the on-chain account doesn't exist yet. Share the address with the user, wait for OST, then proceed.
5. **Resolve usernames before use.** Use the API to convert a username to an address (see Username Resolution).

---

## Signing Transactions

All signing and broadcasting goes through `wallet-cli`. When `wallet-cli`
reaches its `Enter proof:` prompt, compute the proof with `ssp-util proof` and
write the result to `wallet-cli`'s stdin.

### How the proof flow works

- `wallet-cli` emits the sign request to **stderr** in this shape:
  ```
  Sign Request:
  {"requestId":"...","unsignedData":"<hex>","signingPubKey":"<hex>","proof":null}

  Enter proof:
  ```
- Parse that JSON, extract `unsignedData` and `signingPubKey` (both hex).
- Run `ssp-util proof`, **piping the 64-hex HMAC key via stdin** (never as a CLI argument):
  ```bash
  echo "<64-hex-key>" | ssp-util proof \
    --unsigned-data <hex-encoded-unsigned-transaction> \
    --signing-pub-key <hex-encoded-compressed-pubkey-33-bytes> \
    --nonce-file <workspace>/.ssp-nonce
  ```
- Output: `{"nonce": N, "hmac": "<base64-encoded-hmac>"}` — write this **as-is** to `wallet-cli`'s stdin followed by `\n`, then close stdin. Do not re-encode.
- The signed transaction prints on `wallet-cli`'s **stdout**. On non-zero exit, a JSON error on stdout carries `error.message`.
- If the invocation has neither `--sign` nor `--broadcast`, append `--sign`.

No gas/fee input is needed — `wallet-cli` simulates and computes fees itself.

### Minimal Node.js driver

Use this driver for **every** `wallet-cli` command — not just signing. Pass all
expected interactive answers as `stdin_inputs` (array of strings). For commands
with no interactive prompts and no signing, pass an empty array and omit
`--sign`/`--broadcast`.

```js
// driver.mjs — drives one wallet-cli invocation end-to-end.
// Usage: SSP_HMAC_KEY=<64-hex> node driver.mjs tx create-safe --username my-safe --broadcast
// stdin_inputs: pre-feed answers to interactive prompts that appear BEFORE "Enter proof:"
import { spawn } from "node:child_process";

const HMAC_KEY = process.env.SSP_HMAC_KEY;
const NONCE_FILE = process.env.SSP_NONCE_FILE || `${process.cwd()}/.ssp-nonce`;
const args = process.argv.slice(2);
if (!args.includes("--sign") && !args.includes("--broadcast")) args.push("--sign");

function parseSignRequest(buf) {
  const i = buf.indexOf("Sign Request:");
  if (i === -1) return null;
  const tail = buf.slice(i + "Sign Request:".length);
  const start = tail.indexOf("{");
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let k = start; k < tail.length; k++) {
    if (tail[k] === "{") depth++;
    else if (tail[k] === "}" && --depth === 0) { end = k; break; }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(tail.slice(start, end + 1));
    if (obj.unsignedData && obj.signingPubKey) return obj;
  } catch {}
  return null;
}

function computeProof({ unsignedData, signingPubKey }) {
  return new Promise((resolve, reject) => {
    const p = spawn("ssp-util", ["proof",
      "--unsigned-data", unsignedData,
      "--signing-pub-key", signingPubKey,
      "--nonce-file", NONCE_FILE]);
    let out = "", err = "";
    p.stdout.on("data", c => out += c);
    p.stderr.on("data", c => err += c);
    p.on("close", code => code === 0
      ? resolve(out.trim())
      : reject(new Error(`ssp-util exit ${code}: ${err}`)));
    p.stdin.end(HMAC_KEY + "\n");   // key on stdin, never argv
  });
}

const child = spawn("wallet-cli", args, { stdio: ["pipe", "pipe", "pipe"] });
let stderrBuf = "", stdout = "", proofSent = false;

child.stderr.on("data", async chunk => {
  stderrBuf += chunk;
  if (proofSent) return;
  const req = parseSignRequest(stderrBuf);
  if (!req) return;
  proofSent = true;
  const proof = await computeProof(req);
  child.stdin.write(proof + "\n");
  child.stdin.end();
});
child.stdout.on("data", c => stdout += c);
child.on("close", code => {
  if (code === 0) { process.stdout.write(stdout); return; }
  let detail = stderrBuf.slice(-500);
  try {
    const j = JSON.parse(stdout.trim());
    detail = j?.error?.message ?? j?.message ?? detail;
  } catch {}
  console.error(`wallet-cli exit ${code}: ${detail}`);
  process.exit(code);
});
```

> For flows that also need to answer interactive prompts (`Enter policy name`,
> `Your selection`, `Enter threshold`, ...) **before** reaching `Enter proof:`,
> extend the driver with throttled stdin feeding and a hard timeout. The
> canonical reference is `openclaw/src/tools/ssp-sign.ts`.

---

## Interactive Commands — stdin_inputs

`tx create-policy` and `tx edit-policy` are interactive (readline prompts).
Pass inputs as newline-separated strings via stdin. **Never use `--name` or
`--description` as CLI flags.**

### MIXING RULE — which conditions are available

| applyOn value(s) | Available conditions | Name/Description prompts? |
|---|---|---|
| `transaction` (alone) | voting, amount, symbols | YES (empty OK) |
| `group`, `user`, `policy`, `profile` (alone) | voting only | YES |
| any mix (e.g. `transaction,group`) | voting only | YES |

> **`amount` and `symbols` are ONLY available when `--apply-on` is exactly
> `transaction` with no other values.** Any other combination → voting only.

> `profile`'s `allow_updateUserAddress` policy is pre-built. Do NOT pass
> `allow_updateUserAddress` as a condition type. Manage it via `tx edit-helpers`.

> **Name/description prompts always appear** regardless of applyOn — wallet-cli
> always asks. Pass empty string to skip.

### `tx create-policy --apply-on transaction` (alone)

Menu: `1` = Voting, `2` = Amount, `3` = Symbols.

| Prompt | Answer |
|---|---|
| `Your selection:` | comma-separated indices, e.g. `1` or `1,2` or `2,3` or `1,2,3` |
| *(if Voting)* `Enter voting quantity (percentage, 0-100):` | e.g. `100` |
| *(if Amount)* `Enter minimum amount (>= 0):` | e.g. `0` |
| *(if Amount)* `Enter maximum amount (>= <min>):` | e.g. `1000` |
| *(if Symbols)* `Enter symbols (comma-separated, e.g., BTC,ETH,SOL):` | e.g. `BTC,ETH` |
| `Enter policy name (optional, press Enter to skip):` | name or empty |
| `Enter policy description (optional, press Enter to skip):` | description or empty |

### `tx create-policy` — all other applyOn values

Applies to: `group`, `user`, `policy`, `profile` (alone), or any mix including `transaction,group`.
Menu: `1` = Voting (only option).

| Prompt | Answer |
|---|---|
| `Your selection:` | `1` |
| `Enter voting quantity (percentage, 0-100):` | e.g. `100` |
| `Enter policy name (optional, press Enter to skip):` | name or empty |
| `Enter policy description (optional, press Enter to skip):` | description or empty |

### `tx edit-policy` — same prompt order as `create-policy` for the matching applyOn.

`tx delete-policy` — no interactive prompts; flags only.

---

## Key Management

The keypair is generated inside the signing-server and stored in its keystore. The private key never leaves the signing-server — `wallet-cli` only receives the public key and derived address.

```bash
wallet-cli keys create --set-default    # Generate keypair in signing-server, set as default
wallet-cli keys list                    # List all key IDs
wallet-cli keys get --id <keyId>        # Get key details
```

**Onboarding flow:**
1. `wallet-cli keys create --set-default` — keypair created, address returned
2. Share address with user, wait for OST funding
3. `tx create-safe --username NAME --broadcast` — creates both profile and safe on-chain
4. Profile address must maintain OST balance — every subsequent on-chain action costs fees

---

## Account Recovery

Recovery replaces a lost key with a new one. The account username and linked safes carry over — only the signing key changes.

### Helpers

Helpers are trusted addresses designated to approve recovery. They have **no signing authority over the safe, no access to funds, and no governance role**. Do not ask about permissions or roles when managing helpers — there are none. Use `tx edit-helpers` directly.

When recovery is requested, each helper receives a deeplink. Once enough helpers run `tx approve-recovery` to meet the threshold, the chain accepts the new key as the account owner.

### Threshold

The threshold is how many helpers must approve before recovery succeeds.

**Input to CLI:** integer `1–N` (count of helpers required).
**In snapshot:** displayed as percentage (e.g. 2 of 3 helpers → `67%`). Never feed the percentage value as CLI input.

| Threshold | Risk |
|---|---|
| 100% (all helpers) | One helper unavailable → recovery blocked forever |
| 1 (any single helper) | One compromised helper → attacker steals account |
| Majority (e.g. 2 of 3) | Tolerates one lost helper, requires collusion to attack |

Rule: **never set to 100%**. Recommended: majority. Example: 3 helpers → threshold `2`.

### Secured Profile

A profile is secured when helpers cannot easily collude and the threshold tolerates loss:

1. **3+ helpers minimum**
2. **Unrelated to each other** — family, old colleagues, friends from different contexts. Helpers who know each other can collude and steal the account
3. **Threshold = majority, not all** — losing one helper still allows recovery
4. **Threshold > 1** — a single compromised helper cannot hijack the account alone

**Weak (avoid):**
- 1 helper, threshold 1 → single point of failure and attack
- All helpers from same organization → collusion risk
- Threshold 100% → one unavailable helper = permanent lockout

**Strong example:**
```
3 helpers: family member, old colleague, close friend
Threshold: 2
```

### Self-Recovery (Agent Lost Its Own Key)

If the agent's signing key is lost (SSP keystore wiped, machine replaced, etc.):

```
1. wallet-cli keys create --set-default
   → new keypair generated inside signing-server
   → new omnistar1... address

2. Share new address with user — wait for OST funding (gas required)

3. wallet-cli tx request-recovery --broadcast
   → signs with NEW key
   → references ORIGINAL account username (the one being recovered)
   → agent surfaces deeplink to each helper

4. Each helper runs:
   wallet-cli tx approve-recovery --oldaccount ORIGINAL_USERNAME --newaccount NEW_ADDR --broadcast

5. Threshold met → new key owns old account and all linked safes
```

The original username is the account name the agent had before key loss — not the new address's username.

---

## Configuration

```bash
wallet-cli config show                           # View full config
wallet-cli config get user.address               # Get address
wallet-cli config set user.address omnistar1...  # Set address
wallet-cli config set user.pubkey BASE64PUB      # Set pubkey (base64)
```

---

## Queries

```bash
wallet-cli query snapshot                         # Full safe snapshot (uses config address)
wallet-cli query snapshot --address omnistar1...  # Snapshot for a specific address
wallet-cli query profile  --address omnistar1...  # Profile: policies, users, groups, SIGNATUREs
wallet-cli query balances --address omnistar1...  # OST balance held directly by this address
wallet-cli query assets                           # Full asset portfolio of the safe (OST + all cross-chain assets)
wallet-cli query account  --address omnistar1...  # Account number, sequence
wallet-cli query chain-info                       # Chain ID, latest block height
```

### `balances` vs `assets`

- `query balances` — OST balance of the given address. Profile-focused: use to check gas/funding. Requires `--address`. OST held by a safe must be sent via `tx create-transaction`, not `tx send`.
- `query assets` — full asset portfolio of the safe (OST + BTC/ETH/SOL/ERC20s/…) with smallCoin, explorer link, and pair value per asset. Defaults to the configured safe — no `--address` needed.

### smallCoin — convert before transferring

`query assets` returns balances in **display units** (e.g. `1.5` USDC). The on-chain unit (`--amount` and `--small-coin` consume) is:

```
amount_in_smallest_units = balance × smallCoin
# e.g. 1.5 × 1_000_000 = 1_500_000
```

Always do this multiplication explicitly. Passing the display value as `--amount` silently truncates and sends the wrong amount.

**Getting policy SIGNATUREs:** `wallet-cli query profile --address ADDR` — find the policy by its `id`, then read its `SIGNATURE` field. Required for `edit-policy` and `delete-policy`.

---

## Transaction Commands Reference

### `tx create-safe`
```bash
wallet-cli tx create-safe --username NAME --broadcast
```
Creates a safe with 9 initialization messages. Takes ~30s to validate on-chain after broadcast. Username rules: letters, numbers, dots only; no leading, trailing, or consecutive dots.

### `tx send` — OST between key addresses (no safe)
```bash
wallet-cli tx send --from ADDR --to ADDR --amount 1000nost --broadcast
```
Plain Cosmos bank transfer of OST out of an address that directly holds it. No safe, no policy, no vote. For funding accounts or paying gas. **Sending funds out of a safe — including OST — is not `tx send`; use `tx create-transaction` instead.**

### `tx create-policy`
```bash
# transaction-only (amount + symbols available; name/description always prompted — pass empty to skip):
wallet-cli tx create-policy --destination ADDR --apply-on transaction --broadcast
# stdin (voting + amount example): "1,2\n100\n0\n1000\n\n\n"

# all other applyOn values (voting only):
wallet-cli tx create-policy --destination ADDR --apply-on group --broadcast
# stdin: "1\n100\nPolicy Name\nDescription\n"
```
Valid `--apply-on`: `group`, `user`, `transaction`, `policy`, `profile`. Comma-separate for multiple.
**MIXING RULE:** `amount`/`symbols` only when `--apply-on transaction` is the sole value.

### `tx edit-policy`
```bash
wallet-cli tx edit-policy --destination ADDR --policy-id POLICY_ID --signature SIG \
  --apply-on transaction --broadcast
# stdin: same pattern as create-policy for the matching applyOn
```
`POLICY_ID` and `SIG` — from `wallet-cli query profile --address ADDR`, find policy by `id`, read its `SIGNATURE` field.

### `tx delete-policy`
```bash
wallet-cli tx delete-policy --destination ADDR --policy-id POLICY_ID --signature SIG \
  --parent-group GROUP_ID --broadcast
```
⚠️ Soft-delete only. Data remains on-chain. No stdin prompts.

The skill (`wallet_tx_delete_policy`) now takes `{destination, policyId}`. Find `policyId` via `wallet_snapshot` under `safe.groups[].nestedObjects[]` where `class === 'policy'` (use the `nestedObject.id`). The skill resolves `--signature` **and** `--parent-group` from the snapshot — `--parent-group` defaults to `Primary` in wallet-cli, so policies in non-Primary groups previously got silently mis-targeted; the resolver now supplies the real group. A user id (or any non-policy id) errors with the list of available policy ids; an already-deleted policy id errors "already deleted".

> A successful broadcast is **not** a completed deletion — same voting semantics as `delete-user`. See the callout under `tx delete-user` below: confirm via `wallet_snapshot` `isDeleted`, and vote if a `deleteObject` request is pending.

### `tx create-user`
```bash
wallet-cli tx create-user --destination SAFE_ADDR --public-key omnistar1... \
  --parent-group GROUP_ID --broadcast
```

**Hard contract (skill-side enforcement + agent must understand):**
- **Users go to a SAFE's groups, NEVER to a profile's groups.** `--destination` must be the safe address — never an agent's profile address.
- **`--parent-group` is a group ID, not a name.** Valid values: the literal `Primary` (genesis group, id == name), or a UUID from the safe's snapshot (`wallet_snapshot` → find the safe → `groups[].id`). Names are rejected by the skill.
- **`--public-key` must be an `omnistar1…` address.** Usernames are rejected by wallet-cli.

The skill (`wallet_tx_create_user`) accepts `{destination, user, group?}` — when `group` is omitted and the safe has exactly one group, the skill passes its id; when ambiguous (≥2 groups), the skill errors with the id (name) pairs so the agent can pick. Groups are read from the profile snapshot, so soft-deleted groups are excluded.

### `tx delete-user`
```bash
wallet-cli tx delete-user --destination SAFE_ADDR --user-id UUID --signature SIG \
  --parent-group GROUP_ID --broadcast
```

Same contract as `tx create-user`:
- Users live in **safe** groups, never profile groups — `--destination` is a safe address.
- `--parent-group` is a group **ID** (`Primary` literal or UUID), never a name.
- `--user-id` and `--signature` are the per-membership id + SIGNATURE.

The skill (`wallet_tx_delete_user`) now takes `{destination, userId}` — **not an address**. Find `userId` via `wallet_snapshot` under `safe.groups[].nestedObjects[]` where `class === 'user'` (use the `nestedObject.id`). The skill resolves `--signature` and `--parent-group` from the snapshot. A policy id (or any non-user id) errors with the list of available user ids; an already-deleted user id errors "already deleted".

> ### ⚠️ A successful broadcast is NOT a completed deletion
>
> `delete-user` and `delete-policy` are governed by the group's voting policy. Broadcasting (`code: 0`) only **creates a pending deletion request** attached to the target object — it does **not** flip `isDeleted` on its own.
>
> - **Single-member group:** the lone member's vote is auto-applied → the delete takes effect immediately.
> - **Multi-member group (≥2 users):** the request sits **pending** until the group's voting threshold is met. Until then the target still shows `isDeleted: false`, and a `pending_objects[]` entry with `applyFunction.functionName === "deleteObject"` and `process.currentPhase.name === "In Validation Process"` hangs off the object. Re-broadcasting just **stacks another pending request** — it does not advance the vote.
>
> **Always confirm completion by re-querying `wallet_snapshot` and checking the target's `isDeleted` flag** — never infer success from the tx code alone. If it's still `false` with a `deleteObject` pending object, the deletion is awaiting votes: each group member must `wallet_tx_vote` YES on the pending request's `SIGNATURE`, then it executes. Report the pending state honestly; do not claim the user/policy is gone.

> **`add-group` is upstream-pending in wallet-cli** — no skill tool yet.

### `tx vote`
```bash
wallet-cli tx vote --destination SAFE_ADDR --vote YES --signature SIG --broadcast
```
Vote values: `YES`, `NO`.

wallet-cli prompts `Add another vote entry? (y/n):` after the first vote — the skill answers `n` automatically.

### `tx create-transaction` — move assets out of a safe

Use this — not `tx send` — whenever **the safe holds the funds**, regardless of asset type.

```bash
# Native token
wallet-cli tx create-transaction --destination SAFE_ADDR --to RECIPIENT \
  --amount 100000 --asset BTC --fee-priority high --broadcast

# ERC20 token (all three extra flags required together)
wallet-cli tx create-transaction --destination SAFE_ADDR --to 0xRecipient \
  --amount 1500000 --asset USDC --fee-priority medium \
  --token-address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --chain ethereum --small-coin 1000000 --broadcast
```

ERC20 extra flags:

| Flag | Description |
|---|---|
| `--token-address` | ERC20 contract address (0x + 40 hex) |
| `--chain` | `ethereum`, `polygon`, or `base` |
| `--small-coin` | Token smallest unit divisor |

Use `wallet-cli query assets` to look up `contractAddress`, `smallCoin`, and `chain` from the `layer2data` field.

### `tx request-recovery`
```bash
wallet-cli tx request-recovery --username ORIGINAL_USERNAME --broadcast
```
wallet-cli **requires** `--username` (the original account being recovered). The skill accepts either `username` directly, or `oldAddress` — when only `oldAddress` is given the skill resolves the username via `query profile` (key `name`).

Used for two scenarios:
- **User lost their key** — agent drives recovery on behalf of the user
- **Agent lost its own key** — agent recovers its own account (see Self-Recovery in Account Recovery section)

In both cases, `tx request-recovery` is signed by the **new key**. The command references the **original account username** (the one being recovered), not the new address's username.

After running, surface:

1. **List of helpers** — each helper's address and on-chain username (if resolvable).
2. **A single Wikey deeplink** to forward to every helper:
   ```
   https://open.wikey.io/accountRecover?t=recover&pk=<NEW_ADDRESS>&tn=<REQUESTER_USERNAME>
   ```
   - `NEW_ADDRESS` — the new address replacing the old one.
   - `REQUESTER_USERNAME` — on-chain username of the account being recovered (not a helper's username).
   - URL-encode values containing characters outside `[A-Za-z0-9._-]`.

Output template:
```
Recovery requested for <REQUESTER_USERNAME> → <NEW_ADDRESS>

Helpers to contact:
  1. <addr1>  (<username1 or "—">)
  2. <addr2>  (<username2 or "—">)

Send this link to each helper:
  https://open.wikey.io/accountRecover?t=recover&pk=<NEW_ADDRESS>&tn=<REQUESTER_USERNAME>
```

### `tx approve-recovery`
```bash
wallet-cli tx approve-recovery --oldaccount alice --newaccount omnistar1... --broadcast
```
Helper-side counterpart — used when this agent is a helper approving someone else's recovery.

### `tx edit-helpers`
```bash
wallet-cli tx edit-helpers --broadcast
# stdin: "y\nHELPER_ADDRESS\nn\nn\n2\n"
```

**Helpers are for account recovery only** — no safe permissions, no governance role. When asked to add a helper, run this command directly. Do not ask about roles.

Prompt order:

| Prompt | Answer |
|---|---|
| `Would you like to add a helper? (y/n):` | `y` or `n` |
| `Enter helper address or username:` | address or username (repeated per helper) |
| `Would you like to add another helper? (y/n):` | `y` or `n` |
| `Would you like to remove a helper? (y/n):` | `y` or `n` |
| `Enter the number of the helper to remove:` | number (if removing) |
| `Would you like to remove another helper? (y/n):` | `y` or `n` |
| `Enter threshold (number of helpers required, 1-N):` | integer count of helpers required (e.g. `2` for 2-of-3). Snapshot displays this as a percentage — never feed the percentage back as input. |

---

## Username Resolution

```bash
curl -s "https://reverse-proxy.omnistar.io/mainnet/proxy/users/accounts/getAccountByName/?accountName=USERNAME"
# Returns: {"public_key": "omnistar1...", "display_name": "...", ...}
```

Always resolve usernames to addresses before using them in transactions.

---

## Nonce File

The nonce file (`<workspace>/.ssp-nonce`) tracks the monotonically increasing
nonce counter. It does **not** contain the HMAC key or any secret.

`wallet_session_start` deletes it automatically before spawning a new SSP process.
Each new SSP session starts with nonce 0. Across rotations, the nonce is preserved
and continues monotonically — `wallet_hmac_rotate` does NOT delete it.
Never write to this file directly; `ssp-util` owns it.

---

## External Endpoints

SSP's own HTTP endpoints are intentionally omitted — `wallet-cli` is the only
supported caller. The endpoints below are external read-only services.

### Omnistar RPC
- RPC: `http://prod-full-1.omnistar.io:26657`
- LCD: `http://prod-full-1.omnistar.io:1317`
- Proxy: `https://reverse-proxy.omnistar.io/mainnet/proxy`
- Node API: `https://reverse-proxy.omnistar.io/mainnet/node`
- API Key: `wallet-cli config get apiKey`

### Transaction Lookup
```
https://reverse-proxy.wikey.io/mainnet/full-node/cosmos/tx/v1beta1/txs/TXHASH
```

---

## Error Reference

| Error / Symptom | Cause | Action |
|---|---|---|
| `SSP_HMAC_KEY is not set` | Env var missing at SSP startup | Set `SSP_HMAC_KEY` in child process env before spawning |
| `SSP_HMAC_KEY must be exactly 64 hex characters` | Wrong format/length | Generate exactly 32 random bytes, encode as 64 lowercase hex chars |
| `this build only supports -keystore secure` | Tried memory/fs mode on production binary | Spawn with `-keystore secure` |
| 403 / proof rejected | Stale nonce, wrong key, or missing `-spawned-by-agent` | Confirm flag; delete `.ssp-nonce`; verify correct HMAC key piped to `ssp-util` |
| `ACCOUNT_NOT_FOUND` | Address not on-chain | Ask user to fund the address first |
| `USERNAME_TAKEN` | Safe name already registered | Choose a different username |
| `RPC_CONNECTION_ERROR` | Can't reach the chain | Check network, retry |
| `wallet-cli exited with code 1` with empty message | Real error in stdout | Run command directly via exec to capture stdout |
| `malformed proof JSON` | Proof not parsed correctly | Check that SSP server and wallet-cli versions match |
| Safe snapshot empty after broadcast | Chain not yet validated | Wait ~30s and query again |
| Policy name/description garbled on-chain | Used `--name`/`--description` CLI flags | Always use stdin for name/description |
