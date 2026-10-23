import crypto from 'node:crypto';
import { Sessions, splitSystem, toTurns } from './sessions.js';
import { resolveModel } from './models.js';
import { UpstreamError } from '../upstream/client.js';
import { logger } from '../util/log.js';

const log = logger('executor');

/**
 * 账号选择：策略 + 冷却 + 会话亲和。
 * 顺序只影响「先试哪个账号」，失败换号由 Executor 负责。
 */
export class Scheduler {
  constructor({ config, accounts }) {
    this.config = config;
    this.accounts = accounts;
    this.cursor = 0;
    this.affinity = new Map();
  }

  candidates({ affinityKey } = {}) {
    const usable = this.accounts.list().filter((account) => this.accounts.effectiveStatus(account) === 'active');
    if (usable.length === 0) return [];
    const strategy = this.config.pool.strategy ?? 'round-robin';
    let ordered;
    if (strategy === 'fill-first') {
      ordered = [...usable].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    } else if (strategy === 'weighted') {
      ordered = [...usable].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
    } else {
      const size = usable.length;
      this.cursor = (this.cursor + 1) % size;
      ordered = [...usable.slice(this.cursor), ...usable.slice(0, this.cursor)];
    }
    if (this.config.pool.sessionAffinity && affinityKey) {
      const pinnedId = this.affinity.get(affinityKey);
      const pinned = ordered.find((account) => account.id === pinnedId);
      if (pinned) {
        ordered = [pinned, ...ordered.filter((account) => account.id !== pinned.id)];
      }
    }
    return ordered;
  }

  pin(affinityKey, accountId) {
    if (!this.config.pool.sessionAffinity || !affinityKey) return;
    this.affinity.set(affinityKey, accountId);
    if (this.affinity.size > 2000) {
      const oldest = this.affinity.keys().next().value;
      if (oldest !== undefined) this.affinity.delete(oldest);
    }
  }

  release(accountId) {
    for (const [key, value] of this.affinity) if (value === accountId) this.affinity.delete(key);
  }
}

/**
 * 一轮下游请求的完整流程：选账号 → 发送 → 等回复 → 记账。
 * 只在「还没把任何字节吐给客户端」之前换账号重试。
 */
export class Executor {
  constructor({ config, accounts, sessions, api, socketPool, replier, usage, scheduler }) {
    this.config = config;
    this.accounts = accounts;
    this.sessions = sessions;
    this.api = api;
    this.socketPool = socketPool;
    this.replier = replier;
    this.usage = usage;
    this.scheduler = scheduler;
  }

  buildPayload({ plan, text, system, clientMessageId }) {
    const payload = {
      body: { parts: [{ id: crypto.randomUUID(), type: 'text', text }] },
      clientMessageId,
    };
    if (plan.mode === 'main') payload.isMainChat = true;
    else if (plan.mode === 'continue') payload.conversationId = plan.conversationId;
    else payload.target = { type: 'new_task', surface: 'task_panel' };
    if (system) payload.__system = system;
    delete payload.__system;
    return payload;
  }

  composeText(delta, system) {
    const body = Sessions.flatten(delta);
    if (!system) return body;
    return `[用户提供的系统设定，仅在与本次对话相关时遵循]\n${system}\n\n[对话]\n${body}`;
  }

  /**
   * @returns {{ reply, account, conversationId, turns, plan, latencyMs, promptTokens }}
   */
  async run({ messages, model, keyRecord, headerKey, bodyKey, signal, onAccountStart }) {
    const turns = toTurns(messages);
    if (!turns.some((turn) => turn.role === 'user')) {
      throw new UpstreamError('请求里没有 user 消息', { kind: 'BAD_REQUEST' });
    }
    const { system, dialog } = splitSystem(turns);
    const resolved = resolveModel(model);
    const sessionKey = Sessions.deriveKey({ headerKey, bodyKey, turns, system }) ?? `anon:${crypto.randomUUID()}`;
    const affinityKey = `${keyRecord?.id ?? 'anon'}:${sessionKey}`;

    const candidates = this.scheduler.candidates({ affinityKey });
    if (candidates.length === 0) {
      throw new UpstreamError('账号池里没有可用账号（先跑 `node src/cli.js import-local`）', { kind: 'NO_ACCOUNT' });
    }

    const attempts = Math.min(candidates.length, 1 + (this.config.pool.maxRetries ?? 0));
    let lastError = null;
    for (let index = 0; index < attempts; index += 1) {
      const account = candidates[index];
      const startedAt = Date.now();
      const plan = this.sessions.plan(sessionKey, {
        turns: dialog,
        conversationMode: resolved.conversationMode ?? undefined,
      });
      const delta = plan.delta.length ? plan.delta : dialog.slice(-1);
      const text = this.composeText(delta, system);
      const clientMessageId = crypto.randomUUID();
      onAccountStart?.({ account, plan, attempt: index });
      try {
        this.socketPool?.ensure(account);
        const sent = await this.api.sendMessage(account, this.buildPayload({ plan, text, clientMessageId }), { signal });
        const conversationId = sent.conversationId ?? plan.conversationId;
        if (!conversationId) {
          throw new UpstreamError('上游没有返回 conversationId', { kind: 'PROTOCOL' });
        }
        const reply = await this.replier.wait(account, {
          conversationId,
          threadId: sent.threadId,
          afterCursor: sent.cursor,
          clientMessageId,
          since: startedAt,
          signal,
        });
        this.accounts.markSuccess(account);
        this.scheduler.pin(affinityKey, account.id);
        this.sessions.put(sessionKey, {
          accountId: account.id,
          conversationId,
          taskId: sent.taskId ?? plan.record?.taskId ?? null,
          cursor: reply.cursor ?? sent.cursor ?? null,
          turns: dialog,
        });
        return {
          reply,
          account,
          conversationId,
          sessionKey,
          newConversation: plan.mode === 'new',
          planMode: plan.mode,
          turns: delta,
          latencyMs: Date.now() - startedAt,
          promptTokens: this.usage.constructor.estimateTokens(text),
        };
      } catch (error) {
        lastError = error;
        this.accounts.markFailure(account, error);
        this.scheduler.release(account.id);
        log.warn('本次尝试失败', {
          account: account.id,
          kind: error.kind ?? error.name,
          error: String(error.message).slice(0, 200),
          willRetry: index + 1 < attempts,
        });
        if (error?.kind === 'BAD_REQUEST' || error?.name === 'AbortError') throw error;
      }
    }
    throw lastError ?? new UpstreamError('全部账号尝试失败', { kind: 'EXHAUSTED' });
  }
}
