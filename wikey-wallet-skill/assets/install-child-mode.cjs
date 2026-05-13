#!/usr/bin/env node
// SSP Agent-Child Mode Installer
//
// Installs only the signing-server and ssp-util binaries for deployments where
// an external agent spawns SSP (agent-child mode). No service manager, no
// LLM wizard, no openclaw stack.
//
// Usage:
//   node install-child-mode.js
//
// Environment overrides:
//   SSP_VERSION      Release tag (default: "latest")
//   SSP_INSTALL_DIR  Installation directory (default: ~/.ssp)
//   SSP_CLOUD        Set to "1" for cloud KMS variant
//   SSP_BASE_URL     Base URL for release artifacts
//
// Zero external dependencies — uses only Node.js built-in modules.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────────────────────

const VERSION = process.env.SSP_VERSION || "latest";
const INSTALL_DIR = process.env.SSP_INSTALL_DIR || path.join(os.homedir(), ".ssp");
const CLOUD = process.env.SSP_CLOUD === "1";

// ── GitLab Package Registry ──────────────────────────────────────────────
const GITLAB_PROJECT_ID = "79628789";
const GITLAB_DEPLOY_TOKEN = "gldt-K9HA9AtwXZ2BzWsi3zZL";
const GITLAB_API = `https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic`;
const PKG_NAME = "signing-server";
const BASE_URL = process.env.SSP_BASE_URL || null;

function artifactUrl(version, fileName) {
  if (BASE_URL) return `${BASE_URL}/${version}/${fileName}`;
  return `${GITLAB_API}/${PKG_NAME}/${version}/${fileName}`;
}
function metaUrl(fileName) {
  if (BASE_URL) return `${BASE_URL}/${fileName}`;
  return `${GITLAB_API}/meta/latest/${fileName}`;
}
function authHeaders() {
  if (BASE_URL) return {};
  return { "DEPLOY-TOKEN": GITLAB_DEPLOY_TOKEN };
}

// ── Platform detection ────────────────────────────────────────────────────

const OS_MAP = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_MAP = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" };

const PLATFORM = OS_MAP[process.platform];
const ARCH = ARCH_MAP[process.arch];
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

// ── Color helpers ─────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  green: isTTY ? "\x1b[32m" : "",
  red: isTTY ? "\x1b[31m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  dim: isTTY ? "\x1b[2m" : "",
};

