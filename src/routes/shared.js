/** 路由层共用工具：请求体读取、SSE、错误映射。 */

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, type: extra.type ?? 'invalid_request_error', ...extra } });
}

export function openSse(res, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers,
  });
}

export function sseSend(res, data, event = null) {
  if (res.writableEnded) return false;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  return true;
}

export function sseDone(res) {
  if (res.writableEnded) return;
  res.write('data: [DONE]\n\n');
  res.end();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 上游回答是「整段到达」的，没有 token 级增量。
 * 为了让 `stream:true` 的客户端有正常的打字机效果，把整段文本切成小块吐出。
 * 这只是表现层模拟，`finish_reason` 与内容本身与上游一致。
 */
export function sliceText(text, chunkChars) {
  const size = Math.max(1, chunkChars ?? 48);
  if (text.length <= size) return [text];
  const pieces = [];
  let index = 0;
  while (index < text.length) {
    // 尽量在小句/标点处断开，读起来自然一点。
    let end = Math.min(text.length, index + size);
    if (end < text.length) {
      const window = text.slice(index, end);
      const match = /[。！？!?.\n；;，,、]\s*$/u.exec(window);
      if (match) end = index + match.index + match[0].length;
    }
    pieces.push(text.slice(index, end));
    index = end;
  }
  return pieces;
}

export function statusForError(error) {
  if (error?.statusCode) return error.statusCode;
  switch (error?.kind) {
    case 'AUTH': return 401;
    case 'NO_ACCOUNT': return 503;
    case 'BAD_REQUEST': return 400;
    case 'NOT_FOUND': return 404;
    case 'RATE_LIMIT': return 429;
    case 'TIMEOUT': return 504;
    case 'EXHAUSTED': return 502;
    default: return 502;
  }
}

export function messageForError(error) {
  const message = error?.message ?? String(error);
  const kind = error?.kind ? `[${error.kind}] ` : '';
  return kind + message;
}
