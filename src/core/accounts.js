import crypto from 'node:crypto';
import { JsonStore } from '../util/store.js';
import { logger } from '../util/log.js';

const log = logger('accounts');

const COOLDOWN_KINDS = new Set(['RATE_LIMIT', 'UPSTREAM_5XX', 'NETWORK', 'TIMEOUT', 'RUN_FAILED']);

export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
 * 账号池。
 *
 * Today 上游唯一的鉴权凭据是「登录 session」（等价 better-auth session token），
 * 14~60 天有效；accessToken 是它可以随时重新换出来的短命 JWT。
 * 所以账号池只需要保管 session，token 由 TokenManager 按需刷新。
 */
export class Accounts {
  constructor({ config, file }) {
    this.config = config;
    this.store = new JsonStore(file ?? `${config.paths.dataDir}/accounts.json`, { fallback: { version: 1, accounts: [] } });
    const data = this.store.read();
    this.items = Array.isArray(data.accounts) ? data.accounts : [];
    this.reconcile();
  }

  reconcile() {
    let dirty = false;
    for (const account of this.items) {
      if (!account.id) { account.id = `acc_${crypto.randomBytes(6).toString('hex')}`; dirty = true; }
      if (account.clientMachineId === undefined) { account.clientMachineId = crypto.randomUUID(); dirty = true; }
      if (account.enabled === undefined) { account.enabled = true; dirty = true; }
      if (account.status === undefined) { account.status = 'active'; dirty = true; }
    }
    if (dirty) this.flush();
  }

  flush() {
    this.store.write({ version: 1, accounts: this.items });
  }

  list() {
    return this.items;
  }

  get(idOrName) {
    if (!idOrName) return null;
    return this.items.find((a) => a.id === idOrName || a.name === idOrName || a.userId === idOrName) ?? null;
  }

  /** 服务端状态是「算出来的」，不是存出来的，避免脏状态。 */
  effectiveStatus(account) {
    if (!account.enabled) return 'disabled';
    if (account.status === 'invalid') return 'invalid';
    if (account.cooldownUntil && account.cooldownUntil > Date.now()) return 'cooling';
    return 'active';
  }

  publicView(account) {
    return {
      id: account.id,
      name: account.name,
      userId: account.userId ?? null,
      displayName: account.displayName ?? null,
      source: account.source ?? null,
      environment: account.environment ?? null,
      enabled: account.enabled !== false,
      status: this.effectiveStatus(account),
      invalidReason: account.invalidReason ?? null,
      cooldownUntil: account.cooldownUntil ?? null,
      lastUsedAt: account.lastUsedAt ?? null,
      lastError: account.lastError ?? null,
      tokenExpiresAt: account.accessTokenExpiresAt ?? null,
      deviceId: account.deviceId ?? null,
      sessionTokenPreview: maskSecret(account.sessionToken),
      hasToken: Boolean(account.accessToken),
      createdAt: account.createdAt ?? null,
      updatedAt: account.updatedAt ?? null,
      requests: account.requests ?? 0,
      failures: account.failures ?? 0,
    };
  }

  /** 上游已经确认 session 失效：隔离，直到人工重新导入。 */
  markInvalid(account, reason) {
    account.status = 'invalid';
    account.invalidReason = reason ?? '登录态失效';
    account.updatedAt = Date.now();
    this.flush();
    log.warn('账号登录态失效', { account: account.id, reason: account.invalidReason });
  }

  markFailure(account, error) {
    account.failures = (account.failures ?? 0) + 1;
    account.lastError = error?.message ? String(error.message).slice(0, 300) : String(error ?? '').slice(0, 300);
    account.updatedAt = Date.now();
    const kind = error?.kind ?? error?.code ?? 'UNKNOWN';
    if (kind === 'AUTH' || error?.status === 401 || error?.status === 403) {
      this.markInvalid(account, account.lastError);
      return;
    }
    if (COOLDOWN_KINDS.has(kind) || (error?.status ?? 0) >= 500) {
      account.cooldownUntil = Date.now() + (this.config.pool.cooldownSeconds ?? 60) * 1000;
    }
    this.flush();
  }

  markSuccess(account) {
    account.requests = (account.requests ?? 0) + 1;
    account.lastUsedAt = Date.now();
    account.cooldownUntil = null;
    account.lastError = null;
    account.updatedAt = Date.now();
    this.flush();
  }

  update(account, patch) {
    Object.assign(account, patch, { updatedAt: Date.now() });
    this.flush();
    return account;
  }

  /** 导入/更新账号：同一 userId 视为同一账号，只刷新凭据。 */
  upsert({ sessionToken, userId = null, displayName = null, name = null, source = 'import-local', environment = null, accessToken = null, accessTokenExpiresAt = null }) {
    if (typeof sessionToken !== 'string' || sessionToken.length < 20) {
      throw new Error('sessionToken 无效');
    }
    const existing = this.items.find((a) => (userId && a.userId === userId) || a.sessionToken === sessionToken);
    const now = Date.now();
    if (existing) {
      existing.sessionToken = sessionToken;
      if (userId) existing.userId = userId;
      if (displayName) existing.displayName = displayName;
      if (name) existing.name = name;
      if (accessToken) existing.accessToken = accessToken;
      if (accessTokenExpiresAt) existing.accessTokenExpiresAt = accessTokenExpiresAt;
      existing.source = source;
      existing.environment = environment ?? existing.environment ?? null;
      existing.status = 'active';
      existing.invalidReason = null;
      existing.cooldownUntil = null;
      existing.updatedAt = now;
      this.flush();
      log.info('更新账号凭据', { account: existing.id });
      return { account: existing, created: false };
    }
    const account = {
      id: `acc_${crypto.randomBytes(6).toString('hex')}`,
      name: name ?? (displayName || userId || `today-${this.items.length + 1}`),
      sessionToken,
      accessToken,
      accessTokenExpiresAt,
      userId,
      displayName,
      source,
      environment,
      clientMachineId: crypto.randomUUID(),
      deviceId: null,
      enabled: true,
      status: 'active',
      invalidReason: null,
      cooldownUntil: null,
      lastUsedAt: null,
      lastError: null,
      requests: 0,
      failures: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(account);
    this.flush();
    log.info('新增账号', { account: account.id, name: account.name });
    return { account, created: true };
  }

  remove(id) {
    const index = this.items.findIndex((a) => a.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.flush();
    return true;
  }
}
