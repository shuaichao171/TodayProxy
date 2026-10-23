/** 极简日志，带级别与可选 JSON 字段。零依赖。 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current = LEVELS.info;

export function setLevel(level) {
  const value = LEVELS[String(level || '').toLowerCase()];
  current = value === undefined ? LEVELS.info : value;
}

export function getLevel() {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === current) ?? 'info';
}

function emit(level, scope, message, fields) {
  if (LEVELS[level] < current) return;
  const stamp = new Date().toISOString();
  const head = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  let tail = '';
  if (fields && Object.keys(fields).length > 0) {
    tail = ' ' + Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');
  }
  const line = `${head} ${message}${tail}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function formatValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[object]'; }
  }
  return String(value);
}

export function logger(scope) {
  return {
    debug: (message, fields) => emit('debug', scope, message, fields),
    info: (message, fields) => emit('info', scope, message, fields),
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
