# Today（todayai.cn）逆向分析报告

> 目标：Today CN Desktop 1.22.7（TODAY AI PTE. LTD.，Electron 43 + 内嵌 Next.js）。
> 下文用 `<Today>` 代指其本机安装目录。
> 目的：取得上游「对话/Agent」协议与鉴权细节，据此实现 OpenAI / Anthropic 兼容反代网关。
> 分析日期：2026-10。下文每条结论都标注了「静态坐标」或「实测坐标」，两者可交叉复算。
> REA 取证坐标（产物 SHA-256 / evidence id）见 [`REA-EVIDENCE.md`](REA-EVIDENCE.md)。

## 0. 结论速览

| 项目 | 结论 |
| --- | --- |
| 应用形态 | Electron 43.1.1（Chrome 150）+ 打包的 Next.js standalone 运行时；业务代码**未混淆**，主进程 bundle 里保留了完整 TS 源码（含中文注释） |
| 硬完整性 | `EnableEmbeddedAsarIntegrityValidation=disabled`、`OnlyLoadAppFromAsar=disabled`、`RunAsNode=enabled`（REA `inspect_electron_fuses`） |
| 业务 API | `https://api.todayai.cn`（认证 `https://auth.todayai.cn`，站点 `https://todayai.cn`） |
| 鉴权两级 | ① **登录 session**（等价 better-auth session token，`A-Za-z0-9_-`，32 位，有效期数十天）→ ② **访问 JWT**（ES256，`aud=https://api.todayai.cn`，几分钟过期），随访问令牌一起刷新 |
| 换票 | `GET {authBase}/api/auth/token`，`Authorization: Bearer <session>` → `{token, expiresIn}`；桌面端走这条，网页端走 `POST {authBase}/api/token` + cookie |
| 对话协议 | **自有协议**：`POST /v1/messages` 立刻返回 202，回答通过 **WebSocket `canonical-v1`** 的 `event.push` 广播；没有 SSE、没有 `chat/completions` |
| 流式粒度 | **不是 token 级**：`chat.presentation.updated.v1` 只给 typing/工具状态，正文在 `chat.message_ready.v2` 里**整段**到达 |
| 会话是有状态的 | 上游按 `conversationId` 维护历史，客户端只发增量；主对话 = 账号 id（`isMainChat:true`）；新会话只能用 `target:{type:'new_task',surface:'task_panel'}` 创建 |
| 模型选择 | 客户端**不能**选具体模型，只能选 `mode.fast/balanced/power`；CN 版连档位接口都没有（`/v1/pricing/model-option` → 404） |
| 本地登录态 | `%APPDATA%\Today CN\account-credentials.{head,slot-a,slot-b}`，Chromium OSCrypt `v10`（AES-256-GCM），密钥来自 `Local State` 的 DPAPI blob |

## 1. 产物结构与取证

```
<Today>\
├─ TodayCN.exe                      # Electron 主程序（225 MB，PE，sha256 2e2a91a5…）
├─ resources\
│  ├─ app.asar                      # 38 MB，1878 个文件；主进程业务代码
│  │  ├─ dist/app/app/index.js      # ★ 主进程 bundle（10 MB / 26.7 万行，未混淆、含注释）
│  │  ├─ dist/preload/desktop.cjs    # preload（IPC 桥，含 window.WebExtendedAPI）
│  │  └─ dist/app/consts/*.mjs       # 公开配置：OAuth client id、api/auth/app 地址…
│  ├─ web-runtimes\prod.asar        # 61 MB，内嵌 Next.js 运行时的「服务端」产物
│  │  └─ apps/web\.next\server\      # 140 条路由 + api-client（含全部上游 path）
│  │     └─ .next\static\chunks\     # ★ 前端 chunk（unpacked，306 个文件 / 24 MB）
│  ├─ tools\windows\TodayWindowsPlatformHost.exe
│  └─ web-runtimes\manifest.json     # {"defaultEnvironment":"prod","deepLinkScheme":"today"}
└─ resources\app.asar.unpacked\node_modules\@napi-rs\lzma-*   # 唯一 unpacked 原生模块
```

取证要点：

