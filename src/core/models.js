/**
 * 模型目录。
 *
 * Today 不像 OpenAI 那样把模型选择权交给客户端：客户端只能选
 * `mode.fast / mode.balanced / mode.power` 这类抽象档位，真正的模型路由在服务端
 * （CN 版连档位接口都没有，`/v1/pricing/model-option` 直接 404）。
 * 所以这里不伪造模型列表，只暴露「同一条 Today agent」的三种**会话语义**：
 *
 *   today        默认（会话模式跟随 config.pool.conversationMode）
 *   today-main   强制走账号的主对话（isMainChat=true），上下文持续累积
 *   today-task   每条请求新开一个 Today 会话（无历史污染，代价是多一次会话创建）
 */
export const MODEL_ALIASES = {
  today: { id: 'today', conversationMode: null },
  'today-default': { id: 'today', conversationMode: null },
  'today-agent': { id: 'today', conversationMode: null },
  xiaoya: { id: 'today', conversationMode: null },
  '小芽': { id: 'today', conversationMode: null },
  'today-main': { id: 'today-main', conversationMode: 'main' },
  'today-chat': { id: 'today-main', conversationMode: 'main' },
  'today-task': { id: 'today-task', conversationMode: 'task' },
};

export function resolveModel(name) {
  if (typeof name !== 'string' || !name.trim()) return { ...MODEL_ALIASES.today, requested: name ?? null, known: false };
  const key = name.trim();
  const alias = MODEL_ALIASES[key] ?? MODEL_ALIASES[key.toLowerCase()];
  if (alias) return { ...alias, requested: key, known: true };
  // 未识别的名字不报错：很多客户端硬编码 gpt-4o 之类，直接按默认模型处理更省事。
  return { ...MODEL_ALIASES.today, requested: key, known: false };
}

export function listModels() {
  const created = Math.floor(Date.now() / 1000);
  return [
    {
      id: 'today',
      object: 'model',
      created,
      owned_by: 'today',
      description: 'Today（小芽）默认 agent，会话模式跟随服务端配置',
    },
    {
      id: 'today-main',
      object: 'model',
      created,
      owned_by: 'today',
      description: '走账号主对话（isMainChat=true），上下文持续累积',
    },
    {
      id: 'today-task',
      object: 'model',
      created,
      owned_by: 'today',
      description: '每条请求新开一个 Today 会话，无历史污染',
    },
  ];
}
