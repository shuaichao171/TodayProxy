import { accountHeaders } from '../auth/token.js';
import { NetworkError, readJson, request, withRetries } from '../util/http.js';
import { logger } from '../util/log.js';

const log = logger('upstream');

export class UpstreamError extends Error {
  constructor(message, { status = null, code = null, kind = 'UPSTREAM', body = null, retryable = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.kind = kind;
    this.body = body;
    this.retryable = retryable;
  }
}

/**
 * Today 上游 HTTP 客户端。
 *
 * 业务错误既可能用 HTTP 状态码表达，也可能用 `{success:false, code:'auth.forbidden'}` 信封表达，
 * 所以这里统一在 `parseEnvelope` 里判定，避免把失败当成功。
 */
export class TodayApi {
  constructor({ config, tokens, resolveToken }) {
    this.config = config;
    this.tokens = tokens;
    // resolveToken(account, {forceRefresh}) → accessToken
    this.resolveToken = resolveToken;
  }

  get baseUrl() {
    return this.config.upstream.apiBaseUrl.replace(/\/+$/u, '');
  }

  headers(account, token, extra) {
    return {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      origin: this.config.upstream.webOrigin,
      'x-app-version': this.config.upstream.appVersion,
      'x-client-platform': this.config.upstream.clientPlatform,
      ...extra,
    };
  }

  async fetch(account, path, { method = 'GET', body, headers, timeoutMs, signal, raw = false } = {}) {
    const token = await this.resolveToken(account, {});
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const send = async (accessToken) => withRetries(
      () => request(url, {
        method,
        headers: this.headers(account, accessToken, {
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        }),
        body: payload,
        timeoutMs: timeoutMs ?? this.config.upstream.connectTimeoutMs,
        signal,
      }),
      {
        retries: this.config.upstream.connectRetries ?? 0,
        onRetry: (attempt, error) => log.warn('上游连接失败，立即重连重试', { path, attempt, code: error.code }),
      },
    );

    let response = await send(token);
    if (response.status === 401 || response.status === 403) {
      // 令牌可能被服务端提前吊销：强制换一枚再打一次。
      const refreshed = await this.resolveToken(account, { forceRefresh: true });
      if (refreshed && refreshed !== token) {
        response = await send(refreshed);
      }
    }
    if (raw) return response;

    const text = await response.text();
    const json = text.trim() ? safeJson(text) : null;
    if (!response.ok) {
      throw classifyHttpError(response.status, json, text);
    }
    const envelope = parseEnvelope(json);
    if (envelope?.error) throw envelope.error;
    return { json: envelope?.value ?? json, text, status: response.status, headers: response.headers };
  }

  /** 注册/更新设备（`device.hello` 用同一个 deviceId）。 */
  async registerDevice(account, { deviceId, machineId, name, signal } = {}) {
    const { json } = await this.fetch(account, '/registry/devices', {
      method: 'POST',
      signal,
      body: {
        name: name ?? this.config.upstream.deviceName,
        clientPlatform: this.config.upstream.clientPlatform,
        clientType: this.config.upstream.clientType,
        platform: this.config.upstream.platform,
        version: this.config.upstream.appVersion,
        notificationEnabled: false,
        clientMachineId: machineId,
      },
    });
    const id = json?.device?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new UpstreamError('设备注册响应缺少 device.id', { kind: 'PROTOCOL' });
    }
    return { deviceId: id, device: json.device };
  }

  /** 换取一次性 WebSocket 票据。 */
  async issueWsTicket(account, { signal } = {}) {
    const result = await this.fetch(account, '/ws-ticket', { method: 'POST', signal });
    const ticket = result.json?.ticket;
    if (typeof ticket !== 'string' || ticket.length === 0) {
      throw new UpstreamError('ws-ticket 响应缺少 ticket', { kind: 'PROTOCOL' });
    }
    return { ticket, webSocketUrl: result.headers?.get?.('x-websocket-url')?.trim() || null };
  }

