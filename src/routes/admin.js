import fs from 'node:fs';
import path from 'node:path';
import { listModels } from '../core/models.js';
import { readBody, sendError, sendJson } from './shared.js';
import { readLocalLogin } from '../auth/credential-store.js';
import { logger } from '../util/log.js';

const log = logger('admin');

/**
 * 管理 API。
 * 鉴权：设了 `server.adminPassword` 就要求 `Authorization: Bearer <密码>`；
 * 没设则只允许本机（127.0.0.1/::1）访问。
 */
export function adminRoutes({ config, accounts, keys, usage, sessions, executor, socketPool, tokens, api, replier }) {
  const guards = {
    admin: ({ req }) => {
      const password = config.server.adminPassword;
      if (!password) {
        const remote = req.socket?.remoteAddress ?? '';
        const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
        return local ? null : { status: 403, message: '管理台未设置密码，只允许本机访问' };
      }
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      return token === password ? null : { status: 401, message: '管理密码不正确' };
    },
  };

  const requireAdmin = (ctx) => guards.admin(ctx);

  return {
    routes: [
      {
        method: 'GET',
        path: '/admin/api/state',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const accountsView = accounts.list().map((account) => accounts.publicView(account));
          sendJson(ctx.res, 200, {
            server: { host: config.server.host, port: config.server.port, version: '0.1.0' },
            upstream: {
              apiBaseUrl: config.upstream.apiBaseUrl,
              authBaseUrl: config.upstream.authBaseUrl,
              appVersion: config.upstream.appVersion,
              deviceName: config.upstream.deviceName,
              socketEnabled: config.upstream.socketEnabled,
            },
            pool: config.pool,
            stream: config.stream,
            accounts: accountsView,
            keys: keys.list(),
            sockets: socketPool?.describe?.() ?? [],
            usage: { totals: usage.totals(), recent: usage.recent(30) },
            sessions: sessions.list().slice(0, 50),
            models: listModels(),
          });
        },
      },
      {
        method: 'POST',
        path: '/admin/api/accounts/import-local',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          try {
            const local = readLocalLogin({
              explicit: config.auth.todayUserDataDir || undefined,
              candidates: config.auth.userDataDirCandidates,
            });
            const { account, created } = accounts.upsert({
              sessionToken: local.sessionToken,
              userId: local.user?.id ?? null,
              displayName: local.user?.displayName ?? null,
              name: local.user?.displayName ?? null,
              source: 'import-local',
              environment: local.environment ?? null,
              accessToken: local.accessToken,
              accessTokenExpiresAt: local.accessTokenExpiresAt,
            });
            return sendJson(ctx.res, 200, { created, account: accounts.publicView(account), userDataDir: local.userDataDir });
          } catch (error) {
            return sendError(ctx.res, 400, error.message);
          }
        },
      },
      {
        method: 'POST',
        path: '/admin/api/accounts',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const body = await readBody(ctx.req);
          if (!body.sessionToken) return sendError(ctx.res, 400, '缺少 sessionToken');
          try {
            const { account, created } = accounts.upsert({
              sessionToken: body.sessionToken,
              userId: body.userId ?? null,
              name: body.name ?? null,
              source: 'manual',
            });
            return sendJson(ctx.res, 200, { created, account: accounts.publicView(account) });
          } catch (error) {
            return sendError(ctx.res, 400, error.message);
          }
        },
      },
      {
        method: 'PATCH',
        path: /^\/admin\/api\/accounts\/([^/]+)$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const account = accounts.get(ctx.params[0]);
          if (!account) return sendError(ctx.res, 404, '账号不存在');
          const body = await readBody(ctx.req);
          if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
          if (body.name !== undefined) account.name = String(body.name);
          if (body.weight !== undefined) account.weight = Number(body.weight);
          if (body.resetStatus) {
            account.status = 'active';
            account.invalidReason = null;
            account.cooldownUntil = null;
            account.lastError = null;
          }
          accounts.update(account, {});
          return sendJson(ctx.res, 200, { account: accounts.publicView(account) });
        },
      },
      {
        method: 'DELETE',
        path: /^\/admin\/api\/accounts\/([^/]+)$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const account = accounts.get(ctx.params[0]);
          if (!account) return sendError(ctx.res, 404, '账号不存在');
          socketPool?.stop(account.id);
          accounts.remove(account.id);
          return sendJson(ctx.res, 200, { ok: true });
        },
      },
      {
        method: 'POST',
        path: /^\/admin\/api\/accounts\/([^/]+)\/check$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const account = accounts.get(ctx.params[0]);
          if (!account) return sendError(ctx.res, 404, '账号不存在');
          try {
            const token = await tokens.get(account, { forceRefresh: true });
            const me = await api.me(account, {}).catch(() => null);
            const pricing = await api.pricingStatus(account).catch(() => null);
            account.status = 'active';
            account.invalidReason = null;
            account.cooldownUntil = null;
            if (me?.id) account.userId = me.id;
            if (me?.preferredName) account.displayName = me.preferredName;
            accounts.update(account, {});
            return sendJson(ctx.res, 200, {
              ok: true,
              tokenPreview: `${token.slice(0, 12)}…`,
              user: me ? { id: me.id, preferredName: me.preferredName ?? null } : null,
              plan: pricing ? { plan: pricing.plan, accessPhase: pricing.accessPhase, serviceState: pricing.serviceState } : null,
            });
          } catch (error) {
            accounts.markFailure(account, error);
            return sendError(ctx.res, 400, error.message);
          }
        },
      },
      {
        method: 'POST',
        path: '/admin/api/keys',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const body = await readBody(ctx.req);
          const { record, secret } = keys.create({
            name: body.name,
            rpm: body.rpm === undefined || body.rpm === null || body.rpm === '' ? null : Number(body.rpm),
            models: Array.isArray(body.models) ? body.models : null,
            note: body.note ?? null,
          });
          return sendJson(ctx.res, 200, { key: { ...record, hash: undefined }, secret });
        },
      },
      {
        method: 'PATCH',
        path: /^\/admin\/api\/keys\/([^/]+)$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const body = await readBody(ctx.req);
          const record = keys.update(ctx.params[0], body);
          if (!record) return sendError(ctx.res, 404, '密钥不存在');
          return sendJson(ctx.res, 200, { key: { ...record, hash: undefined } });
        },
      },
      {
        method: 'DELETE',
        path: /^\/admin\/api\/keys\/([^/]+)$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          return sendJson(ctx.res, 200, { ok: keys.remove(ctx.params[0]) });
        },
      },
      {
        method: 'POST',
        path: '/admin/api/upstream/probe',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const body = await readBody(ctx.req);
          const prompt = typeof body.prompt === 'string' && body.prompt.trim()
            ? body.prompt.trim()
            : `你好，请用一句话回复：现在是 ${new Date().toISOString()}`;
          try {
            const result = await executor.run({
              messages: [{ role: 'user', content: prompt }],
              model: body.model ?? 'today',
              keyRecord: { id: 'admin-probe' },
              headerKey: body.conversationId ?? null,
              bodyKey: null,
            });
            return sendJson(ctx.res, 200, {
              ok: true,
              text: result.reply.text,
              conversationId: result.conversationId,
              messageId: result.reply.messageId,
              channel: result.reply.channel,
              account: result.account.id,
              latencyMs: result.latencyMs,
              newConversation: result.newConversation,
            });
          } catch (error) {
            return sendError(ctx.res, 400, error.message, { kind: error.kind ?? null });
          }
        },
      },
      {
        method: 'POST',
        path: '/admin/api/sessions/purge',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          const removed = sessions.purgeExpired();
          return sendJson(ctx.res, 200, { removed });
        },
      },
      {
        method: 'DELETE',
        path: /^\/admin\/api\/sessions\/(.+)$/,
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          return sendJson(ctx.res, 200, { ok: sessions.drop(ctx.params[0]) });
        },
      },
      {
        method: 'GET',
        path: '/admin/api/logs',
        admin: true,
        handler: async (ctx) => {
          const denied = requireAdmin(ctx);
          if (denied) return sendError(ctx.res, denied.status, denied.message);
          return sendJson(ctx.res, 200, { items: usage.tail(300) });
        },
      },
    ],
    async serveStatic(ctx) {
      const denied = requireAdmin(ctx);
      if (denied) {
        ctx.res.writeHead(denied.status, { 'content-type': 'text/plain; charset=utf-8' });
        ctx.res.end(denied.message);
        return true;
      }
      const file = path.join(config.paths.root, 'src/ui/admin.html');
      if (!fs.existsSync(file)) {
        ctx.res.writeHead(404).end('admin.html missing');
        return true;
      }
      const html = fs.readFileSync(file);
      ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      ctx.res.end(html);
      return true;
    },
  };
}

export function logAdminStart(config) {
  log.info('管理台已启用', { path: '/admin', protected: Boolean(config.server.adminPassword) });
}