- **主进程 bundle 没有混淆**。`dist/app/app/index.js` 里 `;// CONCATENATED MODULE: ../../packages/...` 保留了原始文件路径，
  `webpack/rspack` 只做了打包，注释与中文文档字符串都在。这使「逐行对照客户端行为」成为可能。
- 前端是 Next.js standalone（服务端在 `prod.asar`，静态 chunk 在 `prod.asar.unpacked`）。
  `routes-manifest.json` 直接给出上游反代规则：
  ```json
  "rewrites": { "afterFiles": [
    { "source": "/api/cloud/:path*",    "destination": "https://api.todayai.cn/:path*" },
    { "source": "/api/cloud-cn/:path*", "destination": "https://api.todayai.cn/:path*" }
  ]}
  ```
- `resources/app-update.yml` 指向 `releases.todayai.cn/apps/today/desktop/windows-cn/...`，可确认这是 CN 渠道包。

## 2. 鉴权

### 2.1 环境常量（CN 构建写死）

`dist/app/app/index.js:228205` 把 `DESKTOP_CLOUD_PUBLIC_CONFIG` 内联成：

```js
prod: { apiBaseUrl:        'https://api.todayai.cn',
        appUrl:            'https://todayai.cn',
        baseDomain:        'todayai.cn',
        betterAuthUrl:     'https://auth.todayai.cn',
        oidcAuthority:     'https://auth.todayai.cn',
        oidcClientId:      'Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx',
        tokenAudience:     'https://api.todayai.cn' }
```

### 2.2 两级凭据

```
登录 session（better-auth 的 {token}，32 位 A-Za-z0-9_-）
        │  GET {authBase}/api/auth/token
        │  Authorization: Bearer <session>
        ▼
访问 JWT（ES256，iss=https://auth.todayai.cn，aud=https://api.todayai.cn，exp≈600s）
        │  Authorization: Bearer <jwt>
        ▼
业务接口 {apiBase}/v1/*、/registry/devices、/ws-ticket
```

静态坐标（主进程 bundle）：

- `AccountSessionTokenClient.issue()`（`index.js:100167`）—— 桌面端换票：
  ```js
  this.http.request(fetcher, new URL('/api/auth/token', config.authBaseUrl), {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: webOrigin, ... },
  })
  // → { token, expiresIn }，fallback TTL 540s
  ```
- 请求头由 `AccountHeaders.build()`（`index.js:99718`）生成：
  `Accept: application/json`、`X-App-Version`、`X-Client-Platform`、`Origin`（可选）。
- 网页端另有一条：`resolveBetterAuthCloudBearer()`（`prod.asar: chunks/[root-of-the-server]__0275ew3._.js`）——
  `POST {authBase}/api/token` + 转发 cookie，body `{audience, expiresIn:3600}`。
- `x-client-platform` 的取值映射（`index.js:99704`）：桌面平台名 → 账号服务需要的 `windows|macos|linux`。

### 2.3 实测

| 观测 | 结果 |
| --- | --- |
| `GET https://auth.todayai.cn/api/auth/token` + `Bearer <session>` | **200** `{"token":"eyJhbGciOiJFUzI1NiIs…","expiresIn":600}` |
| 同请求 + 不带 session | 401 |
| `GET /api/auth/get-session` + `Bearer <session>` | 200，`session.expiresAt` 约 60 天后（本次实测 2026-12-22） |
| `GET https://api.todayai.cn/v1/users/me` + `Bearer <jwt>` | 200，返回 `id/preferredName/defaultAgent/userFacts` |
| `GET /v1/users/me/protocol-capabilities` | 200，`{"architecture":"canonical","messageCapabilities":{"messageProtocolVersion":"canonical-v1","mainConversationId":"<userId>","supportsLongPoll":true,"longPollWaitMaxMs":25000,…}}` |
| 旧 accessToken 过期后仍能用 session 换新的 | 是（本次实测缓存 token 已过期，换票正常） |

## 3. 对话协议

### 3.1 发送：`POST /v1/messages`

Schema 来自前端 api-client（`prod.asar.unpacked/apps/web/.next/static/chunks/*.js`，`appendCanonicalMessageRequestSchema`）：

