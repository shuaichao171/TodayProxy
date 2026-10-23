import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Sessions, toTurns, splitSystem, normalizeContent } from '../src/core/sessions.js';
import { resolveModel, listModels } from '../src/core/models.js';
import { Usage } from '../src/core/usage.js';
import { sliceText } from '../src/routes/shared.js';

// 单测会真的落盘，统一写到系统临时目录，别污染仓库。
const TMP = path.join(os.tmpdir(), 'todayproxy-tests');

const baseConfig = (overrides = {}) => ({
  paths: { dataDir: overrides.dataDir ?? TMP },
  pool: { conversationMode: 'session', conversationTtlSeconds: 86400, ...(overrides.pool ?? {}) },
  upstream: { replyTimeoutMs: 1000, restPollIntervalMs: 500 },
});

test('normalizeContent 支持字符串与内容块数组', () => {
  assert.equal(normalizeContent('abc'), 'abc');
  assert.equal(normalizeContent([{ type: 'text', text: 'a' }, { text: 'b' }]), 'a\nb');
  assert.equal(normalizeContent({ text: 'x' }), 'x');
  assert.equal(normalizeContent(undefined), '');
});

test('toTurns 归一化角色并丢掉空消息', () => {
  const turns = toTurns([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '在' },
  ]);
  assert.deepEqual(turns, [
    { role: 'system', text: 'sys' },
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在' },
  ]);
});

test('splitSystem 把 system 从对话里剥离', () => {
  const { system, dialog } = splitSystem(toTurns([
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'u' },
  ]));
  assert.equal(system, 'A\n\nB');
  assert.deepEqual(dialog, [{ role: 'user', text: 'u' }]);
});

test('plan: 首次请求新开会话，续聊只推增量', () => {
  const config = baseConfig();
  const sessions = new Sessions({ config, file: `${config.paths.dataDir}/sessions-test-1.json` });
  const key = 'test-key-1';
  const first = sessions.plan(key, { turns: [{ role: 'user', text: 'u1' }] });
  assert.equal(first.mode, 'new');
  assert.equal(first.delta.length, 1);

  sessions.put(key, {
    accountId: 'acc_1',
    conversationId: 'conv_1',
    turns: [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' }],
  });

  const second = sessions.plan(key, {
    turns: [
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'u2' },
    ],
  });
  assert.equal(second.mode, 'continue');
  assert.equal(second.conversationId, 'conv_1');
  assert.deepEqual(second.delta, [{ role: 'user', text: 'u2' }]);
});

test('plan: 客户端历史分叉时重开会话', () => {
  const config = baseConfig();
  const sessions = new Sessions({ config, file: `${config.paths.dataDir}/sessions-test-2.json` });
  const key = 'test-key-2';
  sessions.put(key, {
    accountId: 'acc_1',
    conversationId: 'conv_1',
    turns: [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' }],
  });
  const plan = sessions.plan(key, { turns: [{ role: 'user', text: '完全不同的开头' }] });
  assert.equal(plan.mode, 'new');
  assert.equal(plan.reset, true);
});

test('plan: 重放同一份历史时重复最后一次提问', () => {
  const config = baseConfig();
  const sessions = new Sessions({ config, file: `${config.paths.dataDir}/sessions-test-3.json` });
  const key = 'test-key-3';
  const turns = [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' }];
  sessions.put(key, { accountId: 'acc_1', conversationId: 'conv_1', turns });
  const plan = sessions.plan(key, { turns: [...turns] });
  assert.equal(plan.mode, 'continue');
  assert.deepEqual(plan.delta, [{ role: 'user', text: 'u1' }]);
});

test('plan: main 模式始终走主对话', () => {
  const config = baseConfig({ pool: { conversationMode: 'main' } });
  const sessions = new Sessions({ config, file: `${config.paths.dataDir}/sessions-test-4.json` });
  const plan = sessions.plan('k', { turns: [{ role: 'user', text: 'u1' }], conversationMode: 'main' });
  assert.equal(plan.mode, 'main');
  assert.equal(plan.conversationId, null);
});

test('plan: task 模式每次全量新开', () => {
  const config = baseConfig({ pool: { conversationMode: 'task' } });
  const sessions = new Sessions({ config, file: `${config.paths.dataDir}/sessions-test-5.json` });
  const turns = [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'u2' }];
  const plan = sessions.plan('k', { turns, conversationMode: 'task' });
  assert.equal(plan.mode, 'new');
  assert.equal(plan.delta.length, 3);
});

test('deriveKey 在同一会话里稳定、在不同会话里不同', () => {
  const turns = [{ role: 'user', text: '你好' }];
  const a = Sessions.deriveKey({ headerKey: null, bodyKey: null, turns, system: '' });
  const b = Sessions.deriveKey({ headerKey: null, bodyKey: null, turns, system: '' });
  const c = Sessions.deriveKey({ headerKey: null, bodyKey: null, turns: [{ role: 'user', text: '别的' }], system: '' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^f:[0-9a-f]{32}$/u);
});

test('resolveModel 支持别名，未知模型回落到默认', () => {
  assert.equal(resolveModel('today').id, 'today');
  assert.equal(resolveModel('xiaoya').id, 'today');
  assert.equal(resolveModel('today-main').conversationMode, 'main');
  assert.equal(resolveModel('today-task').conversationMode, 'task');
  const unknown = resolveModel('gpt-4o');
  assert.equal(unknown.id, 'today');
  assert.equal(unknown.known, false);
  assert.equal(unknown.requested, 'gpt-4o');
});

test('listModels 至少暴露三个语义化模型', () => {
  const ids = listModels().map((m) => m.id);
  assert.deepEqual(ids, ['today', 'today-main', 'today-task']);
});

test('Usage.estimateTokens 对中英文都给正数', () => {
  assert.ok(Usage.estimateTokens('你好世界') >= 4);
  assert.ok(Usage.estimateTokens('hello world') >= 2);
  assert.equal(Usage.estimateTokens(''), 0);
});

test('sliceText 拼回原文，且不会切碎成超长片段', () => {
  const text = '第一句。第二句！第三句？' + 'x'.repeat(200);
  const pieces = sliceText(text, 16);
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every((piece) => piece.length <= 80));
  assert.ok(pieces.length > 1);
});
