import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseEnvelope, classifyHttpError, TodayApi } from '../src/upstream/client.js';
import { decryptV10, TodayCredentialError } from '../src/auth/credential-store.js';
import { textFromParts, partsFromMessage, isAssistantMessageReady } from '../src/upstream/replier.js';

test('parseEnvelope 识别 successful 信封', () => {
  const { value, error } = parseEnvelope({ success: true, code: 'common.ok', data: { a: 1 } });
  assert.equal(error, null);
  assert.deepEqual(value, { a: 1 });
});

test('parseEnvelope 把 success:false 当失败（HTTP 也可能是 200）', () => {
  const { error } = parseEnvelope({ success: false, code: 'auth.forbidden', message: '没有权限' });
  assert.ok(error);
  assert.equal(error.kind, 'AUTH');
  assert.equal(error.message, '没有权限');
  assert.equal(error.retryable, false);
});

test('parseEnvelope 对裸 JSON 直接透传', () => {
  const { value, error } = parseEnvelope({ id: 'x' });
  assert.equal(error, null);
  assert.deepEqual(value, { id: 'x' });
});

test('classifyHttpError 区分鉴权/限流/5xx', () => {
  assert.equal(classifyHttpError(401, null, '').kind, 'AUTH');
  assert.equal(classifyHttpError(403, null, '').kind, 'AUTH');
  assert.equal(classifyHttpError(429, null, '').kind, 'RATE_LIMIT');
  assert.equal(classifyHttpError(503, null, '').kind, 'UPSTREAM_5XX');
  assert.equal(classifyHttpError(404, null, '').kind, 'NOT_FOUND');
  assert.equal(classifyHttpError(500, { message: 'boom' }, '').message, 'boom');
});

test('TodayApi.buildWsUrl 生成 wss + ticket + lane', () => {
  const url = TodayApi.buildWsUrl('https://api.todayai.cn', 'ticket value', 'baseline');
  assert.equal(url, 'wss://api.todayai.cn/ws?ticket=ticket+value&lane=baseline');
});

test('decryptV10 能解开 v10 载荷，并拒绝未知前缀', () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update('{"hello":"世界"}', 'utf8'), cipher.final()]);
  const payload = Buffer.concat([Buffer.from('v10', 'ascii'), nonce, ciphertext, cipher.getAuthTag()]);
  assert.equal(decryptV10(key, payload), '{"hello":"世界"}');
  assert.throws(() => decryptV10(key, Buffer.concat([Buffer.from('v20'), payload.subarray(3)])), TodayCredentialError);
});

test('decryptV10 在认证标签错误时报错', () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update('数据', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  tag[0] ^= 0xff;
  const payload = Buffer.concat([Buffer.from('v10', 'ascii'), nonce, ciphertext, tag]);
  assert.throws(() => decryptV10(key, payload));
});

test('textFromParts 提取 canonical-v1 的文本片段', () => {
  const parts = [
    { messageType: 'text', content: { text: '第一段' } },
    { messageType: 'text', content: { text: '第二段' } },
    { messageType: 'image', content: { url: 'https://x/y.png' } },
  ];
  assert.equal(textFromParts(parts), '第一段第二段');
  assert.equal(textFromParts(undefined), '');
});

test('partsFromMessage 读 body.parts', () => {
  assert.deepEqual(partsFromMessage({ body: { parts: [{ a: 1 }] } }), [{ a: 1 }]);
  assert.deepEqual(partsFromMessage({}), []);
});

test('isAssistantMessageReady 只认 canonical assistant 事件', () => {
  assert.equal(isAssistantMessageReady({ event: 'chat.message_ready.v2', data: { message: { role: 'assistant', id: 'm1' } } }), true);
  assert.equal(isAssistantMessageReady({ event: 'chat.message_ready.v2', data: { message: { role: 'user', id: 'm1' } } }), false);
  assert.equal(isAssistantMessageReady({ event: 'chat.presentation.updated.v1', data: {} }), false);
});