```ts
// 三种目标，互斥
A) { body:{parts:[…]}, clientMessageId, isMainChat:true }                    // 主对话（账号 id）
B) { body:{parts:[…]}, clientMessageId, conversationId, taskId? }            // 指定会话续聊
C) { body:{parts:[…]}, clientMessageId, target:{type:'new_task',surface:'task_panel'} }  // 新任务/新会话
// parts 元素： { id, type:'text', text } | { id, type:'image|file|voice', uploadedFile:{…} } | { id, type:'link', url }
```

响应：

```json
{ "threadId":"01a16…", "messageId":"01a16…", "clientMessageId":"…", "createdAt":"…",
  "isDuplicate":false, "taskId":"01a16…",
  "canonicalMessage":{ "id":"…", "conversationId":"…", "threadId":"…", "cursor":"eyJ2Ijox…",
                       "role":"user", "state":"completed", "isFinal":true, "body":{"parts":[…]} } }
```

`HTTP 202`。**注意：这里拿到的只是「用户消息已入库」，不是回答。**

### 3.2 会话语义（实测）

| 发法 | 结果 |
| --- | --- |
| `isMainChat:true` | 落在账号主对话（`mainConversationId == userId`），延迟最低（实测 2.7–3.1s） |
| `conversationId:<已有>` | **续在同一会话**，上下文保留（实测：先说「记住 77」，下一发问「刚才的数字」，答 `77`） |
| `conversationId:<随机 uuid>` | **404**（会话必须先被创建） |
| `target:{new_task}` | 新建会话 + 新建 task，`conversationId` 在响应里返回；延迟明显更高（实测 6.5–12s） |
| `POST /v3/conversations` | 需要 `Idempotency-Key` 头 + 未知 body，**未解**（400），本项目不使用 |

### 3.3 接收：WebSocket `canonical-v1`

静态坐标：主进程 `packages/socket/src/classic/index.ts`（`index.js:198725` 起，含完整协议注释）：

```
1. POST /registry/devices        注册设备（clientPlatform+clientType+platform+version+clientMachineId）
2. POST /ws-ticket               返回 { ticket }（可选响应头 x-websocket-url）
3. wss://<api>/ws?ticket=…[&lane=…]   （buildWsUrl: index.js:200174）
4. device.hello（首连）/ device.resume{sessionId,lastSeq}（重连）
5. 等 cloud.hello_ack（含 heartbeatIntervalMs / sessionId / messageProtocolVersion）
6. 每帧回执 client.received{originId,originType,originSeq?,originTimestamp}
7. event.push 就是业务事件；帧带 seq，需按序消费（缺口用 device.resume 补）
```

设备注册的**服务器端枚举**（实测报错信息）：`clientPlatform ∈ macos|ios|android|windows|browser|web|linux`。
桌面端的 socket 设备档案是 `clientPlatform:'windows'` + `clientType:'windows-connector'`（`index.js:200263`）。

`event.push` 形状：

```json
{ "type":"event.push", "id":"…", "timestamp":"…", "seq":3,
  "payload": { "event":"chat.presentation.updated.v1", "threadId":"…", "data": { … } } }
```

本项目关心的 chat 事件（`realtime-contract/src/socket/event-names.ts`）：

| 事件 | 作用 |
| --- | --- |
| `chat.message_ready.v2` | 一条消息落库。`data.message.role='user'` 是回声；`='assistant'` 才是回答，正文在 `data.message.body.parts[].content.text` |
| `chat.presentation.updated.v1` | typing / `working.current.turn.content.text[]` / 工具状态快照（**实测正文数组恒为空**） |
| `chat.run_completed.v2` / `chat.run_failed.v2` | 一轮任务收尾 |
| `chat.tool_started.v2` / `chat.tool_completed.v2` | Agent 工具调用 |
| `rapport.updated.v1` | `{currentPoints,nextLevelPoints,currentLevel,progress}` —— 积分余额 |

### 3.4 实测坐标（对上游的直接观测）

均在 2026-10-23 用本机已登录账号对**生产**上游发起：

