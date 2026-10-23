#!/usr/bin/env node
import process from 'node:process';
import { loadConfig, saveConfig } from './config.js';
import { createContext, startServer, disposeAllContexts } from './server.js';
import { readLocalLogin, findUserDataDir, describePlatform } from './auth/credential-store.js';
import { issueAccessToken } from './auth/token.js';
import { listModels } from './core/models.js';
import { setLevel, logger } from './util/log.js';

const log = logger('cli');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=');
      const key = rawKey.replace(/-([a-z])/gu, (_, c) => c.toUpperCase());
      if (inlineValue !== undefined) { args[key] = inlineValue; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
      continue;
    }
    args._.push(token);
  }
  return args;
}

function short(value, keep = 10) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  if (value.length <= keep * 2) return value;
  return `${value.slice(0, keep)}…${value.slice(-4)}`;
}

function printTable(rows, columns) {
  if (rows.length === 0) { console.log('（空）'); return; }
  const widths = columns.map((col) => Math.max(col.title.length, ...rows.map((row) => String(col.get(row) ?? '').length)));
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ');
  console.log(line(columns.map((col) => col.title)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(columns.map((col) => col.get(row))));
}

async function cmdServe(args) {
  const config = loadConfig();
  if (args.port) config.server.port = Number(args.port);
  if (args.host) config.server.host = String(args.host);
  if (args.adminPassword !== undefined) config.server.adminPassword = String(args.adminPassword);
  if (args.port || args.host) saveConfig(config);
  setLevel(config.log?.level ?? 'info');
  const { server } = await startServer(config);
  const shutdown = () => {
    log.info('正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdDoctor(args) {
  const config = loadConfig();
  setLevel(args.verbose ? 'debug' : (config.log?.level ?? 'info'));
  const problems = [];
  console.log('== 运行环境 ==');
  console.log(`Node           ${process.version}（需要 >= 22，global WebSocket: ${typeof WebSocket === 'function' ? '可用' : '不可用'}）`);
  console.log(`平台           ${describePlatform().platform}`);

  console.log('\n== Today 客户端 ==');
  const found = findUserDataDir({
    explicit: config.auth.todayUserDataDir || undefined,
    candidates: config.auth.userDataDirCandidates,
  });
  console.log(`用户数据目录   ${found.dir ?? '未找到'}`);
  if (!found.dir) {
    problems.push('找不到 Today 用户数据目录：先在 Today 桌面端登录一次，或用 --user-data-dir 指定');
  } else {
    try {
      const local = readLocalLogin({
        explicit: config.auth.todayUserDataDir || undefined,
        candidates: config.auth.userDataDirCandidates,
      });
      console.log(`凭据槽         slot-${local.slotIndex === 0 ? 'a' : 'b'}（generation ${local.generation}，source ${local.source}，env ${local.environment}）`);
      console.log(`用户           ${local.user?.id ?? '—'}`);
      console.log(`accessToken    ${local.accessToken ? `已缓存，到期 ${new Date(local.accessTokenExpiresAt).toISOString()}` : '无（会即时换取）'}`);
      console.log(`session        ${short(local.sessionToken)}（等价 better-auth session）`);
    } catch (error) {
      problems.push(`读取本机登录态失败：${error.message}`);
    }
  }

  console.log('\n== 上游连通性 ==');
  try {
    const probe = await issueAccessToken(config, await (async () => {
      const local = readLocalLogin({
        explicit: config.auth.todayUserDataDir || undefined,
        candidates: config.auth.userDataDirCandidates,
      });
      return local.sessionToken;
    })());
    console.log(`账号服务       ${config.upstream.authBaseUrl} → 200，token 到期 ${new Date(probe.expiresAt).toISOString()}`);
    const me = await fetch(`${config.upstream.apiBaseUrl.replace(/\/+$/u, '')}/v1/users/me`, {
      headers: { accept: 'application/json', authorization: `Bearer ${probe.accessToken}`, origin: config.upstream.webOrigin },
    });
    console.log(`业务接口       ${config.upstream.apiBaseUrl}/v1/users/me → ${me.status}`);
    if (!me.ok) problems.push(`业务接口返回 ${me.status}`);
  } catch (error) {
    problems.push(`上游连通性检查失败：${error.message}`);
  }

  console.log('\n== 本地数据 ==');
  const context = createContext(config);
  console.log(`账号池         ${context.accounts.list().length} 个`);
  console.log(`下游密钥       ${context.keys.list().length} 个`);
  console.log(`会话映射       ${context.sessions.list().length} 条`);
  console.log(`数据目录       ${config.paths.dataDir}`);

  console.log('\n== 结论 ==');
  if (problems.length === 0) {
    console.log('一切正常，可以 `node src/cli.js serve`。');
    return 0;
  }
  for (const problem of problems) console.log(`- ${problem}`);
  return 1;
}

async function cmdImportLocal(args) {
  const config = loadConfig();
  if (args.userDataDir) {
    config.auth.todayUserDataDir = String(args.userDataDir);
    saveConfig(config);
  }
  const context = createContext(config);
  const local = readLocalLogin({
    explicit: config.auth.todayUserDataDir || undefined,
    candidates: config.auth.userDataDirCandidates,
  });
  if (args.dryRun) {
    console.log(JSON.stringify({
      userDataDir: local.userDataDir,
      slotIndex: local.slotIndex,
      generation: local.generation,
      environment: local.environment,
      source: local.source,
      user: local.user,
      sessionToken: short(local.sessionToken),
      accessTokenExpiresAt: local.accessTokenExpiresAt,
    }, null, 2));
    return 0;
  }
  const { account, created } = context.accounts.upsert({
    sessionToken: local.sessionToken,
    userId: local.user?.id ?? null,
    displayName: local.user?.preferredName ?? local.user?.displayName ?? null,
    source: 'import-local',
    environment: local.environment ?? null,
    accessToken: local.accessToken,
    accessTokenExpiresAt: local.accessTokenExpiresAt,
  });
  await context.tokens.get(account, { forceRefresh: true });
  context.accounts.flush();
  console.log(`${created ? '已导入' : '已更新'}账号 ${account.id}（${local.userDataDir}）`);
  console.log(`session ${short(local.sessionToken)}，用户 ${local.user?.id ?? '—'}`);
  return 0;
}

async function cmdAccounts(args) {
  const config = loadConfig();
  const context = createContext(config);
  const sub = args._[1] ?? 'list';
  const id = args._[2] ?? args.id;
  if (sub === 'list') {
    printTable(context.accounts.list(), [
      { title: 'ID', get: (a) => a.id },
      { title: '名称', get: (a) => a.name ?? '' },
      { title: '状态', get: (a) => context.accounts.effectiveStatus(a) },
      { title: '用户', get: (a) => a.userId ?? '' },
      { title: 'session', get: (a) => short(a.sessionToken) },
      { title: '请求', get: (a) => a.requests ?? 0 },
      { title: '失败', get: (a) => a.failures ?? 0 },
      { title: '错误', get: (a) => (a.lastError ?? '').slice(0, 40) },
    ]);
    return 0;
  }
  const account = context.accounts.get(id);
  if (!account) { console.error(`账号不存在：${id}`); return 1; }
  switch (sub) {
    case 'check': {
      const token = await context.tokens.get(account, { forceRefresh: true });
      const me = await context.api.me(account);
      console.log(`OK  user=${me?.id ?? '—'}  token=${short(token)}`);
      context.accounts.update(account, { status: 'active', invalidReason: null, cooldownUntil: null });
      return 0;
    }
    case 'enable':
      context.accounts.update(account, { enabled: true });
      console.log('已启用');
      return 0;
    case 'disable':
      context.accounts.update(account, { enabled: false });
      console.log('已停用');
      return 0;
    case 'rm':
      context.accounts.remove(account.id);
      console.log('已删除');
      return 0;
    case 'points': {
      const status = await context.api.pricingStatus(account).catch(() => null);
      console.log(JSON.stringify(status, null, 2));
      return 0;
    }
    default:
      console.error(`未知子命令：accounts ${sub}`);
      return 1;
  }
}

async function cmdKey(args) {
  const config = loadConfig();
  const context = createContext(config);
  const sub = args._[1] ?? 'list';
  if (sub === 'list') {
    printTable(context.keys.list(), [
      { title: 'ID', get: (k) => k.id },
      { title: '名称', get: (k) => k.name },
      { title: '前缀', get: (k) => `${k.prefix}…` },
      { title: 'RPM', get: (k) => k.rpm ?? '' },
      { title: '请求', get: (k) => k.requests ?? 0 },
      { title: '最后使用', get: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : '') },
    ]);
    return 0;
  }
  if (sub === 'create') {
    const { record, secret } = context.keys.create({
      name: args.name,
      rpm: args.rpm ? Number(args.rpm) : null,
      models: args.models ? String(args.models).split(',').map((s) => s.trim()).filter(Boolean) : null,
    });
    console.log(`已创建密钥 ${record.id}（${record.name}）`);
    console.log(secret);
    console.log('这个明文只显示一次，请立即保存。');
    return 0;
  }
  if (sub === 'rm') {
    const ok = context.keys.remove(args.id ?? args._[2]);
    console.log(ok ? '已删除' : '未找到');
    return ok ? 0 : 1;
  }
  console.error(`未知子命令：key ${sub}`);
  return 1;
}

async function cmdModels() {
  const models = listModels();
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ object: 'list', data: models }, null, 2)); return 0; }
  printTable(models, [
    { title: 'ID', get: (m) => m.id },
    { title: '说明', get: (m) => m.description },
  ]);
  return 0;
}

