# REA 取证记录

本文只记录**可复算的取证坐标**（产物 SHA-256、REA evidence id、关键实测），不把 REA 的完整
evidence bundle 放进仓库。需要完整 bundle 时按 §5 的命令重新导出。

## 1. 被分析产物

| 产物 | SHA-256 | 说明 |
| --- | --- | --- |
| `E:\Today CN\TodayCN.exe` | `2e2a91a55bcd595d8e05f682f9695058ca9b755c9e9a827526a5e4434e20c4c0` | Electron 主程序（225 501 448 字节，PE） |
| `E:\Today CN\resources\app.asar` | `65da6e187bdc1ae094eb6144b63b9dcdf448748a27f502d7ef0c052035452d30` | 应用包（38 378 183 字节，1878 个文件） |
| `E:\Today CN\resources\web-runtimes\prod.asar` | `396993faaf9972079ef3c70a0afb81351d35ad1ab98a873ac1d587f242a2b893` | 内嵌 Next.js 运行时（60 992 301 字节） |

补充事实（不依赖 REA，可自行核对）：

- asar 头部：`| UInt32:4 | UInt32:headerPickleSize | UInt32:jsonLength | UInt32:jsonLength | JSON |`，
  数据段起点 = `align4(16 + jsonLength)`。实测 `jsonLength=485266` → 数据段 `485284`；
  用 `"{\n  \"name\": \"today-desktop-cn\""` 定位得 `485284 + declaredOffset`，与此一致。
  （注意：直接按 `16 + jsonLength` 取会整体偏移 2 字节，读出来的 JSON 都是坏的。）
- 有 1 个 unpacked 文件：`node_modules/@napi-rs/lzma-win32-x64-msvc/lzma.win32-x64-msvc.node`。

## 2. Electron fuse 读取

工具：`rea_inspect_electron_fuses`
Evidence：`ev_64c561f694d5cb03385be06d891f982f2e220f0b5a8438bd36072cda53af0a19`
（sentinel offset `181321872`，wire_version 1，declared_length 9，`complete: true`）

| fuse | 状态 | 影响 |
| --- | --- | --- |
| `RunAsNode` | enabled | 可用 `ELECTRON_RUN_AS_NODE` 以 Node 方式跑主程序 |
| `EnableCookieEncryption` | disabled | cookie 未加 app-bound 层（实测 `Cookies` 里确实只有 posthog） |
| `EnableNodeOptionsEnvironmentVariable` | enabled | `NODE_OPTIONS` 生效 |
| `EnableNodeCliInspectArguments` | enabled | 可开 Inspector |
| `EnableEmbeddedAsarIntegrityValidation` | **disabled** | asar 无完整性校验 → 可静态读取、可热替换 |
| `OnlyLoadAppFromAsar` | **disabled** | 允许从 asar 之外加载代码 |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled | — |
| `GrantFileProtocolExtraPrivileges` | enabled | `file://` 权限放大 |
| `WasmTrapHandlers` | enabled | — |

REA 给出的 runtime implications：`embedded_asar_integrity_validation → not_enforced`、
`only_load_app_from_asar → not_restricted_to_app_asar`、`electron_run_as_node → honored`、
`node_cli_inspect_arguments → honored`。

## 3. JavaScript 应用静态分析

### 3.1 主进程（app.asar）

工具：`rea_analyze_javascript_application`
`input_path=E:\Today CN\resources\app.asar`，`integrity_policy=record-and-continue`

| 证据 | 用途 | 统计 |
| --- | --- | --- |
| `ev_3fb9954ce9c3022d1afa5e78a3f8c3ce7e00e5b1518ad0b6f7af0d8d4f4bf463`（父） | 首次分析 | 5 个源文件、1 017 603 AST 节点、828 findings、17 modules、0 parse failure |
| `ev_9074d96d327f2623b4112a7694253756e3f13c177f3c8824f6f91d8bc53b041d` | 上者的 summary 视图 | `complete-within-view`，12 limitation |

