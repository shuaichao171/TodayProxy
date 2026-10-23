import { UpstreamError } from './client.js';
import { logger } from '../util/log.js';

const log = logger('reply');

export function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const content = part.content;
    if (typeof content === 'string') { chunks.push(content); continue; }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      chunks.push(content.text);
    }
  }
  return chunks.join('');
}

export function partsFromMessage(message) {
  return Array.isArray(message?.body?.parts) ? message.body.parts : [];
}

export function isAssistantMessageReady(event) {
  if (event?.event !== 'chat.message_ready.v2') return false;
  const data = event.data;
  if (!data || typeof data !== 'object') return false;
  return data?.message?.role === 'assistant' && typeof data.message.id === 'string';
}

/**
 * 等待某个会话的下一条 assistant 消息。
 *
 * 上游没有任何「请求-响应」绑定：`POST /v1/messages` 立刻返回 202，
 * 真正的回答通过 WebSocket 的 `chat.message_ready.v2` 广播过来（同账号所有在线设备都会收到）。
 * 所以这里做两件事：
 *   - 订阅长连接的 event.push（主通道）；
 *   - 定时 `GET /v2/messages?conversationId=…&after=…` 兜底（长连接不可用 / 事件丢失）。
 * 两条通道都只认「这个 conversationId 且 role=assistant」的消息，并且在返回前做一次 catch-up REST，
 * 避免「事件比订阅先到」的竞态。
 */
export class ReplyWaiter {
  constructor({ api, socketPool, config }) {
    this.api = api;
    this.socketPool = socketPool;
    this.config = config;
  }

  async wait(account, { conversationId, threadId, afterCursor = null, clientMessageId = null, since = 0, observedMessageIds = new Set(), timeoutMs, signal } = {}) {
    const limit = timeoutMs ?? this.config.upstream.replyTimeoutMs ?? 180000;
    const deadline = Date.now() + limit;
    const socket = this.socketPool?.ensure(account) ?? null;
    let settled = false;
    let timer = null;
    let pollTimer = null;

    // onEvent/onAbort 在外层声明：finish() 需要在 Promise 建立后仍能解绑它们。
    let onEvent = null;
    let onAbort = null;

    const finish = (resolve, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      if (onEvent) socket?.off('event', onEvent);
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };

    /**
     * 只认「这个会话 + 这次请求产生」的 assistant 消息。
     * 长连接在重连时可能重放历史事件，所以除了 conversationId 还要看来源：
     * originClientMessageId 精确匹配，或 createdAt 不早于本次发送时刻。
     */
    const matches = (message) => {
      if (!message || message.conversationId !== conversationId) return false;
      if (typeof message.id === 'string' && observedMessageIds.has(message.id)) return false;
      if (clientMessageId && message.originClientMessageId === clientMessageId) return true;
      if (Array.isArray(message.originClientMessageIds) && clientMessageId && message.originClientMessageIds.includes(clientMessageId)) return true;
      if (since > 0) {
        const created = Date.parse(message.createdAt ?? '');
        if (Number.isFinite(created)) return created >= since - 2000;
      }
      return true;
    };

    return await new Promise((resolve, reject) => {
      onAbort = () => {
        finish(reject, signal.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });

      onEvent = (event) => {
        if (event.event === 'chat.run_failed.v2') {
          const data = event.data ?? {};
          if (data.conversationId && data.conversationId !== conversationId) return;
          finish(reject, new UpstreamError(`上游任务失败：${data.reason ?? data.code ?? 'unknown'}`, {
            kind: 'RUN_FAILED',
            body: data,
          }));
          return;
        }
        if (!isAssistantMessageReady(event)) return;
        const data = event.data;
        if (!matches(data.message)) return;
        finish(resolve, {
          message: data.message,
          text: textFromParts(partsFromMessage(data.message)),
          parts: partsFromMessage(data.message),
          messageId: data.message.id,
          cursor: data.message.cursor ?? null,
          threadId: data.message.threadId ?? null,
          channel: 'socket',
        });
      };

      socket?.on('event', onEvent);

      const poll = async () => {
        if (settled) return;
        try {
          const messages = await this.api.listMessages(account, { conversationId, after: afterCursor ?? undefined, limit: 20 });
          for (const message of messages) {
            if (message.role !== 'assistant' || !message.id) continue;
            if (!matches(message)) continue;
            finish(resolve, {
              message,
              text: textFromParts(message.messages ?? partsFromMessage(message)),
              parts: message.messages ?? partsFromMessage(message),
              messageId: message.id,
              cursor: message.cursor ?? null,
              threadId: message.threadId ?? null,
              channel: 'rest',
            });
            return;
          }
        } catch (error) {
          log.debug('REST 兜底轮询失败', { error: error.message });
        }
      };

      // 立刻补一次：答案可能在订阅前就已经落库/广播。
      void poll();
      pollTimer = setInterval(() => { void poll(); }, Math.max(500, this.config.upstream.restPollIntervalMs ?? 1500));
      pollTimer.unref?.();

      timer = setTimeout(() => {
        finish(reject, new UpstreamError(`等待上游回复超时（${limit}ms）`, { kind: 'TIMEOUT', retryable: true }));
      }, limit);
      timer.unref?.();
    });
  }
}
