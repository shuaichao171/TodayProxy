import http from 'node:http';
import { Accounts } from './core/accounts.js';
import { Keys } from './core/keys.js';
import { Usage } from './core/usage.js';
import { Sessions } from './core/sessions.js';
import { Executor, Scheduler } from './core/executor.js';
import { TodayApi } from './upstream/client.js';
import { SocketPool } from './upstream/socket.js';
import { ReplyWaiter } from './upstream/replier.js';
import { TokenManager } from './auth/token.js';
import { openaiRoutes } from './routes/openai.js';
import { anthropicRoutes } from './routes/anthropic.js';
import { adminRoutes } from './routes/admin.js';
import { messageForError, sendError, sendJson, statusForError } from './routes/shared.js';
import { logger } from './util/log.js';

const log = logger('server');

/** 活着的 context。CLI 命令跑完后必须把它们的长连接收干净，否则事件循环不空、进程不退出。 */
const LIVE_CONTEXTS = new Set();

/** 收所有 context 的长连接（CLI 收尾用；server 自己走 server.on('close')）。 */
export function disposeAllContexts() {
  for (const ctx of LIVE_CONTEXTS) {
    try { ctx.dispose(); } catch { /* 收尾失败不影响退出码 */ }
  }
  LIVE_CONTEXTS.clear();
}

/** 组装全部服务；CLI 与 server 共用同一套实例。 */
export function createContext(config) {
  const accounts = new Accounts({ config });
  const keys = new Keys({ config });
  const usage = new Usage({ config });
  const sessions = new Sessions({ config });
  const tokens = new TokenManager(config);

  const resolveToken = async (account, { forceRefresh = false } = {}) => {
    const token = await tokens.get(account, { forceRefresh });
    accounts.flush();
    return token;
  };

  const api = new TodayApi({ config, tokens, resolveToken });
  const socketPool = new SocketPool({
    config,
    api,
    resolveToken,
    onAccountChange: () => accounts.flush(),
  });
  const replier = new ReplyWaiter({ api, socketPool, config });
  const scheduler = new Scheduler({ config, accounts });
  const executor = new Executor({ config, accounts, sessions, api, socketPool, replier, usage, scheduler });

  const dispose = () => socketPool.stopAll();
  const ctx = { config, accounts, keys, usage, sessions, tokens, api, socketPool, replier, scheduler, executor, dispose };
  LIVE_CONTEXTS.add(ctx);
  return ctx;
}

function extractKey(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (auth.startsWith('sk-')) return auth.trim();
  if (typeof req.headers['x-api-key'] === 'string') return req.headers['x-api-key'].trim();
  return null;
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] };
      continue;
    }
    const match = route.path.exec(pathname);
    if (match) return { route, params: match.slice(1).map((value) => decodeURIComponent(value)) };
  }
  return null;
}

export function createServer(context) {
  const { config, accounts, keys, usage, sessions, socketPool, executor } = context;
  const admin = adminRoutes({
    config,
    accounts,
    keys,
    usage,
    sessions,
    executor,
    socketPool,
    tokens: context.tokens,
    api: context.api,
    replier: context.replier,
  });
  const routes = [
    ...openaiRoutes({ config, executor, usage, keys }),
    ...anthropicRoutes({ config, executor, usage }),
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (config.server.cors) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (pathname === '/admin' || pathname === '/admin/') {
        await admin.serveStatic({ req, res, params: [] });
        return;
      }
      if (pathname.startsWith('/admin/api/')) {
        const matched = matchRoute(admin.routes, req.method, pathname);
        if (!matched) return sendError(res, 404, `未知的管理接口 ${req.method} ${pathname}`);
        await matched.route.handler({ req, res, params: matched.params });
        return;
      }

      if (pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          accounts: accounts.list().length,
          active: accounts.list().filter((a) => accounts.effectiveStatus(a) === 'active').length,
          sockets: socketPool.describe(),
        });
      }

      const matched = matchRoute(routes, req.method, pathname);
      if (!matched) return sendError(res, 404, `未知接口 ${req.method} ${pathname}`);

      const secret = extractKey(req);
      const keyRecord = keys.verify(secret);
      if (!keyRecord) {
        return sendError(res, 401, '缺少或无效的 API Key（Authorization: Bearer sk-today-…）', { type: 'authentication_error' });
      }
      const rate = keys.checkRate(keyRecord);
      if (!rate.ok) {
        return sendError(res, 429, '密钥请求过于频繁', { type: 'rate_limit_error', retry_after_ms: rate.retryAfterMs });
      }
      if (config.limits.requestsPerMinutePerKey === 0 && keyRecord.rpm === null) {
        // 未配置限流：不记账限流窗口。
      }
      keys.touch(keyRecord);
      await matched.route.handler({ req, res, params: matched.params, keyRecord });
    } catch (error) {
      log.error('请求处理异常', { method: req.method, path: pathname, error: error.message });
      if (!res.headersSent) sendError(res, statusForError(error), messageForError(error));
      else if (!res.writableEnded) res.end();
    }
  });

  server.on('close', () => socketPool.stopAll());
  return server;
}

export async function startServer(config, { context } = {}) {
  const ctx = context ?? createContext(config);
  const server = createServer(ctx);
  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
  const { port, address } = server.address();
  log.info('网关已启动', { url: `http://${address}:${port}`, admin: `http://${address}:${port}/admin` });
  return { server, context: ctx };
}
