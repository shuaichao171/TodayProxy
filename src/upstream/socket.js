import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TodayApi } from './client.js';
import { logger } from '../util/log.js';

const log = logger('socket');

const HANDSHAKE_TIMEOUT_MS = 15000;
const DEFAULT_HEARTBEAT_MS = 30000;
const MIN_HEARTBEAT_MS = 5000;
const MAX_HEARTBEAT_MS = 120000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_CAP_MS = 30000;
const MAX_SEQUENCE_BUFFER = 512;
export const MESSAGE_PROTOCOL_VERSION = 'canonical-v1';
export const REPLACED_BY_NEWER_CONNECTION_CLOSE_CODE = 4001;

/**
 * Today Cloud WebSocket（canonical-v1）。
 *
 * 协议取自桌面端 `packages/socket/src/classic`（见 docs/REVERSE-ENGINEERING.md §3.3）：
 *   1. `POST /registry/devices` 注册设备（同一 deviceId 一直复用）
 *   2. `POST /ws-ticket` 换一次性票据
 *   3. `wss://<api>/ws?ticket=…`
 *   4. `device.hello`（首连）/ `device.resume`（重连）
 *   5. 收到 `cloud.hello_ack` 后开心跳，`client.received` 逐帧回执
 *   6. `event.push` 就是上层要的消息
 */
export class TodaySocket extends EventEmitter {
  constructor({ config, api, account, resolveToken, onAccountChange, WebSocketImpl } = {}) {
    super();
    this.config = config;
    this.api = api ?? new TodayApi({ config, resolveToken });
    this.account = account;
    this.resolveToken = resolveToken;
    this.onAccountChange = onAccountChange ?? (() => {});
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;

    this.status = 'idle';
    this.started = false;
    this.stopped = false;
    this.connecting = false;
    this.socket = null;
    this.attempt = 0;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.handshakeTimer = null;
    this.sessionId = null;
    this.lastSeq = 0;
    this.sequenceBuffer = new Map();
    this.heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
    this.awaitingHeartbeatAck = false;
    this.stats = { framesIn: 0, framesOut: 0, events: 0, reconnects: 0, connectedAt: null };
  }

