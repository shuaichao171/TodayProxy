import { JsonStore, JsonlLog } from '../util/store.js';

/**
 * 用量账本。
 *
 * Today 上游不回 token usage（回答里只有文本），所以 token 数一律是**本地估算**：
 * `ceil(chars/4)` 只是给下游客户端一个量级参考，不作为计费依据。
 * 真实「消耗」在服务端：`rapport.updated.v1` 事件里的 `currentPoints` 才是点数余额。
 */
export class Usage {
  constructor({ config }) {
    this.config = config;
    this.store = new JsonStore(`${config.paths.dataDir}/usage.json`, { fallback: { version: 1, totals: {}, recent: [] }, mode: 0o644 });
    this.log = new JsonlLog(`${config.paths.dataDir}/usage.jsonl`);
    this.data = this.store.read();
    this.data.totals ??= {};
    this.data.recent ??= [];
  }

  static estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    // 中文按 ~1 token/字，英文按 ~4 字符/token，取折中值让估算别偏太多。
    let cjk = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code >= 0x3000 && code <= 0x9fff) cjk += 1;
      else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
    }
    const rest = text.length - cjk;
    return Math.max(1, cjk + Math.ceil(rest / 4));
  }

  record(entry) {
    const item = {
      at: Date.now(),
      key: entry.keyId ?? null,
      account: entry.accountId ?? null,
      model: entry.model ?? null,
      mode: entry.mode ?? null,
      ok: entry.ok !== false,
      conversationId: entry.conversationId ?? null,
      latencyMs: entry.latencyMs ?? null,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      points: entry.points ?? null,
      error: entry.error ?? null,
    };
    this.log.append(item);
    const total = this.data.totals[item.model ?? 'unknown'] ??= { requests: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0 };
    total.requests += 1;
    if (item.ok) total.ok += 1; else total.failed += 1;
    total.promptTokens += item.promptTokens;
    total.completionTokens += item.completionTokens;
    total.lastAt = item.at;
    this.data.recent.unshift(item);
    if (this.data.recent.length > 200) this.data.recent.length = 200;
    this.store.flush();
    return item;
  }

  totals() {
    return this.data.totals;
  }

  recent(limit = 50) {
    return this.data.recent.slice(0, limit);
  }

  tail(limit = 200) {
    return this.log.tail(limit);
  }
}
