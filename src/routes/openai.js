import { listModels } from '../core/models.js';
import { readBody, sendError, sendJson, openSse, sseDone, sseSend, sliceText, sleep, statusForError, messageForError } from './shared.js';
import { logger } from '../util/log.js';

const log = logger('openai');

function deriveHeaderKey(req) {
  return req.headers['x-today-conversation'] || req.headers['x-today-session'] || null;
}

function deriveBodyKey(body) {
  return body.conversation_id ?? body.session_id ?? body.user ?? body.metadata?.conversation_id ?? null;
}

export function openaiRoutes({ config, executor, usage, keys }) {
  return [
    {
      method: 'GET',
      path: '/v1/models',
      auth: 'key',
      handler: async ({ res }) => {
        sendJson(res, 200, { object: 'list', data: listModels() });
      },
    },
    {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: 'key',
      handler: async ({ req, res, keyRecord }) => {
        const body = await readBody(req);
        const messages = Array.isArray(body.messages) ? body.messages : null;
        if (!messages || messages.length === 0) {
          return sendError(res, 400, 'messages 不能为空');
        }
        if (keyRecord.models && body.model && !keyRecord.models.includes(body.model)) {
          return sendError(res, 403, `该密钥不允许使用模型 ${body.model}`, { type: 'permission_error' });
        }

        const model = body.model ?? 'today';
        const wantsStream = body.stream === true;
        const started = Date.now();
        const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const controller = new AbortController();
        const onClose = () => controller.abort(new Error('客户端断开'));
        req.on('close', onClose);

        let streamed = false;
        try {
          const result = await executor.run({
            messages,
            model,
            keyRecord,
            headerKey: deriveHeaderKey(req),
            bodyKey: deriveBodyKey(body),
            signal: controller.signal,
          });

          const completionTokens = usage.constructor.estimateTokens(result.reply.text);
          const usagePayload = {
            prompt_tokens: result.promptTokens,
            completion_tokens: completionTokens,
            total_tokens: result.promptTokens + completionTokens,
          };
          usage.record({
            keyId: keyRecord?.id,
            accountId: result.account.id,
            model,
            mode: result.planMode,
            ok: true,
            conversationId: result.conversationId,
            latencyMs: Date.now() - started,
            promptTokens: usagePayload.prompt_tokens,
            completionTokens: usagePayload.completion_tokens,
          });

          if (!wantsStream) {
            req.off('close', onClose);
            return sendJson(res, 200, {
              id,
              object: 'chat.completion',
              created,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: result.reply.text },
                  finish_reason: 'stop',
                },
              ],
              usage: usagePayload,
              today: {
                conversationId: result.conversationId,
                messageId: result.reply.messageId,
                channel: result.reply.channel,
                account: result.account.id,
                session: result.sessionKey,
                newConversation: result.newConversation,
                upstream_latency_ms: Date.now() - started,
              },
            });
          }

          streamed = true;
          openSse(res, { 'x-request-id': id });
          sseSend(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          });

          const pieces = config.stream.simulate === false ? [result.reply.text] : sliceText(result.reply.text, config.stream.chunkChars);
          for (const piece of pieces) {
            if (res.writableEnded) break;
            sseSend(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            });
            if (config.stream.chunkDelayMs > 0) await sleep(config.stream.chunkDelayMs);
          }

          sseSend(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: usagePayload,
            today: { conversationId: result.conversationId, messageId: result.reply.messageId, account: result.account.id },
          });
          sseDone(res);
        } catch (error) {
          log.warn('chat/completions 失败', { error: error.message, kind: error.kind });
          usage.record({
            keyId: keyRecord?.id,
            model: body?.model ?? 'today',
            ok: false,
            latencyMs: Date.now() - started,
            error: String(error.message).slice(0, 200),
          });
          if (streamed) {
            if (!res.writableEnded) {
              sseSend(res, { error: { message: messageForError(error), type: error.kind ?? 'upstream_error' } });
              sseDone(res);
            }
            return undefined;
          }
          return sendError(res, statusForError(error), messageForError(error), { code: error.code ?? null });
        } finally {
          req.off('close', onClose);
        }
        return undefined;
      },
    },
  ];
}
