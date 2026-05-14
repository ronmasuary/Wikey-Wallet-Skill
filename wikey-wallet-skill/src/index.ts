import { execFile as execFileCb, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';

const execFile = promisify(execFileCb);
const nonceFile = () => path.join(process.cwd(), '.ssp-nonce');

// SSP session state — key lives here only, never exposed to agent
let sessionHmacKey: string | null = null;
let signingServerProcess: ReturnType<typeof spawn> | null = null;

// ─── Proof driver helpers ─────────────────────────────────────────────────────

function parseSignRequest(buf: string): { unsignedData: string; signingPubKey: string } | null {
  const i = buf.indexOf('Sign Request:');
  if (i === -1) return null;
  const tail = buf.slice(i + 'Sign Request:'.length);
  const start = tail.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let k = start; k < tail.length; k++) {
    if (tail[k] === '{') depth++;
    else if (tail[k] === '}' && --depth === 0) { end = k; break; }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(tail.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj.unsignedData === 'string' && typeof obj.signingPubKey === 'string')
      return { unsignedData: obj.unsignedData, signingPubKey: obj.signingPubKey };
  } catch { /* ignore */ }
  return null;
}

function computeProof(hmacKey: string, unsignedData: string, signingPubKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ssp-util', [
      'proof',
      '--unsigned-data', unsignedData,
      '--signing-pub-key', signingPubKey,
      '--nonce-file', nonceFile(),
    ]);
    let out = '', err = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('close', (code: number | null) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`ssp-util exit ${code}: ${err}`));
    });
    p.on('error', (e: Error) => { try { p.kill('SIGTERM'); } catch { /* ignore */ } reject(e); });
    p.stdin.end(hmacKey + '\n');
  });
}

// ─── Non-signing query runner ─────────────────────────────────────────────────

async function runQuery(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('wallet-cli', args);
    return stdout.trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; code?: number };
    const detail = err.stdout?.trim() || err.stderr?.trim() || String(e);
    throw new Error(`wallet-cli exit ${err.code ?? '?'}: ${detail}`);
  }
}

// ─── Signing runner (simple + interactive-with-preProofInputs) ───────────────

async function runSigning(
  hmacKey: string,
  args: string[],
  preProofInputs: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('wallet-cli', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '', stdout = '', proofSent = false;

    for (const line of preProofInputs)
      child.stdin.write(line.endsWith('\n') ? line : line + '\n');

    child.stderr.on('data', async (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (proofSent) return;
      const req = parseSignRequest(stderrBuf);
      if (!req) return;
      proofSent = true;
      try {
        const proof = await computeProof(hmacKey, req.unsignedData, req.signingPubKey);
        child.stdin.write(proof + '\n');
        child.stdin.end();
      } catch (e) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(e as Error);
      }
    });

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });

    child.on('close', (code: number | null) => {
      if (code === 0) { resolve(stdout.trim()); return; }
      let detail = stderrBuf.slice(-500);
      try {
        const j = JSON.parse(stdout.trim()) as Record<string, unknown>;
        const e = j?.error as Record<string, unknown> | undefined;
        detail = (e?.message as string) ?? (j?.message as string) ?? detail;
      } catch { /* use stderrBuf */ }
      reject(new Error(`wallet-cli exit ${code}: ${detail}`));
    });

    child.on('error', (e: Error) => reject(e));
  });
}

// ─── HMAC rotation ────────────────────────────────────────────────────────────

async function runHmacRotation(currentHmacKey: string): Promise<{ newHmacKey: string }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const newKey = crypto.randomBytes(32).toString('hex');
    const code = await new Promise<number | null>((resolve, reject) => {
      const p = spawn('ssp-util', ['rotate', '--nonce-file', nonceFile()]);
      p.on('error', reject);
      p.on('close', resolve);
      p.stdin.end(currentHmacKey + '\n' + newKey + '\n');
    });
    if (code === 0) return { newHmacKey: newKey };
    if ((code === 6 || code === 7) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    if (code === 4) throw new Error('SSP unreachable (ssp-util rotate exit 4)');
    if (Date.now() >= deadline) throw new Error('HMAC rotation failed: session wedged after 30s');
    throw new Error(`ssp-util rotate exit ${code}`);
  }
}

