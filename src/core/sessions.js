import crypto from 'node:crypto';
import { JsonStore } from '../util/store.js';
import { logger } from '../util/log.js';

const log = logger('sessions');
const MAX_TURNS = 400;

export function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** OpenAI/Anthropic 的 messages → 规范化的轮次列表。 */
export function toTurns(messages = []) {
  const turns = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
    const text = normalizeContent(message.content ?? message.text).trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

export function splitSystem(turns) {
  const system = turns.filter((t) => t.role === 'system').map((t) => t.text).join('\n\n').trim();
  const dialog = turns.filter((t) => t.role !== 'system');
  return { system, dialog };
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left[i].role === right[i].role && left[i].text === right[i].text) i += 1;
  return i;
}

function fingerprint(turns) {
  const seed = turns.slice(0, 1).map((t) => `${t.role}:${t.text}`).join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

/**
 * 下游会话 → Today 会话的映射。
 *
 * Today 的会话是**有状态**的：`POST /v1/messages` 只带增量，历史由服务端维护。
 * 而 OpenAI 客户端每次都把完整历史发过来，直接把历史整段转发会让上下文平方级膨胀。
 * 所以这里维护一份「已经推给上游的轮次」，下次请求只推新增的尾巴；
 * 一旦发现客户端历史与我们的记录分叉（换了会话、截断窗口），就开一个新会话重放。
 */
export class Sessions {
  constructor({ config, file }) {
    this.config = config;
    this.store = new JsonStore(file ?? `${config.paths.dataDir}/sessions.json`, { fallback: { version: 1, sessions: {} }, mode: 0o600 });
    const data = this.store.read();
    this.items = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  }

  flush() {
    this.store.write({ version: 1, sessions: this.items });
  }

  static deriveKey({ headerKey, bodyKey, turns, system }) {
    if (headerKey) return `h:${crypto.createHash('sha256').update(headerKey).digest('hex').slice(0, 32)}`;
    if (bodyKey) return `b:${crypto.createHash('sha256').update(String(bodyKey)).digest('hex').slice(0, 32)}`;
    // 只用「第一条非 system 轮次」做种子：客户端下一轮会把历史一并发回来，
    // 用更多轮次会让 key 每轮都变，等于每轮都新开一个 Today 会话。
    const first = turns.filter((t) => t.role !== 'system').slice(0, 1).map((t) => `${t.role}:${t.text}`).join('\u0000');
    const seed = `${system ?? ''}\u0000${first}`;
    if (!seed.trim()) return null;
    return `f:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
  }

  get(key) {
    const record = this.items[key];
    if (!record) return null;
    const ttl = (this.config.pool.conversationTtlSeconds ?? 86400) * 1000;
    if (ttl > 0 && Date.now() - (record.updatedAt ?? 0) > ttl) {
      delete this.items[key];
      this.flush();
      return null;
    }
    return record;
  }

  put(key, patch) {
    const record = this.items[key] ?? { key, createdAt: Date.now() };
    Object.assign(record, patch, { updatedAt: Date.now() });
    if (Array.isArray(record.turns) && record.turns.length > MAX_TURNS) {
      record.turns = record.turns.slice(-MAX_TURNS);
    }
    this.items[key] = record;
    this.flush();
    return record;
  }

  drop(key) {
    if (!this.items[key]) return false;
    delete this.items[key];
    this.flush();
    return true;
  }

  purgeExpired() {
    const ttl = (this.config.pool.conversationTtlSeconds ?? 86400) * 1000;
    if (ttl <= 0) return 0;
    const cutoff = Date.now() - ttl;
    let removed = 0;
    for (const [key, record] of Object.entries(this.items)) {
      if ((record.updatedAt ?? 0) < cutoff) { delete this.items[key]; removed += 1; }
    }
    if (removed) this.flush();
    return removed;
  }

  list() {
    return Object.values(this.items).map(({ turns, ...rest }) => ({ ...rest, turnCount: turns?.length ?? 0 }));
  }

  /**
   * 决策：这一发应该新开会话还是复用已有会话，以及要发哪些轮次。
   * @returns {{mode:'new'|'continue'|'main', conversationId:string|null, delta:Array, record:object|null, reset:boolean}}
   */
  plan(key, { turns, conversationMode, existing = null }) {
    const mode = conversationMode ?? this.config.pool.conversationMode ?? 'session';
    if (mode === 'main') {
      const record = key ? this.get(key) : null;
      const pushed = record?.turns ?? [];
      const prefix = commonPrefixLength(pushed, turns);
      const delta = turns.slice(prefix);
      return { mode: 'main', conversationId: null, delta: delta.length ? delta : turns.slice(-1), record, reset: false };
    }
    if (mode === 'task') {
      return { mode: 'new', conversationId: null, delta: turns, record: null, reset: false };
    }
    const record = existing ?? (key ? this.get(key) : null);
    if (!record || !record.conversationId) {
      return { mode: 'new', conversationId: null, delta: turns, record, reset: false };
    }
    const pushed = Array.isArray(record.turns) ? record.turns : [];
    const prefix = commonPrefixLength(pushed, turns);
    if (prefix >= pushed.length && turns.length > prefix) {
      return { mode: 'continue', conversationId: record.conversationId, delta: turns.slice(prefix), record, reset: false };
    }
    if (prefix >= pushed.length && turns.length === prefix) {
      // 客户端重放同一份历史（重试）：把最后一条用户消息再问一次。
      const lastUser = [...turns].reverse().find((t) => t.role === 'user');
      return {
        mode: 'continue',
        conversationId: record.conversationId,
        delta: lastUser ? [lastUser] : turns.slice(-1),
        record,
        reset: false,
      };
    }
    log.info('会话分叉，重开 Today 会话', { key, stored: pushed.length, incoming: turns.length, prefix });
    return { mode: 'new', conversationId: null, delta: turns, record, reset: true };
  }

  /** 把多条轮次压成一段文本（上游一次只接受一「发」消息）。 */
  static flatten(turns, { label = true } = {}) {
    return turns.map((turn) => {
      const prefix = label ? (turn.role === 'assistant' ? 'Assistant: ' : turn.role === 'system' ? 'System: ' : 'User: ') : '';
      return `${prefix}${turn.text}`;
    }).join('\n\n');
  }

  static fingerprint(turns) {
    return fingerprint(turns);
  }
}