分析范围（相对 asar 根）：

```
dist/app/app/index.js                  ← ★ 主进程 bundle：socket 协议、凭据存储、账号换票
dist/preload/desktop.cjs               ← preload（window.WebExtendedAPI.socket 桥）
dist/app/consts/account.js             ← ACCOUNT_CONFIG（api/auth/app 地址、OAuth client id）
dist/app/consts/cloud-public-config.mjs ← DESKTOP_CLOUD_PUBLIC_CONFIG_DEFAULTS
dist/app/utils/index.js                ← 工具层
```

REA 统计到的 Electron 面：`context_bridge_apis=1`、`ipc.operations=3`（全部是**动态 channel**表达式，
所以 `literal_channels=0`、`main_handlers=0`）、`sender_validation_observations=12`。
本项目的结论**没有**依赖 IPC 通道名，而是直接读 socket 客户端与凭据存储的实现。

### 3.2 内嵌 Next.js 运行时（prod.asar）

工具同上，`input_path=E:\Today CN\resources\web-runtimes\prod.asar`

| 证据 | 用途 | 统计 |
| --- | --- | --- |
| `ev_8c807dad96f09e6be8f4f1ba1e9eaf48df7a42e2e4f1987bdc9337e66486c744`（父） | 首次分析 | 4 个源文件、121 589 AST 节点、20 findings、7 limitation |
| `ev_c729b37c4ae82e6811b4de3d14c2687a271145e3e9f8b91625a5d0e3df620d23` | 上者的 summary 视图 | `complete-within-view`，`request` 家族保留 9 条关系 |

分析范围：

```
apps/web/.next/server/chunks/ssr/packages_api-client_src_17q6z9q._.js               ← api-client（含全部上游 path）
apps/web/.next/server/chunks/ssr/packages_api-client_src_generated_zod_gen_ts_0eqa0pq._.js ← zod 生成物
apps/web/.next/server/chunks/[root-of-the-server]__0275ew3._.js                      ← resolveAuthBaseUrl / 换票
apps/web/.next/server/chunks/_1k3u5de._.js                                           ← desktop-session 路由实现
```

REA 的 `request` 家族保留关系与手工阅读得到的 4 个网络面一致：
① 账号服务换票 ② 业务 REST（api-client） ③ `/registry/devices` ④ `/ws-ticket`。

## 4. 实测坐标（对上游的直接观测）

均在 2026-10-23 使用本机已登录 session 对**生产**上游发起。只记录结构与计数，不记录凭据值。