// ─── Policy stdin builder ─────────────────────────────────────────────────────

interface PolicyCondition {
  type: string;
  votingQty?: number;
  minAmount?: number;
  maxAmount?: number;
  symbols?: string[];
  allowedAddresses?: string[];
  threshold?: number;
}

function buildPolicyStdinInputs(opts: {
  applyOn: string;
  conditions: PolicyCondition[];
  name?: string;
  description?: string;
}): string[] {
  const classes = opts.applyOn.split(',').map(s => s.trim().toLowerCase());
  const onlyTx = classes.length === 1 && classes[0] === 'transaction';
  const onlyProfile = classes.length === 1 && classes[0] === 'profile';

  const menuMap: Record<string, number> = { voting: 1 };
  if (onlyTx) { menuMap['amount'] = 2; menuMap['symbols'] = 3; }
  if (onlyProfile) { menuMap['allow_updateuseraddress'] = 2; }

  const selected = opts.conditions
    .map(c => ({ c, idx: menuMap[c.type.toLowerCase()] }))
    .filter(x => x.idx !== undefined)
    .sort((a, b) => a.idx - b.idx);

  const lines: string[] = [selected.map(x => x.idx).join(',') + '\n'];

  for (const { c } of selected) {
    const t = c.type.toLowerCase();
    if (t === 'voting') {
      lines.push((c.votingQty ?? 0).toString() + '\n');
    } else if (t === 'amount') {
      lines.push((c.minAmount ?? 0).toString() + '\n');
      lines.push((c.maxAmount ?? 0).toString() + '\n');
    } else if (t === 'symbols') {
      lines.push((c.symbols ?? []).join(',') + '\n');
    } else if (t === 'allow_updateuseraddress') {
      lines.push((c.allowedAddresses ?? []).join(',') + '\n');
      lines.push((c.threshold ?? 100).toString() + '\n');
    }
  }

  if (!onlyTx) {
    lines.push((opts.name ?? '') + '\n');
    lines.push((opts.description ?? '') + '\n');
  }
  return lines;
}

// ─── edit-helpers signing runner (prompt-driven state machine) ────────────────

