import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子 JSON 落盘。写盘用 `临时文件 + rename`，避免进程被杀时留下半截 JSON。
 * `mode` 用来保护含凭据的文件（0600）。
 */
export class JsonStore {
  constructor(file, { fallback, mode = 0o600 } = {}) {
    this.file = file;
    this.mode = mode;
    this.fallback = fallback;
    this.cache = null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  read() {
    if (this.cache !== null) return this.cache;
    if (!this.exists()) {
      this.cache = typeof this.fallback === 'function' ? this.fallback() : structuredClone(this.fallback ?? {});
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.cache = raw.trim() ? JSON.parse(raw) : (typeof this.fallback === 'function' ? this.fallback() : structuredClone(this.fallback ?? {}));
    } catch (error) {
      throw new Error(`无法解析 ${this.file}: ${error.message}`);
    }
    return this.cache;
  }

  /** 从磁盘重读（外部进程改过文件时用）。 */
  reload() {
    this.cache = null;
    return this.read();
  }

  write(value) {
    this.cache = value;
    this.flush();
    return value;
  }

  flush() {
    if (this.cache === null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { mode: this.mode });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, this.mode); } catch { /* Windows 上 chmod 语义有限 */ }
  }
}

/** 只追加的 JSONL 账本，按月/日滚动由调用方决定文件名。 */
export class JsonlLog {
  constructor(file) {
    this.file = file;
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
  }

  tail(limit = 100) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 短暂随机 id（无需加密强度时用）。 */
export function shortId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}
