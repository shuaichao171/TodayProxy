# TodayProxy 架构

## 1. 定位

TodayProxy 是一个**自托管 AI 网关**：上游是 Today（todayai.cn「小芽」Agent）的账号池，
下游对客户端暴露标准 **OpenAI / Anthropic** 协议。客户端只改两行配置（`base_url` + `api_key`），
不需要知道 session、JWT、`canonical-v1` WebSocket、`conversationId` 这些 Today 专有细节。

设计上对齐几个成熟开源项目：

| 参考项目 | 借鉴点 |
| --- | --- |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 渠道/令牌/用量/日志四件套；统一 OpenAI 兼容面；上游凭据只存服务端 |
| [tbphp/gpt-load](https://github.com/tbphp/gpt-load) | 「分组 + 凭据池」模型；权重调度、失败冷却、会话亲和、请求日志 |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 双协议入口（OpenAI + Anthropic）与协议归一 |
| [E:\ai-work2\LoomyProxy](../LoomyProxy) | 同款工程结构（`src/{auth,core,upstream,routes}` + CLI 四件套 + REA 取证文档） |

**Today 特有的两个难点**（别家没有）：

1. **鉴权是两级**：客户端不拿 API Key，拿的是「登录 session」；每次访问还要换成几分钟过期的 JWT。
   所以网关必须有 token 生命周期管理，而账号池里存的其实是 session。
2. **上游没有「请求-响应」绑定，也没有 SSE**：`POST /v1/messages` 只回 202，
   回答通过 WebSocket 广播给同账号的所有在线设备。所以网关必须常驻长连接、按会话过滤事件，
   还要有一条 REST 兜底通道。详见 [`REVERSE-ENGINEERING.md`](REVERSE-ENGINEERING.md) §3。

## 2. 分层

```
客户端 (Cherry Studio / NextChat / ChatBox / OpenAI SDK / Claude Code / Cline …)
        │  Authorization: Bearer sk-today-…
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ src/server.js        HTTP 路由 / CORS / 密钥鉴权 / 限流 / 错误映射      │
├────────────────────────────────────────────────────────────────────────┤
│ src/routes/                                                             │
│   openai.js      /v1/chat/completions  /v1/models                       │
│   anthropic.js   /v1/messages（Anthropic 形状）                          │
│   admin.js       /admin/api/*（账号、密钥、探针、会话、日志）             │
│   shared.js      读体 / SSE / 文本切块 / 错误码映射                       │
├────────────────────────────────────────────────────────────────────────┤
│ src/core/                                                               │
│   executor.js    选账号 → 发送 → 等回复 → 记账；首字节前故障转移          │
│   sessions.js    下游会话 → Today 会话映射（只推增量 / 分叉重开）         │
│   accounts.js    账号池持久化（session 脱敏输出）                        │
│   keys.js        下游密钥（sha256 摘要 + 分钟级限流）                     │
│   usage.js       用量账本（本地估算 token + JSONL 流水）                  │
│   models.js      today / today-main / today-task 三个会话语义别名        │
├────────────────────────────────────────────────────────────────────────┤
│ src/upstream/                                                           │
│   client.js      REST：/registry/devices /ws-ticket /v1/messages /v2/messages
│   socket.js      canonical-v1 长连接：hello/resume、心跳、逐帧回执、seq 恢复
│   replier.js     「等这一轮回答」：WS 事件订阅 + REST 兜底轮询            │
├────────────────────────────────────────────────────────────────────────┤
│ src/auth/                                                               │
│   token.js             session → JWT 换票、预刷新、401 强制刷新           │
│   credential-store.js  DPAPI + Chromium `v10` AES-GCM 读本机登录态        │
└────────────────────────────────────────────────────────────────────────┘
        │  Authorization: Bearer <jwt(aud=api.todayai.cn, exp≈10min)>
        ▼
   https://api.todayai.cn   （/v1/messages + /ws canonical-v1 广播）
```

## 3. 一次请求的完整生命周期

1. **鉴权**（`src/server.js`）：`Authorization: Bearer` / `x-api-key` → `sha256` 比对密钥表；未命中 401。
2. **限流**（`core/keys.js`）：按密钥的分钟窗口（`limits.requestsPerMinutePerKey` 或密钥自身 `rpm`，0 = 不限）。
3. **模型解析**（`core/models.js`）：`today` / `today-main` / `today-task` 决定**会话语义**；未知名字回落到 `today` 而不是报错。
4. **会话规划**（`core/sessions.js`）：
   - 会话键优先级：`x-today-conversation` 头 → body 的 `conversation_id/session_id/user` → 首条非 system 轮次的哈希；
   - 与已推轮次做公共前缀比较：是「延长」就只推增量，分叉就重开会话（`plan.mode = 'new'`）。
5. **选账号**（`core/executor.js` + `Scheduler`）：策略（round-robin / weighted / fill-first）+ 冷却 + 会话亲和。
6. **发送**（`upstream/client.js`）：拼 `POST /v1/messages`，三种目标形态之一（`isMainChat` / `conversationId` / `target:new_task`）。
7. **等回答**（`upstream/replier.js`）：
   - 主通道：常驻长连接的 `event.push`，只认 `chat.message_ready.v2` 且 `role=assistant` 且
     `conversationId` 匹配、`originClientMessageId` 或 `createdAt >= 发送时刻`（防重连重放误判）；
   - 兜底通道：`GET /v2/messages?conversationId=…&after=<用户消息 cursor>` 定时轮询；
   - 两条通道同时开，谁先到用谁。
8. **记账**（`core/usage.js`）：本地估算 token、延迟、会话 id、账号；落 `data/usage.jsonl` 并聚合。
9. **响应**：
   - `stream:false` → 一次性 JSON；
   - `stream:true` → 先吐 `role` delta，再把整段正文按 `stream.chunkChars` 切块吐出（**表现层模拟**，见 §6）。
10. **故障转移**：只在「还没向客户端写出任何字节」之前换账号重试（`pool.maxRetries`）。

## 4. 账号池状态机

```
        add（import-local / 管理台）
                │
                ▼
        ┌───► active ──── 上游 401/403 / auth.* ───► invalid（需重新登录）
        │       │
        │       ├── 429 / 5xx / 连接超时 / RUN_FAILED ──► cooling（cooldownUntil）
        │       │                                          │
        │       └──────────── 冷却到期 ◄───────────────────┘
        │
        └── 校验通过（GET /v1/users/me）

enabled=false ──► disabled（不参与调度）
```

- `effectiveStatus()` 每次读都按 `enabled / status / cooldownUntil` 现算，避免脏状态。
- `sessionAffinity`：同一「密钥 + 会话键」优先粘同一账号，减少同一对话在账号间跳动。
- 上游确认 session 失效后标记 `invalid` 并隔离，直到人工重新 `import-local` 或管理台导入。

## 5. 长连接（canonical-v1）实现要点

| 环节 | 做法 |
| --- | --- |
| 设备身份 | 首次 `POST /registry/devices` 拿到 `deviceId` 并**持久化到账号**；`clientMachineId` 稳定不变 |
| 设备档案 | `clientPlatform='windows'` + `clientType='windows-connector'`（与桌面端 socket 一致；实测 `web` 收不到 chat 事件） |
| 票据 | 每次（重）连接都重新 `POST /ws-ticket`（ticket 只有 60s 有效） |
| 握手 | 首连 `device.hello`（带 `messageProtocolVersion` 等能力位）；重连 `device.resume{sessionId,lastSeq}` |
| 心跳 | 用 `cloud.hello_ack` 给的 `heartbeatIntervalMs`（实测 30000），只在连接期跑 |
| 回执 | 每个带 `id/type/timestamp` 的帧回 `client.received` |
| 顺序 | 帧带 `seq`：按顺序投递；缺口进缓冲；缓冲溢出（512）则降级为「按到达顺序」并告警，避免一个丢包卡死整条链路 |
| 重连 | 指数退避 + 抖动（0.5s → 30s）；服务端因「新连接抢占」关闭（code 4001）时也走退避重连 |
| 关闭 | `server.close` → `socketPool.stopAll()`，不留悬挂句柄 |

## 6. 明确的能力边界（不骗客户端）

| 边界 | 说明 |
| --- | --- |
| **非 token 级流式** | 上游正文整段到达（`working.current.turn.content.text` 实测恒为空）。`stream:true` 的切块是**表现层模拟**，`finish_reason` 与内容本身与上游一致。 |
| **模型不可选** | CN 版没有档位接口。`/v1/models` 只暴露三个**会话语义**别名，不伪造假模型。 |
| **token 数是估算** | Today 不返回 usage。`usage` 字段是本地估算（CJK≈1 token/字，其余≈4 字符/token），不是计费依据。 |
| **开新会话会留痕** | 新会话只能靠 `target:{type:'new_task'}'`，会在用户的 Tasks 里产生记录。`today-task` 模式每请求一条。 |
| **无 `/v1/completions`、`/v1/embeddings`、`/v1/images/*`** | Today 的上游没有这些面（api-client 的 path 表里都没有），网关不假实现。 |
| **上游超时 = 504** | `upstream.replyTimeoutMs`（默认 180s）内没等到 assistant 消息就报超时，不会返回空回答。 |

## 7. 数据与安全

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `config/config.json` | 服务 / 上游 / 池 / 限流 / 流式设置 | 普通 |
| `data/accounts.json` | Today 登录 session（等价凭据）+ deviceId | 0600，接口只吐 `abcd****wxyz` |
| `data/keys.json` | 下游密钥 sha256 摘要 + 前缀 | 0600，明文只在创建时返回一次 |
| `data/sessions.json` | 下游会话 → Today `conversationId` 映射 + 已推轮次 | 0600 |
| `data/usage.jsonl` | 用量流水 | 普通 |

- 解密本机登录态**没有把任何密钥复制进仓库**：DPAPI 的钥匙就是「当前 Windows 用户」，
  `Local State` 与 `account-credentials.*` 都留在 Today 自己的目录里，只在导入时读一次。
- 管理台鉴权：设了 `server.adminPassword` 走 `Authorization: Bearer <密码>`；
  没设则只允许 `127.0.0.1/::1` 访问（默认只监听 `127.0.0.1`）。
- 跨平台：核心逻辑纯 Node 22+（用内置 `WebSocket`），只有 `import-local` 的 DPAPI 一步是 Windows 专属；
  其它平台可用 `--user-data-dir` + 手工导入 session。

## 8. 目录速查

```
TodayProxy/
├─ config/config.example.json      # 首次启动自动复制成 config.json
├─ data/                           # 运行时数据（已 gitignore）
├─ docs/
│  ├─ REVERSE-ENGINEERING.md       # 逆向报告（协议 + 实测）
│  ├─ ARCHITECTURE.md              # 本文件
│  └─ REA-EVIDENCE.md              # REA 取证坐标
├─ src/
│  ├─ cli.js                       # serve/doctor/import-local/accounts/key/models/probe/sessions/socket
│  ├─ server.js                    # 路由装配 + HTTP 服务
│  ├─ config.js
│  ├─ auth/{token,credential-store}.js
│  ├─ core/{executor,sessions,accounts,keys,usage,models}.js
│  ├─ upstream/{client,socket,replier}.js
│  ├─ routes/{openai,anthropic,admin,shared}.js
│  ├─ ui/admin.html                # 管理台（单文件，零依赖）
│  └─ util/{http,log,store,jwt}.js
└─ test/                           # node --test 单测（23 项）
```