async function cmdProbe(args) {
  const config = loadConfig();
  const context = createContext(config);
  const prompt = args.prompt ? String(args.prompt) : '你好，请用一句话回复：你叫什么，现在几点（不用精确）。';
  const started = Date.now();
  const result = await context.executor.run({
    messages: [{ role: 'user', content: prompt }],
    model: args.model ?? 'today',
    keyRecord: { id: 'cli-probe' },
    headerKey: args.conversationId ? String(args.conversationId) : null,
    bodyKey: null,
  });
  console.log(`账号           ${result.account.id}`);
  console.log(`Today 会话     ${result.conversationId}${result.newConversation ? '（新开）' : ''}`);
  console.log(`消息 id        ${result.reply.messageId}（通道 ${result.reply.channel}）`);
  console.log(`耗时           ${Date.now() - started}ms`);
  console.log('--- 回答 ---');
  console.log(result.reply.text);
  return 0;
}

async function cmdSessions(args) {
  const config = loadConfig();
  const context = createContext(config);
  const sub = args._[1] ?? 'list';
  if (sub === 'list') {
    printTable(context.sessions.list(), [
      { title: 'key', get: (s) => s.key },
      { title: 'Today 会话', get: (s) => s.conversationId },
      { title: '轮次', get: (s) => s.turnCount },
      { title: '更新时间', get: (s) => (s.updatedAt ? new Date(s.updatedAt).toISOString() : '') },
    ]);
    return 0;
  }
  if (sub === 'purge') { console.log(`清理 ${context.sessions.purgeExpired()} 条`); return 0; }
  if (sub === 'rm') { console.log(context.sessions.drop(args.key ?? args._[2]) ? '已删除' : '未找到'); return 0; }
  console.error(`未知子命令：sessions ${sub}`);
  return 1;
}