| 观测 | 结果 |
| --- | --- |
| `POST /registry/devices`（`clientPlatform:'web'`） | 201，但**收不到 chat 事件** |
| `POST /registry/devices`（`clientPlatform:'windows'` + `clientType:'windows-connector'`） | 201，**事件正常** |
| `POST /ws-ticket` | 200，ticket 是 HS256 JWT，claims `{kind:'ws_ticket',trafficLane:'baseline',browserMessages:true,aud:'cloud-service-ws',exp:+60s}` |
| `wss://api.todayai.cn/ws?ticket=…` + `device.hello` | `cloud.hello_ack`，`heartbeatIntervalMs=30000`，协商 `canonical-v1` |
| 首连立即收到的帧 | `cloud.devices_updated`、`event.push{agent_indicator.status.v1}` |
| 发消息后的事件序列（主对话） | `message_ready.v2(user)` → `presentation.updated.v1(presentation.typing)` → `presentation.updated.v1(working in_progress, text:[])` → `presentation.updated.v1(working completed, text:[])` → `message_ready.v2(assistant)` |
| 一轮回答延迟 | 主对话 2.7–3.1s；`new_task` 6.5–12s |
| `working.current.turn.content.text` | 两次事件都是 `[]`；正文只在 `message_ready.v2` 里整段出现 → **无 token 级流式** |
| `GET /v2/messages?conversationId=…&limit=N` | 200，按会话取历史（含 `role/state/isFinal/messages[].content.text`），可作为事件通道的兜底 |
| `GET /v1/messages?limit=N` | 200，扁平列表（legacy 形状） |
| `GET /v1/pricing/status` | 200，`{plan:'pro',accessSource:'manual_internal',entitlementEndsAt:…}` |
| `GET /v1/pricing/model-option` | **404**（CN 版没有档位接口） |
| `GET /v3/live/model-options` | 403（实时语音档位，不适用） |
| `GET /v1/agents/default` | 200，返回 agent 人设 `agentName/aboutMe/agentCharacter/userFacts` |
| `POST /v1/completions`、`/v1/chat/completions` | 不在 api-client 的 path 表里（Today 没有 OpenAI 兼容面） |

api-client 的全部 path（`url:"…"`，共 100+ 条，节选）：

```
/v1/messages                  /v1/messages/batch        /v2/messages[/{messageId}]
/v1/conversations/messages    /v1/conversations/unread-status
/v1/users/me[/protocol-capabilities]   /v1/config      /v1/files
/v3/conversations[/{id}/messages|message-changes]      /v3/messages
/v3/today/batch                /v1/today-pages/latest   /v1/memories/overview
/v1/connectors…                /v1/channels…            /v1/pricing/status
/v3/live/conversations[/{id}/events]                   /v1/client/logs
```

## 3.5 模型目录（服务端驱动）

**客户端不能选模型，但服务端有完整模型池。** 两个可读接口：

### `GET /v1/pricing/status` → `data.status.modelOptions`（无需 admin）

```json
{ "schemaVersion": 1,
  "display": { "title": "Model", "tailNote": "Multipliers show relative quota usage across models for similar tasks." },
  "selectedOptionId": "model.deepseek-v4.1-flash",
  "options": [
    { "id": "model.deepseek-v4.1-flash", "display": { "title": "DeepSeek V4.1 Flash", "subtitle": "Usage multiplier: 1×" } },
    { "id": "model.glm-5.3",            "display": { "title": "GLM 5.3",             "subtitle": "Usage multiplier: 4×" } }
  ] }
```

实测（本机账号）：**实际生效的是 `model.deepseek-v4.1-flash`，用量倍率 1×**；
另一档 `model.glm-5.3` 倍率 4×（即同样任务消耗 4 倍额度）。
这是唯一不需要 admin 就能读到「当前用哪个模型」的地方。

### `GET /v1/llm/models` → 服务端模型池（34 个，无需 admin）

```
claude-haiku-4-5   claude-sonnet-4-6  claude-sonnet-5    claude-opus-5      claude-opus-4-6
gpt-5.5            gpt-5.6-sol        gpt-5.6-terra      gpt-5.6-luna       gpt-6-astra
gpt-6-astra-fast   grok-4.5           grok-4.6           deepseek-v4-flash  deepseek-v4.1-flash
deepseek-v4-flash-0731  deepseek-v4-flash-vision-exp  deepseek-v4-pro  deepseek-v4-pro-0813
kimi-k2.6          inkling-small      glm-5.1            glm-5.2            glm-5.3
glm-5.3-flash      minimax-m3         qwen3.7-max        qwen3.7-plus       qwen3.6-flash
qwen3.8-flash      doubao-seed-2.0-pro  doubao-seed-2.0-lite  doubao-seed-2.0-mini  mimo-v2.6-pro
```