async function runSigningEditHelpers(
  hmacKey: string,
  addHelpers: string[],
  removeHelpers: string[],
  threshold: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('wallet-cli', ['tx', 'edit-helpers', '--broadcast'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrWindow = ''; // resets after each response to avoid re-triggering
    let allStderr = '';    // full stderr for list parsing and sign-request detection
    let stdout = '';
    let proofSent = false;
    let helperList: string[] = [];
    let addIdx = 0;
    let removeIdx = 0;

    type Phase =
      | 'wait_add' | 'enter_add' | 'another_add'
      | 'wait_remove' | 'enter_remove' | 'another_remove'
      | 'threshold' | 'proof';
    let phase: Phase = 'wait_add';

    function updateHelperList() {
      if (helperList.length > 0) return;
      const matches = [...allStderr.matchAll(/^\s*(\d+)[.)]\s*(.+)$/gm)];
      if (matches.length > 0) helperList = matches.map(m => m[2].trim());
    }

    function ends(prompt: string): boolean {
      return stderrWindow.trimEnd().endsWith(prompt);
    }

    function respond(s: string, next: Phase) {
      phase = next;
      stderrWindow = '';
      child.stdin.write(s);
    }

    function handlePrompts() {
      updateHelperList();
      if (phase === 'wait_add' && ends('Would you like to add a helper? (y/n):')) {
        if (addHelpers.length > 0) respond('y\n', 'enter_add');
        else respond('n\n', 'wait_remove');
      } else if (phase === 'enter_add' && ends('Enter helper address or username:')) {
        respond(addHelpers[addIdx++] + '\n', 'another_add');
      } else if (phase === 'another_add' && ends('Would you like to add another helper? (y/n):')) {
        if (addIdx < addHelpers.length) respond('y\n', 'enter_add');
        else respond('n\n', 'wait_remove');
      } else if (phase === 'wait_remove' && ends('Would you like to remove a helper? (y/n):')) {
        if (removeHelpers.length > 0) respond('y\n', 'enter_remove');
        else respond('n\n', 'threshold');
      } else if (phase === 'enter_remove' && ends('Enter the number of the helper to remove:')) {
        const target = removeHelpers[removeIdx];
        const idx = helperList.findIndex(h => h.toLowerCase().includes(target.toLowerCase()));
        respond((idx >= 0 ? idx + 1 : 1).toString() + '\n', 'another_remove');
        removeIdx++;
      } else if (phase === 'another_remove' && ends('Would you like to remove another helper? (y/n):')) {
        if (removeIdx < removeHelpers.length) respond('y\n', 'enter_remove');
        else respond('n\n', 'threshold');
      } else if (phase === 'threshold' && ends('Enter threshold (number of helpers required, 1-N):')) {
        respond(threshold.toString() + '\n', 'proof');
      }
    }

    child.stderr.on('data', async (chunk: Buffer) => {
      const s = chunk.toString();
      stderrWindow += s;
      allStderr += s;
      if (proofSent) return;
      const req = parseSignRequest(allStderr);
      if (req) {
        proofSent = true;
        try {
          const proof = await computeProof(hmacKey, req.unsignedData, req.signingPubKey);
          child.stdin.write(proof + '\n');
          child.stdin.end();
        } catch (e) {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          reject(e as Error);
        }
        return;
      }
      handlePrompts();
    });

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });

    child.on('close', (code: number | null) => {
      if (code === 0) { resolve(stdout.trim()); return; }
      let detail = allStderr.slice(-500);
      try {
        const j = JSON.parse(stdout.trim()) as Record<string, unknown>;
        const e = j?.error as Record<string, unknown> | undefined;
        detail = (e?.message as string) ?? (j?.message as string) ?? detail;
      } catch { /* use allStderr */ }
      reject(new Error(`wallet-cli exit ${code}: ${detail}`));
    });

    child.on('error', (e: Error) => reject(e));
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const tools = [
  // Query tools
  {
    name: 'wallet_chain_info',
    description: 'Get Omnistar chain ID and latest block height',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_balance',
    description: 'Get OST balance directly held by an address (use for gas/funding checks)',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... address' } },
      required: ['address'],
    },
  },
  {
    name: 'wallet_balances',
    description: 'Get all OST balances for an address',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... address' } },
      required: ['address'],
    },
  },
  {
    name: 'wallet_account',
    description: 'Get account number and sequence for an address',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... address' } },
      required: ['address'],
    },
  },
  {
    name: 'wallet_snapshot',
    description: 'Get full safe snapshot (balances, policies, users). Uses config address when omitted.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... safe address (optional, uses config default)' } },
    },
  },
  {
    name: 'wallet_profile',
    description: 'Get on-chain profile (pubkey, policies, linked safes). Uses config address when omitted.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... address (optional, uses config default)' } },
    },
  },
  {
    name: 'wallet_assets',
    description: 'Get full asset portfolio of the safe (OST + cross-chain assets with smallCoin). Defaults to configured safe.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'omnistar1... safe address (optional)' } },
    },
  },
  // Key tools
  {
    name: 'wallet_keys_list',
    description: 'List all key IDs in the signing-server',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_keys_get',
    description: 'Get details for a specific key ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Key ID' } },
      required: ['id'],
    },
  },
  {
    name: 'wallet_keys_create',
    description: 'Generate a new keypair in the signing-server. Returns the new omnistar1... address. Requires an active SSP session (call wallet_session_start first).',
    inputSchema: {
      type: 'object',
      properties: { setDefault: { type: 'boolean', description: 'Set this key as the default' } },
    },
  },
  // Config tools
  {
    name: 'wallet_config_show',
    description: 'Show the full wallet-cli configuration',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_config_get',
    description: 'Get a single config value by dot-path key (e.g. user.address)',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Config key (e.g. user.address, apiKey)' } },
      required: ['key'],
    },
  },
  {
    name: 'wallet_config_set',
    description: 'Set a config value by dot-path key',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Config key' },
        value: { type: 'string', description: 'Value to set' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'wallet_config_init',
    description: 'Initialize wallet-cli configuration with defaults',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_config_reset',
    description: 'Reset wallet-cli configuration to defaults',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_config_path',
    description: 'Show the path to the wallet-cli config file',
    inputSchema: { type: 'object', properties: {} },
  },
  // Session tools
  {
    name: 'wallet_session_start',
    description: 'Start a secure SSP session. Generates HMAC key internally and spawns signing-server. Must be called once at the beginning of every session before any wallet_tx_* or wallet_notification_configure tools. Kills any existing signing-server first. Key is held in skill memory only — never exposed to the agent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wallet_session_status',
    description: 'Check if an SSP session is currently active. Returns { active: boolean, pid: number|null }. Call before wallet_session_start to avoid killing a live session.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // Signing tools
  {
    name: 'wallet_tx_create_safe',
    description: 'Create a safe + profile on-chain with a username. Takes ~30s to validate after broadcast.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Safe username (letters, numbers, dots only; no leading/trailing/consecutive dots)' },
      },
      required: ['username'],
    },
  },
  {
    name: 'wallet_tx_send',
    description: 'Send OST directly between key addresses (not safe funds). Use for gas funding.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender omnistar1... address' },
        to: { type: 'string', description: 'Recipient omnistar1... address' },
        amount: { type: 'string', description: 'Amount with denom (e.g. 1000nost)' },
      },
      required: ['from', 'to', 'amount'],
    },
  },
  {
    name: 'wallet_tx_create_transaction',
    description: 'Move assets out of a safe. Use this (not wallet_tx_send) when the safe holds the funds. Amount must be in smallest units (display × smallCoin from wallet_assets).',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Safe address (omnistar1...)' },
        to: { type: 'string', description: 'Recipient address' },
        amount: { type: 'number', description: 'Amount in smallest units (display value × smallCoin)' },
        asset: { type: 'string', description: 'Asset symbol (e.g. BTC, USDC, OST)' },
        feePriority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Transaction fee priority' },
        tokenAddress: { type: 'string', description: 'ERC20 contract address (0x + 40 hex) — required for ERC20 assets' },
        chain: { type: 'string', enum: ['ethereum', 'polygon', 'base'], description: 'ERC20 chain — required for ERC20 assets' },
        smallCoin: { type: 'number', description: 'ERC20 token divisor — required for ERC20 assets' },
      },
      required: ['destination', 'to', 'amount', 'asset', 'feePriority'],
    },
  },
  {
    name: 'wallet_tx_vote',
    description: 'Vote on an on-chain object. signature is the Omnistar tx hash (SIGNATURE field from query snapshot/profile).',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Safe address (omnistar1...)' },
        vote: { type: 'string', enum: ['YES', 'NO', 'ABSTAIN'] },
        signature: { type: 'string', description: 'Omnistar tx hash of the object being voted on' },
      },
      required: ['destination', 'vote', 'signature'],
    },
  },
  {
    name: 'wallet_tx_request_recovery',
    description: 'Request account recovery (signs with new key, references original account). Returns result for helper deeplink construction.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wallet_tx_approve_recovery',
    description: 'Approve a recovery request as a helper.',
    inputSchema: {
      type: 'object',
      properties: {
        oldaccount: { type: 'string', description: 'Original account username being recovered' },
        newaccount: { type: 'string', description: 'New omnistar1... address replacing the old one' },
      },
      required: ['oldaccount', 'newaccount'],
    },
  },
  {
    name: 'wallet_tx_create_policy',
    description: 'Create a policy on a safe. Never pass name/description as CLI flags — this tool feeds them via stdin. Condition menu indices depend on applyOn.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Safe address (omnistar1...)' },
        applyOn: { type: 'string', description: 'Comma-separated classes (e.g. transaction, profile, transaction,profile)' },
        conditions: {
          type: 'array',
          description: 'Policy conditions to enable',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['voting', 'amount', 'symbols', 'allow_updateUserAddress'] },
              votingQty: { type: 'number', description: 'Voting threshold percentage (0-100), for type=voting' },
              minAmount: { type: 'number', description: 'Minimum amount, for type=amount' },
              maxAmount: { type: 'number', description: 'Maximum amount, for type=amount' },
              symbols: { type: 'array', items: { type: 'string' }, description: 'Allowed symbols, for type=symbols' },
              allowedAddresses: { type: 'array', items: { type: 'string' }, description: 'Allowed source addresses, for type=allow_updateUserAddress' },
              threshold: { type: 'number', description: 'Threshold percentage (0-100), for type=allow_updateUserAddress' },
            },
            required: ['type'],
          },
        },
        name: { type: 'string', description: 'Policy name (optional)' },
        description: { type: 'string', description: 'Policy description (optional)' },
      },
      required: ['destination', 'applyOn', 'conditions'],
    },
  },
  {
    name: 'wallet_tx_edit_helpers',
    description: 'Add/remove recovery helpers and set threshold. Helpers have no safe permissions — recovery only.',
    inputSchema: {
      type: 'object',
      properties: {
        addHelpers: { type: 'array', items: { type: 'string' }, description: 'Helper addresses/usernames to add' },
        removeHelpers: { type: 'array', items: { type: 'string' }, description: 'Helper addresses to remove (skill resolves numbered index from CLI output)' },
        threshold: { type: 'number', description: 'Number of helpers required for recovery (integer count, not percentage)' },
      },
      required: ['threshold'],
    },
  },
  {
    name: 'wallet_notification_configure',
    description: 'Configure notifications. Returns a token credential — display to user once with explanation, then drop it. At least one channel field required.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Comma-separated email addresses' },
        sms: { type: 'string', description: 'Comma-separated phone numbers' },
        webhook: { type: 'string', description: 'Comma-separated webhook URLs' },
        telegram: { type: 'string', description: 'Comma-separated Telegram handles/chat IDs' },
        push: { type: 'string', description: 'Comma-separated push tokens' },
        address: { type: 'string', description: 'Override config user.address' },
        url: { type: 'string', description: 'Override config wikeyAuthUrl' },
      },
      required: [],
    },
  },
  {
    name: 'wallet_hmac_rotate',
    description: 'Rotate the HMAC key via ssp-util. Call every 15 minutes between requests — never mid-signing. Key is swapped internally; nothing is returned to the agent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── Execute dispatcher ───────────────────────────────────────────────────────

async function execute(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    // Session tools
    case 'wallet_session_start': {
      try { await execFile('pkill', ['-f', 'signing-server.*-spawned-by-agent']); } catch { /* none running */ }
      if (signingServerProcess) {
        try { signingServerProcess.kill('SIGTERM'); } catch { /* ignore */ }
        signingServerProcess = null;
      }
      sessionHmacKey = null;

      try { await unlink(nonceFile()); } catch { /* may not exist */ }

      const hmacKey = crypto.randomBytes(32).toString('hex');

      const proc = spawn(
        path.join(process.env.HOME ?? '/root', '.ssp', 'bin', 'signing-server'),
        ['-spawned-by-agent', '-keystore', 'secure'],
        {
          env: { ...process.env, SSP_HMAC_KEY: hmacKey },
          detached: false,
          stdio: 'ignore',
        }
      );

      proc.on('error', () => {
        signingServerProcess = null;
        sessionHmacKey = null;
      });

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        function probe() {
          const s = createConnection({ port: 8080, host: '127.0.0.1' });
          s.on('connect', () => { s.destroy(); resolve(); });
          s.on('error', () => {
            if (Date.now() >= deadline) { reject(new Error('SSP did not start within 10s')); return; }
            setTimeout(probe, 200);
          });
        }
        probe();
      });

      signingServerProcess = proc;
      sessionHmacKey = hmacKey;

      return JSON.stringify({ ok: true, pid: proc.pid });
    }
    case 'wallet_session_status': {
      const active = signingServerProcess !== null && sessionHmacKey !== null;
      return JSON.stringify({ active, pid: signingServerProcess?.pid ?? null });
    }
    // Query tools
    case 'wallet_chain_info':
      return runQuery(['query', 'chain-info']);
    case 'wallet_balance': {
      const { address } = input as { address: string };
      return runQuery(['query', 'balance', '--address', address]);
    }
    case 'wallet_balances': {
      const { address } = input as { address: string };
      return runQuery(['query', 'balances', '--address', address]);
    }
    case 'wallet_account': {
      const { address } = input as { address: string };
      return runQuery(['query', 'account', '--address', address]);
    }
    case 'wallet_snapshot': {
      const { address } = input as { address?: string };
      const args = ['query', 'snapshot'];
      if (address) args.push('--address', address);
      return runQuery(args);
    }
    case 'wallet_profile': {
      const { address } = input as { address?: string };
      const args = ['query', 'profile'];
      if (address) args.push('--address', address);
      return runQuery(args);
    }
    case 'wallet_assets': {
      const { address } = input as { address?: string };
      const args = ['query', 'assets'];
      if (address) args.push('--address', address);
      return runQuery(args);
    }
    // Key tools
    case 'wallet_keys_list':
      return runQuery(['keys', 'list']);
    case 'wallet_keys_get': {
      const { id } = input as { id: string };
      return runQuery(['keys', 'get', '--id', id]);
    }
    case 'wallet_keys_create': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { setDefault } = input as { setDefault?: boolean };
      const args = ['keys', 'create'];
      if (setDefault) args.push('--set-default');
      return runSigning(sessionHmacKey, args);
    }
    // Config tools
    case 'wallet_config_show':
      return runQuery(['config', 'show']);
    case 'wallet_config_get': {
      const { key } = input as { key: string };
      return runQuery(['config', 'get', key]);
    }
    case 'wallet_config_set': {
      const { key, value } = input as { key: string; value: string };
      return runQuery(['config', 'set', key, value]);
    }
    case 'wallet_config_init':
      return runQuery(['config', 'init']);
    case 'wallet_config_reset':
      return runQuery(['config', 'reset']);
    case 'wallet_config_path':
      return runQuery(['config', 'path']);
    // Signing tools
    case 'wallet_tx_create_safe': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { username } = input as { username: string };
      return runSigning(sessionHmacKey, ['tx', 'create-safe', '--username', username, '--broadcast']);
    }
    case 'wallet_tx_send': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { from, to, amount } = input as { from: string; to: string; amount: string };
      return runSigning(sessionHmacKey, ['tx', 'send', '--from', from, '--to', to, '--amount', amount, '--broadcast']);
    }
    case 'wallet_tx_create_transaction': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { destination, to, amount, asset, feePriority, tokenAddress, chain, smallCoin } =
        input as {
          destination: string; to: string; amount: number; asset: string;
          feePriority: string;
          tokenAddress?: string; chain?: string; smallCoin?: number;
        };
      const args = [
        'tx', 'create-transaction',
        '--destination', destination,
        '--to', to,
        '--amount', amount.toString(),
        '--asset', asset,
        '--fee-priority', feePriority,
      ];
      if (tokenAddress) args.push('--token-address', tokenAddress);
      if (chain) args.push('--chain', chain);
      if (smallCoin !== undefined) args.push('--small-coin', smallCoin.toString());
      args.push('--broadcast');
      return runSigning(sessionHmacKey, args);
    }
    case 'wallet_tx_vote': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { destination, vote, signature } =
        input as { destination: string; vote: string; signature: string };
      return runSigning(sessionHmacKey, [
        'tx', 'vote',
        '--destination', destination,
        '--vote', vote,
        '--signature', signature,
        '--broadcast',
      ]);
    }
    case 'wallet_tx_request_recovery': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      return runSigning(sessionHmacKey, ['tx', 'request-recovery', '--broadcast']);
    }
    case 'wallet_tx_approve_recovery': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { oldaccount, newaccount } =
        input as { oldaccount: string; newaccount: string };
      return runSigning(sessionHmacKey, [
        'tx', 'approve-recovery',
        '--oldaccount', oldaccount,
        '--newaccount', newaccount,
        '--broadcast',
      ]);
    }
    case 'wallet_tx_create_policy': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const typed = input as {
        destination: string; applyOn: string;
        conditions: PolicyCondition[]; name?: string; description?: string;
      };
      const preProofInputs = buildPolicyStdinInputs(typed);
      return runSigning(sessionHmacKey, [
        'tx', 'create-policy',
        '--destination', typed.destination,
        '--apply-on', typed.applyOn,
        '--broadcast',
      ], preProofInputs);
    }
    case 'wallet_tx_edit_helpers': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { addHelpers = [], removeHelpers = [], threshold } =
        input as { addHelpers?: string[]; removeHelpers?: string[]; threshold: number };
      return runSigningEditHelpers(sessionHmacKey, addHelpers, removeHelpers, threshold);
    }
    case 'wallet_notification_configure': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { email, sms, webhook, telegram, push, address, url } =
        input as {
          email?: string; sms?: string; webhook?: string;
          telegram?: string; push?: string; address?: string; url?: string;
        };
      const args = ['notification', 'configure'];
      if (email) args.push('--email', email);
      if (sms) args.push('--sms', sms);
      if (webhook) args.push('--webhook', webhook);
      if (telegram) args.push('--telegram', telegram);
      if (push) args.push('--push', push);
      if (address) args.push('--address', address);
      if (url) args.push('--url', url);
      args.push('--sign');
      return runSigning(sessionHmacKey, args);
    }
    case 'wallet_hmac_rotate': {
      if (!sessionHmacKey) throw new Error('No active SSP session. Call wallet_session_start first.');
      const { newHmacKey } = await runHmacRotation(sessionHmacKey);
      sessionHmacKey = newHmacKey;
      return JSON.stringify({ ok: true });
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── Skill export ─────────────────────────────────────────────────────────────

export default {
  name: 'wikey-wallet-skill',
  version: '2.0.0',
  tools,
  execute,
  systemPrompt: `
Call wallet_session_start once at the beginning of every session before using any wallet_tx_* or wallet_notification_configure tools.
Use wallet_session_status to check if a session is already active before starting a new one.

Never use shell_exec for any wallet operation. All wallet operations — queries, key management, config, signing, and session startup — have dedicated tools. shell_exec is never needed and never acceptable for wallet work, even as a fallback.

Do not pass hmacKey to any tool. The skill manages the HMAC key internally.

Call wallet_hmac_rotate every 15 minutes between requests — never mid-signing. The skill swaps the key internally; no agent action needed after the call.

Never restart, kill, or respawn the SSP signing-server mid-session. If SSP dies, the session is over — terminate and start fresh. Restarting SSP loses the HMAC key and likely makes the keystore unrecoverable.

wallet_notification_configure returns a token credential in the result JSON. Display the token to the user exactly once with an explanation (e.g. "This is your notification token — save it securely"), then drop it. If --webhook was used, offer to help scaffold a webhook receiver.

wallet_tx_create_transaction: amount must be in smallest units (display value × smallCoin from wallet_assets).
wallet_tx_vote: signature is the Omnistar tx hash of the object being voted on (SIGNATURE field from snapshot).
wallet_tx_create_policy: never pass name/description as CLI flags — always use the conditions array and name/description fields.
  `.trim(),
};
