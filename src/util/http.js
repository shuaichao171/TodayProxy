/** fetch 封装：连接/首字节超时与网络错误分类。零依赖。 */

export const CONNECT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UPSTREAM_CONNECT_TIMEOUT',
]);

export class NetworkError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.code = code ?? 'NETWORK';
    this.cause = cause;
  }
}

function errorCode(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

export function isNetworkError(error) {
  if (error instanceof NetworkError) return true;
  const code = errorCode(error);
  return code !== null && CONNECT_ERROR_CODES.has(code);
}

/**
 * 发一次请求。
 * `timeoutMs` 覆盖「拿到响应头」之前的全部时间：超时即放弃本次尝试（可重试）。
 * 拿到响应头之后的流式读取由调用方自己控制超时。
 */
export async function request(url, { method = 'GET', headers, body, timeoutMs = 20000, signal, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    if (timedOut) {
      throw new NetworkError(`请求超时（${timeoutMs}ms）：${method} ${url}`, { code: 'UPSTREAM_CONNECT_TIMEOUT', cause: error });
    }
    if (error?.name === 'AbortError' && signal?.aborted) throw error;
    if (isNetworkError(error) || error?.name === 'TypeError' || error?.name === 'AbortError') {
      throw new NetworkError(`${method} ${url} 连接失败：${error.message}`, { code: errorCode(error) ?? 'NETWORK', cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 读完整 body（带大小上限，防止上游返回怪东西把内存吃满）。 */
export async function readText(response, { limit = 8 * 1024 * 1024 } = {}) {
  const text = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

export async function readJson(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function withRetries(operation, { retries = 1, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      // 只在「连接层失败、且还没拿到响应」时重试：换一条 DNS 结果/新连接。
      if (!isNetworkError(error) || attempt === retries) throw error;
      onRetry?.(attempt + 1, error);
    }
  }
  throw lastError;
}
