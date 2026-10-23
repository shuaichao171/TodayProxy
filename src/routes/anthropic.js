import { readBody, sendError, sendJson, openSse, sseDone, sseSend, sliceText, sleep, statusForError, messageForError } from './shared.js';
import { listModels } from '../core/models.js';
import { logger } from '../util/log.js';

const log = logger('anthropic');

function deriveHeaderKey(req) {
  return req.headers['x-today-conversation'] || req.headers['x-today-session'] || null;
}

function anthropicToOpenAiMessages(body) {
  const messages = [];
  const system = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).filter(Boolean).join('\n\n')
      : '';
  if (system) messages.push({ role: 'system', content: system });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block && typeof block === 'object' && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
      const toolResults = message.content
        .filter((block) => block && typeof block === 'object' && block.type === 'tool_result')
        .map((block) => (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)))
        .join('\n');
      const merged = [text, toolResults].filter(Boolean).join('\n');
      if (merged) messages.push({ role, content: merged });
    }
  }
  return messages;
}

export function anthropicRoutes({ config, executor, usage }) {
  return [
    {
      method: 'POST',
      path: '/v1/messages',
      auth: 'key',
      handler: async ({ req, res, keyRecord }) => {
        const body = await readBody(req);
        const messages = anthropicToOpenAiMessages(body);
        if (!messages.some((message) => message.role === 'user')) {
          return sendError(res, 400, 'messages 里至少需要一条 user 消息');
        }
        const model = body.model ?? 'today';
        const wantsStream = body.stream === true;
        const messageId = `msg_today_${Math.random().toString(36).slice(2, 12)}`;
        const controller = new AbortController();
        const onClose = () => controller.abort(new Error('客户端断开'));
        req.on('close', onClose);
        const started = Date.now();
        let streamed = false;

        try {
          const result = await executor.run({
            messages,
            model,
            keyRecord,
            headerKey: deriveHeaderKey(req),
            bodyKey: body.metadata?.conversation_id ?? null,
            signal: controller.signal,
          });
          const inputTokens = result.promptTokens;
          const outputTokens = usage.constructor.estimateTokens(result.reply.text);
          usage.record({
            keyId: keyRecord?.id,
            accountId: result.account.id,
            model,
            mode: result.planMode,
            ok: true,
            conversationId: result.conversationId,
            latencyMs: Date.now() - started,
            promptTokens: inputTokens,
            completionTokens: outputTokens,
          });

          if (!wantsStream) {
            req.off('close', onClose);
            return sendJson(res, 200, {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: result.reply.text }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            });
          }

          streamed = true;
          openSse(res, { 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01' });
          sseSend(res, {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          }, 'message_start');
          sseSend(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
          const pieces = config.stream.simulate === false ? [result.reply.text] : sliceText(result.reply.text, config.stream.chunkChars);
          for (const piece of pieces) {
            if (res.writableEnded) break;
            sseSend(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, 'content_block_delta');
            if (config.stream.chunkDelayMs > 0) await sleep(config.stream.chunkDelayMs);
          }
          sseSend(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
          sseSend(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } }, 'message_delta');
          sseSend(res, { type: 'message_stop' }, 'message_stop');
          res.end();
          return undefined;
        } catch (error) {
          log.warn('messages 失败', { error: error.message, kind: error.kind });
          usage.record({
            keyId: keyRecord?.id,
            model,
            ok: false,
            latencyMs: Date.now() - started,
            error: String(error.message).slice(0, 200),
          });
          if (streamed) {
            if (!res.writableEnded) {
              sseSend(res, { type: 'error', error: { type: 'api_error', message: messageForError(error) } }, 'error');
              res.end();
            }
            return undefined;
          }
          return sendJson(res, statusForError(error), {
            type: 'error',
            error: { type: error.kind === 'AUTH' ? 'authentication_error' : 'api_error', message: messageForError(error) },
          });
        } finally {
          req.off('close', onClose);
        }
        return undefined;
      },
    },
    {
      method: 'GET',
      path: '/v1/models',
      auth: 'key',
      handler: async ({ res }) => sendJson(res, 200, { object: 'list', data: listModels() }),
    },
  ];
}