async function cmdSocket(args) {
  const config = loadConfig();
  const context = createContext(config);
  const account = args.account ? context.accounts.get(String(args.account)) : context.accounts.list()[0];
  if (!account) { console.error('没有可用账号'); return 1; }
  const socket = context.socketPool.ensure(account);
  const seconds = Number(args.seconds ?? 20);
  console.log(`监听账号 ${account.id} 的长连接事件 ${seconds}s…`);
  const onEvent = (event) => console.log(`[${new Date().toISOString()}] ${event.event} conv=${event.data?.conversationId ?? '—'} seq=${event.seq ?? '—'}`);
  socket?.on('event', onEvent);
  socket?.on('state', (status) => console.log(`[state] ${status}`));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  socket?.off('event', onEvent);
  context.socketPool.stopAll();
  return 0;
}

function usage() {
  console.log(`TodayProxy

用法：
  node src/cli.js serve [--port 8790] [--host 127.0.0.1] [--admin-password x]
  node src/cli.js doctor [--verbose]
  node src/cli.js import-local [--user-data-dir <Today 用户数据目录>] [--dry-run]
  node src/cli.js accounts [list|check|enable|disable|rm|points] [accountId]
  node src/cli.js key [list|create|rm] [--name x] [--rpm 60] [--models a,b] [--id key_x]
  node src/cli.js models [--json]
  node src/cli.js probe [--model today|today-main|today-task] [--prompt "..."] [--conversation-id x]
  node src/cli.js sessions [list|purge|rm] [--key x]
  node src/cli.js socket [--account acc_x] [--seconds 20]
`);
}

const COMMANDS = {
  serve: cmdServe,
  doctor: cmdDoctor,
  'import-local': cmdImportLocal,
  accounts: cmdAccounts,
  key: cmdKey,
  models: cmdModels,
  probe: cmdProbe,
  sessions: cmdSessions,
  socket: cmdSocket,
};

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';
  const handler = COMMANDS[command];
  if (!handler) { usage(); process.exitCode = command === 'help' ? 0 : 1; return; }
  try {
    const code = await handler(args);
    // 不要用 process.exit()：Windows 上 libuv 在 async handle 正在关闭时断言失败。
    // 设置 exitCode 后让事件循环自然结束。
    process.exitCode = code ?? 0;
  } catch (error) {
    log.error(error.message, { kind: error.kind ?? error.name });
    if (process.env.TODAY_PROXY_DEBUG) console.error(error);
    process.exitCode = 1;
  } finally {
    // 关键：probe/socket/doctor 会建长连接，不收干净事件循环就不空、进程挂着不退出。
    // （也不能用 process.exit()：Windows 上 libuv 在 async handle 关闭中会断言失败。）
    disposeAllContexts();
  }
}

await main();
