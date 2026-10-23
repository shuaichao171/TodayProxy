import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const CONFIG_EXAMPLE = path.join(CONFIG_DIR, 'config.example.json');
export const DATA_DIR = path.join(ROOT, 'data');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8790, adminPassword: '', cors: true },
  upstream: {
    apiBaseUrl: 'https://api.todayai.cn',
    authBaseUrl: 'https://auth.todayai.cn',
    webOrigin: 'https://todayai.cn',
    appVersion: '1.22.7',
    clientPlatform: 'windows',
    clientType: 'windows-connector',
    platform: 'win32',
    deviceName: 'TodayProxy',
    connectTimeoutMs: 20000,
    connectRetries: 1,
    tokenSkewSeconds: 60,
    replyTimeoutMs: 180000,
    preferWebSocket: true,
    restPollIntervalMs: 1500,
    socketEnabled: true,
  },
  auth: {
    todayUserDataDir: '',
    userDataDirCandidates: ['Today CN', 'Today', 'Today CN Dev'],
  },
  pool: {
    strategy: 'round-robin',
    maxRetries: 1,
    cooldownSeconds: 60,
    sessionAffinity: true,
    conversationMode: 'session',
    conversationTtlSeconds: 86400,
  },
  limits: { requestsPerMinutePerKey: 0 },
  stream: { simulate: true, chunkChars: 48, chunkDelayMs: 10 },
  log: { level: 'info' },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(base?.[key]) && isPlainObject(value) ? merge(base[key], value) : value;
  }
  return out;
}

function readEnvOverrides(env) {
  const num = (value) => (value === undefined || value === '' ? undefined : Number(value));
  const bool = (value) => (value === undefined || value === '' ? undefined : /^(1|true|yes|on)$/i.test(value));
  const patch = {};
  const set = (group, key, value) => {
    if (value === undefined) return;
    patch[group] = patch[group] ?? {};
    patch[group][key] = value;
  };
  set('server', 'host', env.TODAY_PROXY_HOST);
  set('server', 'port', num(env.TODAY_PROXY_PORT));
  set('server', 'adminPassword', env.TODAY_PROXY_ADMIN_PASSWORD);
  set('upstream', 'apiBaseUrl', env.TODAY_PROXY_API_BASE);
  set('upstream', 'authBaseUrl', env.TODAY_PROXY_AUTH_BASE);
  set('upstream', 'appVersion', env.TODAY_PROXY_APP_VERSION);
  set('upstream', 'replyTimeoutMs', num(env.TODAY_PROXY_REPLY_TIMEOUT_MS));
  set('upstream', 'socketEnabled', bool(env.TODAY_PROXY_SOCKET));
  set('auth', 'todayUserDataDir', env.TODAY_PROXY_USER_DATA_DIR);
  set('pool', 'conversationMode', env.TODAY_PROXY_CONVERSATION_MODE);
  set('log', 'level', env.TODAY_PROXY_LOG_LEVEL);
  return patch;
}

export function ensureConfigFile() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    if (fs.existsSync(CONFIG_EXAMPLE)) fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_FILE);
    else fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  return CONFIG_FILE;
}

export function loadConfig({ env = process.env, create = true } = {}) {
  if (create) ensureConfigFile();
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    fileConfig = raw.trim() ? JSON.parse(raw) : {};
  }
  const config = merge(merge(DEFAULTS, fileConfig), readEnvOverrides(env));
  config.server.port = Number(config.server.port) || DEFAULTS.server.port;
  config.paths = { root: ROOT, configFile: CONFIG_FILE, dataDir: DATA_DIR };
  return config;
}

export function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const { paths, ...rest } = config;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(rest, null, 2) + '\n');
  return rest;
}

export { DEFAULTS };
