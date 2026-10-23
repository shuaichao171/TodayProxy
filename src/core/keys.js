import crypto from 'node:crypto';
import { JsonStore } from '../util/store.js';
import { logger } from '../util/log.js';

const log = logger('keys');

/** 下游密钥：明文只在创建时返回一次，落盘只存 sha256 摘要。 */
export class Keys {
  constructor({ config, file }) {
    this.config = config;
    this.store = new JsonStore(file ?? `${config.paths.dataDir}/keys.json`, { fallback: { version: 1, keys: [] } });
    const data = this.store.read();
    this.items = Array.isArray(data.keys) ? data.keys : [];
    this.cache = new Map();
    this.rate = new Map();
  }

  flush() {
    this.store.write({ version: 1, keys: this.items });
  }

  digest(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  create({ name, rpm = null, models = null, note = null } = {}) {
    const secret = `sk-today-${crypto.randomBytes(24).toString('base64url')}`;
    const record = {
      id: `key_${crypto.randomBytes(5).toString('hex')}`,
      name: name ?? `key-${this.items.length + 1}`,
      prefix: secret.slice(0, 12),
      hash: this.digest(secret),
      rpm: Number.isFinite(rpm) ? rpm : null,
      models: Array.isArray(models) && models.length ? models : null,
      note,
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: null,
      requests: 0,
    };
    this.items.push(record);
    this.flush();
    log.info('创建下游密钥', { id: record.id, name: record.name });
    return { record, secret };
  }

  list() {
    return this.items.map(({ hash, ...rest }) => ({ ...rest }));
  }

  remove(id) {
    const index = this.items.findIndex((k) => k.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.flush();
    return true;
  }

  update(id, patch) {
    const record = this.items.find((k) => k.id === id);
    if (!record) return null;
    for (const field of ['name', 'rpm', 'models', 'enabled', 'note']) {
      if (patch[field] !== undefined) record[field] = patch[field];
    }
    this.flush();
    return record;
  }

  /** 校验密钥；未命中时重读磁盘一次（外部进程新增的密钥也能用）。 */
  verify(secret) {
    if (typeof secret !== 'string' || secret.length === 0) return null;
    const hash = this.digest(secret);
    let record = this.items.find((k) => k.hash === hash);
    if (!record) {
      this.store.reload();
      this.items = this.store.read().keys ?? [];
      record = this.items.find((k) => k.hash === hash);
    }
    if (!record || !record.enabled) return null;
    return record;
  }

  /** 令牌桶（按分钟），0/未设置表示不限流。 */
  checkRate(record) {
    const limit = Number(record.rpm ?? this.config.limits.requestsPerMinutePerKey ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return { ok: true };
    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (this.rate.get(record.id) ?? []).filter((ts) => ts > windowStart);
    if (hits.length >= limit) {
      return { ok: false, retryAfterMs: 60_000 - (now - hits[0]) };
    }
    hits.push(now);
    this.rate.set(record.id, hits);
    return { ok: true };
  }

  touch(record) {
    record.requests = (record.requests ?? 0) + 1;
    record.lastUsedAt = Date.now();
    this.flush();
  }
}
