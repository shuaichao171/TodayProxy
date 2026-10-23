# TodayProxy · Today 反代网关

把 **Today（todayai.cn「小芽」Agent）** 的账号池，统一暴露成 **OpenAI / Anthropic 兼容 API**。
零运行时依赖（Node 22+ 标准库，用内置 `WebSocket`），自带管理台、账号池调度、失败冷却、用量记账。

> 逆向过程与协议证据见 [`docs/REVERSE-ENGINEERING.md`](docs/REVERSE-ENGINEERING.md)，
> 架构与调度设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，
> REA 取证坐标（产物哈希、evidence id、上游实测清单）见 [`docs/REA-EVIDENCE.md`](docs/REA-EVIDENCE.md)。

## 能力

- `POST /v1/chat/completions` — OpenAI 协议，支持 SSE 流式、`stream:false`
- `POST /v1/messages` — Anthropic 协议（`/v1/messages` 的 Anthropic 形状，含流式事件序列）
- `GET  /v1/models` — `today` / `today-main` / `today-task` 三个**会话语义**别名
- 账号池：round-robin / weighted / fill-first、失败冷却、登录态失效自动隔离、会话亲和
- **多轮会话映射**：下游会话 → Today `conversationId`，只推增量，历史分叉自动重开会话
- 下游密钥：`sk-today-…`，可限定模型、每分钟限流，明文只显示一次
- 管理台 `/admin`：账号、密钥、探针、长连接状态、会话映射、用量、原始日志
- 免登录导入：直接复用本机已安装 Today 的登录态（DPAPI + Chromium `v10` 解密，不落任何密钥）
- 长连接常驻：按 `canonical-v1` 协议订阅回答广播，REST 兜底轮询

## 快速开始

```bash
cd TodayProxy

# 1. 环境自检（找 Today 用户数据目录、解密凭据、验证上游连通性）
node src/cli.js doctor

# 2. 导入本机 Today 登录态（已装过 Today 并登录过即可）
node src/cli.js import-local

# 3. 生成一个给客户端用的密钥
node src/cli.js key create --name cherry-studio
#    → sk-today-xxxxxxxx…

# 4. 启动
node src/cli.js serve
#    http://127.0.0.1:8790/v1   ← 客户端 base_url
#    http://127.0.0.1:8790/admin ← 管理台
```

首次启动会自动生成 `config/config.json`（来自 `config/config.example.json`）。

## 客户端接入

### OpenAI 兼容（Cherry Studio / NextChat / ChatBox / OpenAI SDK / Cline）

