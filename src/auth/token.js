import { decodeJwt } from '../util/jwt.js';
import { readJson, request } from '../util/http.js';
import { logger } from '../util/log.js';

const log = logger('auth');

export class AuthError extends Error {
  constructor(message, { status, terminal = false, code } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status ?? null;
    this.terminal = terminal;
    this.code = code ?? null;
  }
}

/** Today 客户端发往账号服务的头（见 docs/REVERSE-ENGINEERING.md §2.1）。 */
export function accountHeaders(config, { bearer } = {}) {
  const headers = {
    accept: 'application/json',
    origin: config.upstream.webOrigin,
    'x-app-version': config.upstream.appVersion,
    'x-client-platform': config.upstream.clientPlatform,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

/**
 * better-auth session → api.todayai.cn 的访问 JWT。
 *
 * 桌面端走的是 `GET {authBase}/api/auth/token` + `Authorization: Bearer <session>`
 * （client-node-adapter 的 AccountSessionTokenClient.issue）。
 */
export async function issueAccessToken(config, sessionToken, { signal } = {}) {
  if (typeof sessionToken !== 'string' || sessionToken.length < 20) {
    throw new AuthError('sessionToken 为空或过短', { terminal: true });
  }
  const url = `${config.upstream.authBaseUrl.replace(/\/+$/u, '')}/api/auth/token`;
  const response = await request(url, {
    method: 'GET',
    headers: accountHeaders(config, { bearer: sessionToken }),
    timeoutMs: config.upstream.connectTimeoutMs,
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError('登录态已失效，需要在 Today 客户端重新登录', { status: response.status, terminal: true });
  }
  if (!response.ok) {
    throw new AuthError(`换取访问令牌失败：HTTP ${response.status}`, { status: response.status });
  }
  const body = await readJson(response);
  const token = typeof body?.token === 'string' ? body.token : null;
  if (!token) {
    throw new AuthError('账号服务返回 200 但没有 token');
  }
  const declared = Number(body?.expiresIn ?? body?.expires_in);
  const payload = decodeJwt(token);
  const expiresInSeconds = Number.isFinite(declared) && declared > 0
    ? declared
    : (typeof payload?.exp === 'number' ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : 540);
  return {
    accessToken: token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    claims: payload,
  };
}

/**
 * 确保账号手上有可用 accessToken。
 * `forceRefresh` 用于上游返回 401 后的强制刷新（并避免并发重复刷新）。
 */
export class TokenManager {
  constructor(config) {
    this.config = config;
    this.inflight = new Map();
  }

  needsRefresh(account) {
    const skew = (this.config.upstream.tokenSkewSeconds ?? 60) * 1000;
    if (!account.accessToken) return true;
    if (!Number.isFinite(account.accessTokenExpiresAt)) return true;
    return account.accessTokenExpiresAt - Date.now() <= skew;
  }

  async get(account, { forceRefresh = false, signal } = {}) {
    if (!forceRefresh && !this.needsRefresh(account)) return account.accessToken;
    const key = account.id;
    if (this.inflight.has(key)) return await this.inflight.get(key);
    const task = (async () => {
      const issued = await issueAccessToken(this.config, account.sessionToken, { signal });
      account.accessToken = issued.accessToken;
      account.accessTokenExpiresAt = issued.expiresAt;
      account.tokenIssuedAt = Date.now();
      log.debug('刷新访问令牌', { account: account.id, expiresIn: Math.round((issued.expiresAt - Date.now()) / 1000) });
      return issued.accessToken;
    })();
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }
}