function log(msg) { console.log(msg); }
function info(msg) { log(`${c.cyan}>${c.reset} ${msg}`); }
function ok(msg) { log(`${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { log(`${c.yellow}!${c.reset} ${msg}`); }
function fail(msg) { log(`${c.red}✗${c.reset} ${msg}`); process.exit(1); }

// ── HTTP download helper ──────────────────────────────────────────────────

function download(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const opts = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, headers };
    mod.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        const rh = new URL(res.headers.location).hostname.endsWith("gitlab.com") ? headers : {};
        return download(res.headers.location, destPath, rh).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function downloadText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const opts = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, headers };
    mod.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const rh = new URL(res.headers.location).hostname.endsWith("gitlab.com") ? headers : {};
        return downloadText(res.headers.location, rh).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

// ── Run npm command ───────────────────────────────────────────────────────

function npm(args, opts = {}) {
  const cmd = IS_WINDOWS ? `npm.cmd ${args}` : `npm ${args}`;
  execSync(cmd, { stdio: "pipe", ...opts });
}

// ── SHA-256 verification ──────────────────────────────────────────────────

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ══════════════════════════════════════════════════════════════════════════
// Main installer flow
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  log("");
  log(`${c.bold} SSP Agent-Child Mode Installer${c.reset}`);
  log(`${c.dim} ────────────────────────────────${c.reset}`);
  log("");

  // ── 1. Platform check ─────────────────────────────────────────────────

  if (!PLATFORM) fail(`Unsupported platform: ${process.platform}`);
  if (!ARCH) fail(`Unsupported architecture: ${process.arch}`);
  info(`Platform: ${PLATFORM}/${ARCH}`);

  // ── 2. Prerequisites ──────────────────────────────────────────────────

  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 22) {
    fail(
      `Node.js 22+ is required (current: ${process.versions.node}).\n` +
      ` Install via nvm: nvm install 22 && nvm use 22\n` +
      ` Or visit: https://nodejs.org/`
    );
  }
  ok(`Node.js ${process.versions.node}`);

  try { execSync("npm --version", { stdio: "pipe" }); } catch {
    fail("npm is not installed. Install Node.js 22+ which includes npm.");
  }
  ok("npm available");

  // ── 3. Version resolution ─────────────────────────────────────────────

  let version = VERSION;
  if (version === "latest") {
    info("Resolving latest version...");
    try {
      const data = await downloadText(metaUrl("latest.txt"), authHeaders());
      version = data.trim();
    } catch {
      warn("Could not resolve latest version. Using 'v1.0.0'.");
      version = "v1.0.0";
    }
  }
  ok(`Version: ${version}`);

  // ── 4. Create install directory ───────────────────────────────────────

  const binDir = path.join(INSTALL_DIR, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  ok(`Install directory: ${binDir}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssp-child-install-"));

  try {
    // ── 5. Download checksums ──────────────────────────────────────────

    info("Downloading checksums...");
    const checksumsPath = path.join(tmpDir, "checksums.txt");
    let checksums = {};
    try {
      await download(artifactUrl(version, "checksums.txt"), checksumsPath, authHeaders());
      const lines = fs.readFileSync(checksumsPath, "utf-8").split("\n");
      for (const line of lines) {
        const [hash, name] = line.trim().split(/\s+/);
        if (hash && name) checksums[name.replace(/^\.\//, "")] = hash;
      }
      ok("Checksums loaded");
    } catch {
      warn("Checksums not available — skipping verification.");
    }

    function verifyChecksum(filePath, fileName) {
      if (!checksums[fileName]) return;
      const actual = sha256File(filePath);
      if (actual !== checksums[fileName]) {
        fail(`Checksum mismatch for ${fileName}!\n Expected: ${checksums[fileName]}\n Got: ${actual}`);
      }
    }

    // ── 6. Download signing-server ─────────────────────────────────────

    const cloudSuffix = CLOUD ? "-cloud" : "";
    const serverName = `signing-server-${PLATFORM}-${ARCH}${cloudSuffix}${EXE}`;
    const serverDest = path.join(binDir, `signing-server${EXE}`);

    info(`Downloading ${serverName}...`);
    const serverTmp = path.join(tmpDir, serverName);
    await download(artifactUrl(version, serverName), serverTmp, authHeaders());
    verifyChecksum(serverTmp, serverName);
    fs.copyFileSync(serverTmp, serverDest);
    if (!IS_WINDOWS) fs.chmodSync(serverDest, 0o755);
    ok("signing-server installed");

    // ── 7. Download ssp-util ───────────────────────────────────────────

    const utilName = `ssp-util-${PLATFORM}-${ARCH}${EXE}`;
    const utilDest = path.join(binDir, `ssp-util${EXE}`);

    info(`Downloading ${utilName}...`);
    const utilTmp = path.join(tmpDir, utilName);
    await download(artifactUrl(version, utilName), utilTmp, authHeaders());
    verifyChecksum(utilTmp, utilName);
    fs.copyFileSync(utilTmp, utilDest);
    if (!IS_WINDOWS) fs.chmodSync(utilDest, 0o755);
    ok("ssp-util installed");

    // ── 8. Install wallet-cli ─────────────────────────────────────────

    info("Installing wallet-cli...");
    const walletTgzName = "wallet-cli-1.0.0.tgz";
    const walletTgzPath = path.join(tmpDir, walletTgzName);
    await download(artifactUrl(version, walletTgzName), walletTgzPath, authHeaders());
    verifyChecksum(walletTgzPath, walletTgzName);
    npm(`install -g --force "${walletTgzPath}"`);
    ok("wallet-cli installed");

    // ── 9. PATH setup ──────────────────────────────────────────────────

    const currentPath = process.env.PATH || "";
    if (!currentPath.split(path.delimiter).includes(binDir)) {
      if (!IS_WINDOWS) {
        const exportLine = `export PATH="${binDir}:$PATH"`;
        const shells = [
          path.join(os.homedir(), ".bashrc"),
          path.join(os.homedir(), ".zshrc"),
        ];
        for (const shellrc of shells) {
          if (fs.existsSync(shellrc)) {
            const content = fs.readFileSync(shellrc, "utf-8");
            if (!content.includes(binDir)) {
              fs.appendFileSync(shellrc, `\n# SSP signing stack\n${exportLine}\n`);
              ok(`Added ${binDir} to ${path.basename(shellrc)}`);
            }
          }
        }
      } else {
        try {
          execSync(`setx PATH "${binDir};%PATH%"`, { stdio: "pipe" });
          ok(`Added ${binDir} to user PATH`);
        } catch {
          warn(`Could not add ${binDir} to PATH. Add it manually.`);
        }
      }
    }

    // ── 10. Success banner ─────────────────────────────────────────────

    const serverPath = path.join(binDir, `signing-server${EXE}`);
    const utilPath = path.join(binDir, `ssp-util${EXE}`);
    const npmGlobalBin = execSync("npm prefix -g", { stdio: "pipe" }).toString().trim() + (IS_WINDOWS ? "" : "/bin");
    const execEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${npmGlobalBin}${path.delimiter}${process.env.PATH || ""}` };

    log("");
    log(`${c.green}${c.bold} ✓ SSP Agent-Child Mode Installed${c.reset}`);
    log(`${c.dim} ══════════════════════════════════${c.reset}`);
    log("");
    log(` signing-server  ${serverPath}`);
    log(` ssp-util        ${utilPath}`);
    log(` wallet-cli      ${which("wallet-cli", execEnv)}`);
    log("");
    log(`${c.bold} Usage (agent-child mode):${c.reset}`);
    log("");
    log(` Your agent must:`);
    log(`   1. Generate a random 32-byte HMAC key (64 hex chars)`);
    log(`   2. Set it in the child process environment as SSP_HMAC_KEY`);
    log(`   3. Spawn signing-server with the -spawned-by-agent flag`);
    log(`   4. Keep the key in memory to build HMAC proofs for sign requests`);
    log("");
    log(` Example (Node.js):`);
    log(`   ${c.cyan}const key = require('crypto').randomBytes(32).toString('hex');`);
    log(`   const child = spawn('signing-server', ['-spawned-by-agent', '-keystore', 'memory'], {`);
    log(`     env: { ...process.env, SSP_HMAC_KEY: key }`);
    log(`   });${c.reset}`);
    log("");
    log(` Example (Python):`);
    log(`   ${c.cyan}import os, subprocess`);
    log(`   key = os.urandom(32).hex()`);
    log(`   proc = subprocess.Popen(`);
    log(`     ['signing-server', '-spawned-by-agent', '-keystore', 'memory'],`);
    log(`     env={**os.environ, 'SSP_HMAC_KEY': key}`);
    log(`   )${c.reset}`);
    log("");
    log(` See ${c.cyan}skills/wikey-wallet-skill/SKILL.md${c.reset} for the full skill guide.`);
    log("");

    if (!IS_WINDOWS && !currentPath.includes(binDir)) {
      log(` ${c.yellow}Note:${c.reset} Restart your shell or run: ${c.cyan}export PATH="${binDir}:$PATH"${c.reset}`);
      log("");
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function which(cmd, env) {
  try {
    const opts = { stdio: "pipe" };
    if (env) opts.env = env;
    return execSync(IS_WINDOWS ? `where ${cmd}` : `which ${cmd}`, opts).toString().trim().split("\n")[0];
  } catch {
    return "(not found)";
  }
}

main().catch((err) => {
  console.error(`${isTTY ? "\x1b[31m" : ""}✗ Installation failed:${isTTY ? "\x1b[0m" : ""} ${err.message}`);
  process.exit(1);
});