  /** 当前账号的协议能力（含 mainConversationId）。 */
  async protocolCapabilities(account, { signal } = {}) {
    const { json } = await this.fetch(account, '/v1/users/me/protocol-capabilities', { signal });
    return json?.data ?? json;
  }

  async me(account, { signal } = {}) {
    const { json } = await this.fetch(account, '/v1/users/me', { signal });
    return json;
  }

  async pricingStatus(account, { signal } = {}) {
    const { json } = await this.fetch(account, '/v1/pricing/status', { signal });
    return json?.data?.status ?? json;
  }

  /** 发消息。`target` 与 `conversationId` 二选一，语义见 docs/REVERSE-ENGINEERING.md §3.2。 */
  async sendMessage(account, payload, { signal } = {}) {
    const { json } = await this.fetch(account, '/v1/messages', { method: 'POST', body: payload, signal });
    const conversationId = json?.canonicalMessage?.conversationId ?? json?.conversationId ?? null;
    if (typeof json?.messageId !== 'string') {
      throw new UpstreamError('发消息响应缺少 messageId', { kind: 'PROTOCOL', body: json });
    }
    return {
      threadId: json.threadId ?? null,
      messageId: json.messageId,
      clientMessageId: json.clientMessageId ?? payload.clientMessageId ?? null,
      conversationId,
      taskId: json.taskId ?? null,
      createdAt: json.createdAt ?? null,
      isDuplicate: json.isDuplicate === true,
      cursor: json.canonicalMessage?.cursor ?? null,
      raw: json,
    };
  }

  /** 拉某个会话的消息（回复等待的兜底通道）。 */
  async listMessages(account, { conversationId, threadId, after, before, limit = 50, signal } = {}) {
    const query = new URLSearchParams();
    if (conversationId) query.set('conversationId', conversationId);
    if (threadId) query.set('threadId', threadId);
    if (after) query.set('after', after);
    if (before) query.set('before', before);
    if (limit) query.set('limit', String(limit));
    const { json } = await this.fetch(account, `/v2/messages?${query.toString()}`, { signal });
    return Array.isArray(json?.data) ? json.data : [];
  }

  async reportClientLog(account, body, { signal } = {}) {
    return await this.fetch(account, '/v1/client/logs', { method: 'POST', body, signal });
  }

  static buildWsUrl(apiBaseUrl, ticket, trafficLane) {
    const url = new URL(`${apiBaseUrl.replace(/\/+$/u, '')}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);
    if (trafficLane) url.searchParams.set('lane', trafficLane);
    return url.toString();
  }
}

export function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** 统一判定「HTTP 200 + 业务错误」的信封。 */
export function parseEnvelope(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { value: json, error: null };
  if (json.success === true) return { value: Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json, error: null };
  if (json.success === false) {
    const code = typeof json.code === 'string' ? json.code : null;
    const message = typeof json.message === 'string' && json.message ? json.message : '上游返回失败';
    const kind = code && (code.startsWith('auth.') ? 'AUTH' : 'BUSINESS') || 'BUSINESS';
    return {
      value: json,
      error: new UpstreamError(message, {
        code,
        kind,
        body: json,
        retryable: kind !== 'AUTH',
        status: 200,
      }),
    };
  }
  return { value: json, error: null };
}

export function classifyHttpError(status, json, text) {
  const message = typeof json?.message === 'string' && json.message
    ? json.message
    : (text ? text.slice(0, 200) : `HTTP ${status}`);
  if (status === 401 || status === 403) {
    return new UpstreamError(message, { status, kind: 'AUTH', body: json, retryable: false });
  }
  if (status === 429) {
    return new UpstreamError(message, { status, kind: 'RATE_LIMIT', body: json, retryable: true });
  }
  if (status === 404) {
    return new UpstreamError(message, { status, kind: 'NOT_FOUND', body: json, retryable: false });
  }
  if (status >= 500) {
    return new UpstreamError(message, { status, kind: 'UPSTREAM_5XX', body: json, retryable: true });
  }
  return new UpstreamError(message, { status, kind: 'UPSTREAM', body: json, retryable: false });
}

export { NetworkError };