```
Base URL: http://127.0.0.1:8790/v1
API Key : sk-today-xxxxxxxx          # 步骤 3 生成的
Model   : today                      # 或 today-main / today-task
```

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-today-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"today","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic 兼容（Claude Code 等）

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8790
ANTHROPIC_API_KEY=sk-today-xxxxxxxx
```

## 三个模型别名的区别（真会话语义，不是假模型）

| 模型 | 行为 | 什么时候用 |
| --- | --- | --- |
| `today`（默认） | 按 `pool.conversationMode` 走映射：首次请求新开 Today 会话，之后只推增量 | 几乎所有客户端 |
| `today-main` | 强制走账号**主对话**（`isMainChat:true`），上下文持续累积 | 想要「一个持续的个人助理会话」 |
| `today-task` | **每条请求**新开一个 Today 会话，全量重放历史 | 无状态批处理；注意会在用户 Tasks 里留记录 |

多轮记忆是按「会话」隔离的。网关靠 `x-today-conversation` 头（或 body 的 `conversation_id` / `session_id` / `user`）
区分下游会话；都不给时，用**第一条 user 消息**做指纹——所以标准「每次都发完整历史」的客户端能自动续上，
而只发最后一条消息的客户端每轮都会开新会话（想粘住就自己带 `x-today-conversation`）。

## 命令

```bash
node src/cli.js serve [--port 8790] [--host 127.0.0.1] [--admin-password x]
node src/cli.js doctor [--verbose]
node src/cli.js import-local [--user-data-dir <目录>] [--dry-run]
node src/cli.js accounts [list|check|enable|disable|rm|points] [accountId]
node src/cli.js key [list|create|rm] [--name x] [--rpm 60] [--models a,b]
node src/cli.js models [--json]
node src/cli.js probe [--model today|today-main|today-task] [--prompt "…"]
node src/cli.js sessions [list|purge|rm] [--key x]
node src/cli.js socket [--account acc_x] [--seconds 20]   # 裸看上游 event.push 流
npm test                                                   # 离线单测（23 项）
```

## ⚠️ 服务在跑时，别用 CLI 直接改 `data/`

`serve` 启动时把 `data/accounts.json`、`data/keys.json`、`data/sessions.json` **整表读进内存**，
之后每次写盘都是整表覆盖。所以服务在跑的时候用另一个进程去改这些文件，新增内容会被内存快照抹掉。

| 操作 | 服务在跑时用这个 ✅ | 服务已停时用这个 ✅ |
| --- | --- | --- |
| 导入本机登录态 | 管理台「导入本机 Today 登录态」，或 `POST /admin/api/accounts/import-local` | `node src/cli.js import-local` |
| 建 / 删密钥 | `POST /admin/api/keys`、`DELETE /admin/api/keys/:id` | `node src/cli.js key create` / `key rm` |
| 启停 / 删账号 | `PATCH` / `DELETE /admin/api/accounts/:id` | `node src/cli.js accounts enable\|disable\|rm` |
| 校验账号 | `POST /admin/api/accounts/:id/check` | `node src/cli.js accounts check <id>` |

不改 `data/` 的命令随时可跑：`doctor`、`probe`、`key list`、`accounts list`、`sessions list`、`socket`。

## 配置要点（`config/config.json`）

| 键 | 说明 |
| --- | --- |
| `server.host` / `server.port` | 监听地址，默认 `127.0.0.1:8790` |
| `server.adminPassword` | 管理台密码；**留空＝仅本机可访问**；对外暴露前必须设置 |
| `upstream.apiBaseUrl` | 业务上游，生产 `https://api.todayai.cn` |
| `upstream.authBaseUrl` | 账号服务，生产 `https://auth.todayai.cn` |
| `upstream.clientPlatform` / `clientType` | 设备注册档案；**必须是 `windows` + `windows-connector`**，用 `web` 收不到聊天事件 |
| `upstream.replyTimeoutMs` | 等待 assistant 消息的上限（默认 180000） |
| `upstream.connectRetries` | 连接层失败（未拿到响应头）立即重连的重试次数（0–3，默认 1） |
| `upstream.socketEnabled` | 是否常驻长连接；关掉就只能靠 REST 轮询（更慢、更费） |
| `upstream.restPollIntervalMs` | 兜底轮询间隔（默认 1500） |
| `auth.todayUserDataDir` | Today 用户数据目录；留空则按 `%APPDATA%` 候选名自动找 |
| `pool.strategy` | `round-robin` / `weighted` / `fill-first` |
| `pool.maxRetries` | 失败后最多换几个账号重试（0–5） |
| `pool.cooldownSeconds` | 失败账号冷却时长 |
| `pool.sessionAffinity` | 同一会话是否粘同一账号 |
| `pool.conversationMode` | `session`（默认）/ `main` / `task` |
| `pool.conversationTtlSeconds` | 会话映射过期时间（默认 86400） |
| `limits.requestsPerMinutePerKey` | 每密钥每分钟请求上限，0 = 不限 |
| `stream.chunkChars` / `stream.chunkDelayMs` | 流式「打字机」的切块大小与间隔 |
| `stream.simulate` | `false` 则整段一次性吐出（没有模拟切块） |

环境变量覆盖：`TODAY_PROXY_HOST/PORT/ADMIN_PASSWORD/API_BASE/AUTH_BASE/APP_VERSION/REPLY_TIMEOUT_MS/SOCKET/USER_DATA_DIR/CONVERSATION_MODE/LOG_LEVEL`。

## 免责与边界
> **本项目与 TODAY AI PTE. LTD. 无任何关联**，非官方作品，未获得任何授权或背书。
> "Today"、"todayai.cn" 等名称与商标归其各自权利人所有。本项目不包含、不分发 Today 的任何二进制、图标或专有资源。
> 仓库中的 `docs/` 是对**公开可下载客户端**的互操作性分析记录，仅用于说明本项目为何如此实现。

- 本项目只做**协议复刻与自用聚合**，不破解、不修改 Today 客户端；账号与计费仍由 Today 服务端裁决。
- 上游**没有 token 级流式**：回答整段到达，`stream:true` 的切块是表现层模拟（见架构文档 §6）。
- 上游**不接受客户端指定模型**，`/v1/models` 只暴露会话语义别名，不伪造模型列表。
- 用量里的 token 数是**本地估算**，不是 Today 的计费数据。
- 未实现：`/v1/completions`、`/v1/embeddings`、`/v1/images/*`、语音（上游没有这些面）。
- 请遵守 Today 的服务条款与当地法律法规；不要用于公开二次分发或商业转售。
- 使用前请自行评估合规风险。作者不对因使用本项目产生的任何后果负责（见 [LICENSE](LICENSE)）。