用户可见的只有上面 `modelOptions.options` 里那 2 个；34 个是服务端内部池
（含 Anthropic / OpenAI / xAI / DeepSeek / Moonshot / 智谱 / MiniMax / 阿里 / 字节 各家）。

### 为什么不能通过网关切换模型

| 接口 | 实测 |
| --- | --- |
| `GET /v1/pricing/model-option` | **404** |
| `POST /v1/pricing/model-option` + `{optionId}` | **404** |
| `GET /v3/live/model-options` | 403 `auth.forbidden`（实时语音档位，不适用） |
| `GET /v1/admin/users/me/model-selections` | 403 `Admin access required` |
| `PATCH /v1/admin/users/me/model-selections` | 需 admin（body `{chatModelId?, taskModelId?}`） |

客户端 zod 里确实有 `zUpdatePricingModelOptionBody = {optionId: enum([...])}`，
但那 5 个 id（`mode.fast/balanced/power` + 两个 `model.*`）只在**全局构建**的客户端枚举里，
CN 服务端没有实现对应路由。所以**只能读、不能改** —— 结论与 §0 「客户端不能选具体模型」一致，
但补充了「当前实际用哪个」是可读的。

### 客户端文案里的档位（供对照）

主进程 bundle `~line 31667758` 的 `zPricingModelOptions.options[].id` 枚举：

```
'mode.fast' | 'mode.balanced' | 'mode.power' | 'model.deepseek-v4.1-flash' | 'model.glm-5.3'
```

而 CN 服务端 `/v1/pricing/status` 只返回后两个 —— 即 `mode.*` 三档在 CN 上是死枚举。

### 反面证据（防止误判）

`prod.asar` 里 `deepseek` 命中 18 次、`anthropic` 209 次、`openai` 255 次，
但全部是 **OpenTelemetry 语义约定常量**（`gen_ai.usage.input_tokens.cached`、
`n.deepseek.promptCacheHitTokens`、`vercel.${e}` 等）与 provider 名表，
**不是**任何 LLM 调用或 API key。真实的模型调用发生在 Today 云端。

> 取证方法告誑：本机 GNU grep 3.0 在 UTF-8 locale 下 `grep -i` 会**漏匹配**
> （`grep -aoiF deepseek` = 0，而 `grep -aoF deepseek` = 3，`grep -aoi DeepSeek` = 3）。
> 凡涉及大小写无关的字符串普查，必须改用 node 逐字节 toLowerCase 计数（脚本见提交说明），
> 否则会得出错的「不存在」结论。

## 4. 本机登录态（免登录导入）

### 4.1 文件布局

`electron/../credential-store`（主进程 bundle `index.js:111989` 起）定义了：

```
{userData}/account-credentials.head          # {formatVersion:1, state:'signed-in', slotIndex:0|1, generation}
{userData}/account-credentials.slot-a|slot-b # {formatVersion:1, generation, record:{…}}
{userData}/account-credentials.signed-out    # 登出屏障（存在即视为未登录）
```

`userData` = `%APPDATA%\Today CN`（CN prod；国际版是 `Today`，dev 是 `Today CN Dev`，见 `consts/user-data-public-config.mjs`）。

### 4.2 加解密链路（实测可复算）

```
Local State:  os_crypt.encrypted_key = "DPAPI" + DPAPI(32B AES key)
                        │  CryptUnprotectData（当前 Windows 用户）
                        ▼
                  AES-256-GCM key
slot 文件:      "v10" | nonce(12) | ciphertext | tag(16)
                        │  AES-256-GCM 解密
                        ▼
{formatVersion:1, generation:0,
 record:{ environment:'prod', source:'better-auth-session',
          accessToken:'eyJhbGciOiJFUzI1NiIs…', accessTokenExpiresAt:1792769113548,
          refreshCredential:'<32 位 better-auth session>',
          user:{id:'<userId>', avatarUrl:'https://assets.todayai.cn/…'},
          schemaVersion:2 }}
```