| 观测 | 结果 |
| --- | --- |
| `GET {authBase}/api/auth/token`（`Bearer <session>`） | 200 `{"token":"eyJ…ES256","expiresIn":600}` |
| 同请求去掉 `Authorization` | 401 |
| `GET /api/auth/get-session` | 200，`session.expiresAt=2026-12-22` |
| `GET {api}/v1/users/me` | 200，含 `defaultAgent`（agentName/aboutMe/agentCharacter/userFacts） |
| `GET /v1/users/me/protocol-capabilities` | 200，`architecture=canonical`、`messageProtocolVersion=canonical-v1`、`supportsLongPoll=true` |
| `POST /registry/devices`（`clientPlatform:'web'`） | 201，但后续收不到 `chat.*` 事件 |
| `POST /registry/devices`（`clientPlatform:'windows'`/`clientType:'windows-connector'`） | 201，事件正常 |
| `POST /ws-ticket` | 200，ticket=HS256 JWT（`kind=ws_ticket`、`aud=cloud-service-ws`、`exp=+60s`） |
| `wss://api.todayai.cn/ws?ticket=…` + `device.hello` | `cloud.hello_ack`（`heartbeatIntervalMs=30000`，`messageProtocolVersion=canonical-v1`） |
| 首连帧 | `cloud.devices_updated`、`event.push{agent_indicator.status.v1}` |
| `POST /v1/messages`（`isMainChat:true`） | 202，含 `threadId/messageId/canonicalMessage.conversationId/cursor` |
| 发消息后事件序列 | `chat.message_ready.v2(user)` → `chat.presentation.updated.v1(typing)` → 两次 `working` 快照 → `chat.message_ready.v2(assistant)` |
| `presentation.working.current.turn.content.text` | 两次快照均为 `[]` → 无 token 级流式 |
| `POST /v1/messages`（`conversationId:<新会话>`） | 202 且落回同一会话；第二轮答对上一轮记忆（`77`） |
| `POST /v1/messages`（`conversationId:<随机 uuid>`） | 404 |
| `POST /v1/messages`（`target:{new_task}`） | 202，新建 `conversationId` + `taskId` |
| `POST /v3/conversations`（`Idempotency-Key` + 4 种 body guess） | 全部 400 `common.invalid_request` |
| `GET /v2/messages?conversationId=…` | 200，按会话取历史，可做兜底通道 |
| `GET /v1/pricing/status` | 200 `{plan:'pro',accessSource:'manual_internal'}` |
| `GET /v1/pricing/model-option` | 404 |
| `GET /v3/live/model-options` | 403 |
| 本机凭据文件解密 | `Local State` → DPAPI(32B) → AES-256-GCM 解 `v10` 槽 → 得到 session + JWT + userId |
| 换票闭环 | 解出的 session 换票 200，`/v1/users/me` 200 → 链路闭环 |

## 5. 复算方法

```bash
# 在 REA 会话中
rea_inspect_electron_fuses               path="E:\Today CN\TodayCN.exe"
rea_analyze_javascript_application       input_path="E:\Today CN\resources\app.asar" \
  integrity_policy=record-and-continue \
  source_paths=[dist/app/app/index.js, dist/preload/desktop.cjs, dist/app/consts/account.js, \
                dist/app/consts/cloud-public-config.mjs, dist/app/utils/index.js] detail=summary
rea_analyze_javascript_application       input_path="E:\Today CN\resources\web-runtimes\prod.asar" \
  integrity_policy=record-and-continue \
  source_paths=[apps/web/.next/server/chunks/ssr/packages_api-client_src_17q6z9q._.js, …] detail=summary
rea_export_evidence_bundle               path=<临时目录>\today-evidence.json

# 本项目侧的复算（不需要 REA）
node src/cli.js doctor            # 本机凭据 + 上游连通性
node src/cli.js import-local --dry-run
node src/cli.js probe --prompt "只回复 pong"
```

> `app.asar` 的 REA 分析会报 `artifact_integrity_mismatch`（unpacked 原生模块
> `lzma.win32-x64-msvc.node` 的声明哈希与实测不符——打包后签名/裁剪造成）。
> 这不是篡改信号，用 `integrity_policy=record-and-continue` 继续即可；
> 此时 REA 会把观测字节标记为 untrusted，本项目没有依赖该原生模块。

## 6. REA 覆盖声明（不可当作「不存在」的证明）

与本项目直接相关的限制：

- `Caller-selected source analysis leaves 1769 inventoried files outside analysis scope`（app.asar）
  / `3658 … outside analysis scope`（prod.asar）
  → 除上表 9 个文件外，其余模块（Next.js 前端 chunk、widget runtime、诊断页）未被静态分析覆盖。
- `Request extraction covers fetch, WebSocket, node:http/https construction, direct option fields, and exact local response consumers`
  → 「网络调用点」是**保留关系**而不是完备集合。
- `Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated`
  → 上游地址存在多级覆盖（构建常量 → 运行时 env → electron-store），本报告以实测为准。
- `graph.coverage.status is partial`、`semantic_graph.coverage.status is partial`
  → 语义图被 `file_node_ceiling=20000 / node_ceiling=100000` 截断。

据此，§5 里所有关于上游行为的断言都配了 §4 的实测坐标；静态结论只用来说明「客户端为什么这么发」。
