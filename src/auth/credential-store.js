import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 读取 Today 桌面端本机登录态。
 *
 * 取证结论（见 docs/REVERSE-ENGINEERING.md §4）：
 *   - 配置根：`%APPDATA%\<Today CN|Today|Today CN Dev>`（Electron app.getPath('userData')）
 *   - 凭据文件：`account-credentials.head` + `.slot-a` / `.slot-b`（双槽原子写，0600）
 *   - 密文格式：Chromium OSCrypt `v10` = AES-256-GCM(nonce12 | ciphertext | tag16)
 *     密钥来自 `Local State` 的 `os_crypt.encrypted_key`（去 `DPAPI` 前缀后用 DPAPI 解出的 32B）
 *   - 明文是 `{formatVersion, generation, record:{source, accessToken, accessTokenExpiresAt, refreshCredential, user}}`
 *
 * 因此导入本机登录态不需要破解任何东西：DPAPI 就是「当前 Windows 用户」的钥匙。
 */

const KEYSTORE_PREFIX = 'DPAPI';
const OSCrypt_MAGIC = 'v10';
const SLOT_SUFFIXES = ['slot-a', 'slot-b'];
const BASE_NAME = 'account-credentials';

export class TodayCredentialError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TodayCredentialError';
    Object.assign(this, details);
  }
}

/** 依次尝试候选目录，返回第一个含凭据文件的目录。 */
export function findUserDataDir({ explicit, candidates = [], env = process.env } = {}) {
  const tried = [];
  const roots = [];
  if (explicit) roots.push(explicit);
  const appData = env.APPDATA;
  if (appData) {
    for (const name of candidates.length ? candidates : ['Today CN']) {
      roots.push(path.join(appData, name));
    }
  }
  if (process.platform !== 'win32' && env.HOME) {
    for (const name of candidates) roots.push(path.join(env.HOME, 'Library/Application Support', name));
  }
  for (const root of roots) {
    tried.push(root);
    if (fs.existsSync(path.join(root, `${BASE_NAME}.head`)) || fs.existsSync(path.join(root, `${BASE_NAME}.slot-a`))) {
      return { dir: root, tried };
    }
  }
  return { dir: null, tried };
}

function powerShellUnprotect(encryptedKeyB64) {
  if (process.platform !== 'win32') {
    throw new TodayCredentialError('DPAPI 仅在 Windows 上可用；请改用 import-local --file 手动导入凭据。');
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$blob=[Convert]::FromBase64String('${encryptedKeyB64.replace(/'/gu, "''")}')`,
    '$key=[System.Security.Cryptography.ProtectedData]::Unprotect($blob[5..($blob.Length-1)],$null,\'CurrentUser\')',
    'Write-Output ([Convert]::ToBase64String($key))',
  ].join('; ');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error) {
    throw new TodayCredentialError(`DPAPI 解密失败（需要与 Today 同一 Windows 用户运行）：${error.message}`);
  }
  const key = Buffer.from(out.trim(), 'base64');
  if (key.length !== 32) {
    throw new TodayCredentialError(`DPAPI 解出的密钥长度异常：${key.length}（期望 32）`);
  }
  return key;
}

/** 从 Chromium `Local State` 取 OS 加密密钥。 */
export function readOsCryptKey(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new TodayCredentialError(`找不到 ${localStatePath}`);
  }
  let localState;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (error) {
    throw new TodayCredentialError(`Local State 不是合法 JSON：${error.message}`);
  }
  const encoded = localState?.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new TodayCredentialError('Local State 缺少 os_crypt.encrypted_key');
  }
  const blob = Buffer.from(encoded, 'base64');
  const prefix = blob.subarray(0, KEYSTORE_PREFIX.length).toString('ascii');
  if (prefix !== KEYSTORE_PREFIX) {
    // Chromium 的 app-bound 加密（`APPB`）没有用户态可用的解密材料，这里明确拒绝而不是瞎猜。
    throw new TodayCredentialError(`未支持的密钥封装：${prefix || blob.subarray(0, 4).toString('hex')}（仅支持 DPAPI）`);
  }
  return powerShellUnprotect(encoded);
}

/** 解开一个 `v10` 载荷。 */
export function decryptV10(key, payload) {
  const magic = payload.subarray(0, OSCrypt_MAGIC.length).toString('ascii');
  if (magic !== OSCrypt_MAGIC) {
    throw new TodayCredentialError(`未知密文前缀：${magic}`);
  }
  const nonce = payload.subarray(3, 15);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(15, payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function readHead(userDataDir) {
  const file = path.join(userDataDir, `${BASE_NAME}.head`);
  if (!fs.existsSync(file)) return null;
  const key = readOsCryptKey(userDataDir);
  const json = JSON.parse(decryptV10(key, fs.readFileSync(file)));
  return { ...json, key };
}

/** 读取双槽里 generation 有效的那条记录。 */
export function readCredential(userDataDir, { key: providedKey } = {}) {
  const head = readHead(userDataDir);
  const key = providedKey ?? head?.key;
  if (!key) {
    throw new TodayCredentialError(`找不到凭据（${userDataDir}）`);
  }
  if (head?.state && head.state !== 'signed-in') {
    throw new TodayCredentialError(`凭据状态为 ${head.state}，需要先在 Today 里登录`);
  }
  const order = [];
  if (typeof head?.slotIndex === 'number') order.push(head.slotIndex);
  order.push(0, 1);
  const seen = new Set();
  const errors = [];
  for (const index of order) {
    if (seen.has(index)) continue;
    seen.add(index);
    const file = path.join(userDataDir, `${BASE_NAME}.${SLOT_SUFFIXES[index]}`);
    if (!fs.existsSync(file)) continue;
    try {
      const slot = JSON.parse(decryptV10(key, fs.readFileSync(file)));
      if (slot?.record) return { head, slot, slotIndex: index, key };
    } catch (error) {
      errors.push(`${SLOT_SUFFIXES[index]}: ${error.message}`);
    }
  }
  throw new TodayCredentialError(`没有可解开的凭据槽（${errors.join('; ') || '全部缺失'}）`);
}

/** 面向 CLI 的高层封装：返回可直接写进账号池的字段。 */
export function readLocalLogin(options = {}) {
  const found = findUserDataDir({ explicit: options.explicit, candidates: options.candidates, env: options.env });
  if (!found.dir) {
    throw new TodayCredentialError(`未找到 Today 用户数据目录（已尝试：${found.tried.join(', ')}）`);
  }
  const { head, slot, slotIndex } = readCredential(found.dir);
  const record = slot.record;
  if (typeof record?.refreshCredential !== 'string' || record.refreshCredential.length === 0) {
    throw new TodayCredentialError('凭据里没有 refreshCredential（等价 better-auth session）');
  }
  return {
    userDataDir: found.dir,
    slotIndex,
    generation: slot.generation ?? null,
    formatVersion: slot.formatVersion ?? null,
    source: record.source,
    environment: record.environment,
    accessToken: record.accessToken ?? null,
    accessTokenExpiresAt: record.accessTokenExpiresAt ?? null,
    sessionToken: record.refreshCredential,
    user: record.user ?? null,
    headState: head?.state ?? null,
  };
}

export function describePlatform() {
  return { platform: process.platform, homedir: os.homedir(), appData: process.env.APPDATA ?? null };
}