- `v10` 就是 Chromium OSCrypt 的 Windows 变体（本仓库 `src/auth/credential-store.js` 里逐字节复刻）。
- 实测：`Local State` 的 key blob 前缀 `DPAPI`，DPAPI 解出 32 字节；slot-a 解密后得到
  `refreshCredential`（session）与一个 `aud=https://api.todayai.cn` 的 JWT。
- 用解出的 session 去换票 → 200，与人账（`/v1/users/me`）一致 → 整条链路闭环。
- Electron `safeStorage` 也只做同样的事（`SafeStorageCredentialCipher.encrypt = safeStorage.encryptString`），
  所以本机解密不需要任何破解，只需要「与 Today 同一 Windows 用户」。

### 4.3 Cookie 面

`{userData}/Network/Cookies`（SQLite）在实测机器上只有 posthog cookie；
会话在桌面端走 `account-credentials.*`，网页端走 better-auth cookie
（`better-auth.session_token` / `__Secure-better-auth.session_token`，域 `.todayai.cn`）。
桌面端把网页会话镜像成 `__Secure-today.desktop_session`（`chunks/[root-of-the-server]__0sodu9v._.js`）。

## 5. 与反代的对应关系

| 逆向结论 | 反代实现 |
| --- | --- |
| 两级凭据（session → JWT） | `src/auth/token.js`：`TokenManager` 按 exp-60s 预刷新 + 401 强制刷新 |
| 本机登录态是加密槽文件 | `src/auth/credential-store.js`：DPAPI + `v10` AES-GCM，CLI `import-local` 一键导入 |
| 发消息是「202 受理」，回答走 WS 广播 | `src/upstream/replier.js`：订阅 `chat.message_ready.v2`（按 conversationId + clientMessageId/时间过滤）+ `GET /v2/messages?after=` 兜底轮询 |
| 会话有状态、客户端只发增量 | `src/core/sessions.js`：下游会话 → Today 会话映射，只推增量；分叉就重开 |
| 新会话只能靠 `target:new_task` | `src/core/executor.js`：`planner.mode==='new'` 时用 `target` 形态发送 |
| 没有 token 级流式 | `src/routes/shared.js#sliceText`：整段回答切块吐出，并在文档里明确标注这是表现层模拟 |
| `clientPlatform` 必须非 `web` 才收事件 | `config.upstream.clientPlatform='windows'` + `clientType='windows-connector'`（与桌面端 socket 档案一致） |
| `rapport.updated.v1` 带积分 | 管理台/未来扩展可读；用量账本另记本地估算 token |

## 6. 残余未知与边界

- **`POST /v3/conversations` 未解**：需要 `Idempotency-Key` 头和一个未知 body（4 种 guess 都 400），
  所以「开新会话」只能走 `target:{type:'new_task',surface:'task_panel'}`，代价是会在用户的 Tasks 里留下记录。
- **无 token 级流式**：`working.current.turn.content.text` 实测恒为空数组，
  增量只能在客户端「假装」打字机。若上游以后填充该字段，`chat.presentation.updated.v1` 已经解析好，可直接接上。
- **模型不可选**：CN 版没有档位接口，本项目不伪造模型列表，只暴露 `today / today-main / today-task`
  三个**会话语义**别名。
- **计费不可见**：`points_consumed` 这类字段 Today 不返回；只有 `rapport.updated.v1` 的余额，
  且需要常驻长连接才能稳定收到。用量账本里的 token 数是**本地估算**（CJK≈1 token/字，其余≈4 字符/token）。
- **REA 覆盖声明**：静态分析只覆盖了 5 个指定源文件（app.asar）与 4 个（prod.asar），
  `app.asar` 另有 1769 个、`prod.asar` 另有 3658 个文件在分析范围外；
  所有关于上游行为的断言以 §2.3 / §3.4 的实测为准，静态结论只用来解释「客户端为什么这么发」。
- 另一条更细的长连接语义（`device.resume` 的序号恢复、共享 Worker 抢占、`client.status` 在场态）本项目做了
  **保守子集实现**：按 seq 顺序消费 + 溢出降级 + 断线退避重连；未实现多端抢占的完整策略。