  describe() {
    return {
      accountId: this.account?.id ?? null,
      status: this.status,
      deviceId: this.account?.deviceId ?? null,
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      connectedAt: this.stats.connectedAt,
      framesIn: this.stats.framesIn,
      framesOut: this.stats.framesOut,
      events: this.stats.events,
      reconnects: this.stats.reconnects,
    };
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('state', status, this.describe());
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.WebSocketImpl) {
      log.warn('当前 Node 没有全局 WebSocket，跳过长连接（回复等待会退回 REST 轮询）');
      this.setStatus('unavailable');
      return;
    }
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshakeTimer);
    clearInterval(this.heartbeatTimer);
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.heartbeatTimer = null;
    try { this.socket?.close(1000, 'shutdown'); } catch { /* ignore */ }
    this.socket = null;
    this.setStatus('closed');
  }

  nextDelay() {
    const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    return BACKOFF_MIN_MS + Math.floor(Math.random() * (exp - BACKOFF_MIN_MS));
  }

  scheduleRetry(reason) {
    if (this.stopped || this.retryTimer) return;
    const delay = this.nextDelay();
    log.warn('重建长连接', { account: this.account?.id, delay, reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  async ensureDevice({ signal } = {}) {
    if (this.account.deviceId) return this.account.deviceId;
    const machineId = this.account.clientMachineId ??= crypto.randomUUID();
    const { deviceId } = await this.api.registerDevice(this.account, { machineId, signal });
    this.account.deviceId = deviceId;
    this.account.clientMachineId = machineId;
    this.onAccountChange(this.account);
    log.info('已注册设备', { account: this.account.id, deviceId });
    return deviceId;
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    this.setStatus('connecting');
    try {
      const token = await this.resolveToken(this.account, {});
      const deviceId = await this.ensureDevice();
      const ticket = await this.api.issueWsTicket(this.account);
      const url = ticket.webSocketUrl ?? TodayApi.buildWsUrl(this.config.upstream.apiBaseUrl, ticket.ticket);
      this.open(url, deviceId);
    } catch (error) {
      log.warn('长连接建立失败', { account: this.account?.id, error: error.message });
      this.setStatus('error');
      this.scheduleRetry(error.message);
    } finally {
      this.connecting = false;
    }
  }

  open(url, deviceId) {
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (error) {
      this.scheduleRetry(`WebSocket 构造失败: ${error.message}`);
      return;
    }
    this.socket = ws;
    const session = this.sessionId;
    const resumeFrom = this.lastSeq;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      if (session) {
        this.send({ type: 'device.resume', sessionId: session, lastSeq: resumeFrom });
      } else {
        this.sendHello(deviceId);
      }
      this.armHandshake(ws);
    };

    ws.onmessage = (event) => {
      if (this.socket !== ws) return;
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      this.stats.framesIn += 1;
      this.handleFrame(ws, frame);
    };

    ws.onerror = () => {
      if (this.socket !== ws) return;
      log.debug('WebSocket error', { account: this.account?.id });
    };

    ws.onclose = (event) => {
      if (this.socket !== ws) return;
      this.socket = null;
      clearTimeout(this.handshakeTimer);
      clearInterval(this.heartbeatTimer);
      this.handshakeTimer = null;
      this.heartbeatTimer = null;
      this.awaitingHeartbeatAck = false;
      this.stats.connectedAt = null;
      const code = event?.code ?? 0;
      const replaced = code === REPLACED_BY_NEWER_CONNECTION_CLOSE_CODE;
      // 服务端因为「同一账号有新连接」踢掉旧连接时，服务端保留新的那条；
      // 我们主动重连会被再踢，所以这种关闭直接让位（退避重连仍然可用）。
      this.setStatus('disconnected');
      if (this.stopped) return;
      this.stats.reconnects += 1;
      this.scheduleRetry(replaced ? 'replaced_by_newer_connection' : `close ${code}`);
    };
  }

  armHandshake(ws) {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (this.socket !== ws || this.status === 'connected') return;
      log.warn('握手超时，重连', { account: this.account?.id });
      try { ws.close(4000, 'handshake timeout'); } catch { /* ignore */ }
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();
  }

  sendHello(deviceId) {
    this.send({
      type: 'device.hello',
      deviceId,
      tools: [],
      messageProtocolVersion: MESSAGE_PROTOCOL_VERSION,
      messageReactionsVersion: 'v1',
      messageReactionsContinueVersion: 'v1',
      messageReactionsVariantsVersion: 'v1',
      messageReactionsUnicodeVersion: 'v1',
    });
  }

  send(frame) {
    if (!this.socket) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      this.stats.framesOut += 1;
      return true;
    } catch (error) {
      log.debug('发送失败', { error: error.message });
      return false;
    }
  }

  handleFrame(ws, frame) {
    const type = typeof frame.type === 'string' ? frame.type : '';
    // 逐帧回执：服务端据此维护投递游标。
    if (typeof frame.id === 'string' && type && frame.timestamp) {
      this.send({
        type: 'client.received',
        originId: frame.id,
        originType: type,
        ...(typeof frame.seq === 'number' ? { originSeq: frame.seq } : {}),
        originTimestamp: frame.timestamp,
      });
    }

    if (type === 'cloud.hello_ack') {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : this.sessionId;
      const interval = Number(frame.heartbeatIntervalMs);
      this.heartbeatIntervalMs = Number.isFinite(interval) && interval > 0
        ? Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, interval))
        : DEFAULT_HEARTBEAT_MS;
      this.account.protocolVersion = frame.messageProtocolVersion ?? null;
      this.setStatus('connected');
      this.stats.connectedAt = Date.now();
      this.attempt = 0;
      this.startHeartbeat();
      this.drainSequence();
      return;
    }

    if (type === 'cloud.resume_ok') {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.setStatus('connected');
      this.stats.connectedAt = Date.now();
      this.attempt = 0;
      this.startHeartbeat();
      this.drainSequence();
      return;
    }

    if (type === 'cloud.resume_failed') {
      log.warn('服务端拒绝恢复会话，重新握手', { account: this.account?.id });
      this.sessionId = null;
      this.lastSeq = 0;
      this.sequenceBuffer.clear();
      const deviceId = this.account.deviceId;
      if (deviceId) this.sendHello(deviceId);
      this.armHandshake(ws);
      return;
    }

    if (type === 'cloud.heartbeat_ack') {
      this.awaitingHeartbeatAck = false;
      return;
    }

    if (typeof frame.seq === 'number') {
      if (frame.seq <= this.lastSeq) return;
      if (frame.seq > this.lastSeq + 1) {
        if (this.sequenceBuffer.size >= MAX_SEQUENCE_BUFFER) {
          // 缓冲打满就不再等缺口，按到达顺序放行，避免整条链路被一个丢包卡死。
          log.warn('序号缓冲溢出，降级按到达顺序投递', { account: this.account?.id, lastSeq: this.lastSeq });
          this.sequenceBuffer.clear();
          this.lastSeq = frame.seq - 1;
        } else {
          this.sequenceBuffer.set(frame.seq, frame);
          return;
        }
      }
      this.lastSeq = frame.seq;
      this.deliver(frame);
      this.drainSequence();
      return;
    }

    this.deliver(frame);
  }

  drainSequence() {
    let next = this.lastSeq + 1;
    while (this.sequenceBuffer.has(next)) {
      const frame = this.sequenceBuffer.get(next);
      this.sequenceBuffer.delete(next);
      this.lastSeq = next;
      this.deliver(frame);
      next += 1;
    }
  }

  deliver(frame) {
    if (frame.type === 'error') {
      log.warn('上游返回 error 帧', { message: frame.message, account: this.account?.id });
      this.emit('frame-error', frame);
      return;
    }
    if (frame.type !== 'event.push') return;
    const payload = frame.payload ?? {};
    const name = typeof payload.event === 'string' ? payload.event : null;
    if (!name) return;
    this.stats.events += 1;
    this.emit('event', {
      event: name,
      data: payload.data ?? null,
      threadId: payload.threadId ?? null,
      seq: frame.seq ?? null,
    });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.awaitingHeartbeatAck = false;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) return;
      this.send({ type: 'device.heartbeat', deviceId: this.account.deviceId ?? null });
      this.awaitingHeartbeatAck = true;
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** 把「在聊天里」状态同步给云端（服务端据此做用户级通知抑制）。 */
  sendClientStatus(inChat) {
    return this.send({ type: 'client.status', status: inChat ? 'in_chat' : 'idle' });
  }

  /** 主动请求恢复（丢包时用）。 */
  requestResume() {
    if (!this.sessionId || !this.socket) return false;
    this.send({ type: 'device.resume', sessionId: this.sessionId, lastSeq: this.lastSeq });
    return true;
  }
}

/** 每个账号一条长连接，按需创建。 */
export class SocketPool {
  constructor({ config, api, resolveToken, onAccountChange }) {
    this.config = config;
    this.api = api;
    this.resolveToken = resolveToken;
    this.onAccountChange = onAccountChange;
    this.sockets = new Map();
  }

  get(account) {
    if (!account) return null;
    if (!this.config.upstream.socketEnabled) return null;
    let socket = this.sockets.get(account.id);
    if (!socket) {
      socket = new TodaySocket({
        config: this.config,
        api: this.api,
        account,
        resolveToken: this.resolveToken,
        onAccountChange: this.onAccountChange,
      });
      this.sockets.set(account.id, socket);
    }
    return socket;
  }

  ensure(account) {
    const socket = this.get(account);
    socket?.start();
    return socket;
  }

  stop(accountId) {
    const socket = this.sockets.get(accountId);
    socket?.stop();
    this.sockets.delete(accountId);
  }

  stopAll() {
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
  }

  describe() {
    return [...this.sockets.values()].map((socket) => socket.describe());
  }
}
