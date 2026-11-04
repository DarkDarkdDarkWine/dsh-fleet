# dsh-fleet

DeepSeek Harness 多设备舰队插件：每台设备常驻一个「管家」agent 会话，设备间经内网（tailscale）互发消息、心跳互探，任意 agent 可指挥任意 agent。

## 能力

- **管家会话**：首次消息自动创建/恢复（durable session），可指定 agent preset 与工作目录
- **`POST /fleet/message`**（A2A 入口）：把一条消息投进本机管家的回合。**v0.3 起默认异步**——立即返回 `deliveryId`，管家干完后把回执推回发送方（push）；发送方不可达时回执保留在本机，由发送方 `GET /fleet/replies` 拉取（pull）。`wait:true` 仍同步长轮询。`type:"receipt"` 的 POST 是对端回执推送入口
- **回执收件箱**：`fleet_inbox` 工具查看/拉取回执（任务结果、进度、错误）；长任务超过 `progressAfterSec` 会先推一条「仍在处理」
- **`GET /fleet/status`**：心跳——设备名、版本、uptime、管家 live/status/busy、**会话活跃度**（本机任意 session 的近期事件，GUI 对话也算——面板不再把正干活的设备显示成休眠）
- **`GET/POST /fleet/roster`**：名册查询 + **运行时增删成员**（add 前先探测对端身份，通过后持久化回 fleet.json）
- **`GET /fleet/replies`**：拉取本机保留的未送达回执（pull 兜底）
- **工具 `fleet_send` / `fleet_status` / `fleet_inbox` / `fleet_member_add` / `fleet_member_remove`**：本机任意 agent 可用
- **心跳轮询**：探测各对端 `/fleet/status`；顺带重试回执推送、发长任务进度条
- **Web GUI 舰队面板**：侧边栏「舰队」图标，设备卡片（在线/版本/uptime/管家/会话/心跳）

所有 `/fleet/*` 请求（`/fleet/panel` 只读端点除外）须带 `Authorization: Bearer <secret>`（舰队共享密钥）。

## 安装（每台设备）

```sh
dsh plugin --profile web add github:<you>/dsh-fleet   # 或本地路径
```

## 配置

**推荐：每台设备一个 fleet.json**（与 profile 无关，换 profile/升级都不丢）。
路径按优先级：`$DSH_FLEET_CONFIG` → `$DSH_HOME/fleet.json`（DSH_HOME 未设时 `~/.dsh/fleet.json`）。

```json
{
  "device": "nas",
  "secret": "<舰队共享密钥>",
  "steward": { "preset": "nas-keeper", "cwd": "/volume1", "provider": "deepseek-official", "model": "deepseek-flash" },
  "peers": [
    { "device": "pc",  "baseUrl": "http://100.64.0.3:43129", "role": "PC 管家，Windows" },
    { "device": "mac", "baseUrl": "http://100.64.0.4:43129", "role": "MacBook 管家，开发机" }
  ],
  "heartbeatSec": 30,
  "advertise": { "baseUrl": "http://100.64.0.1:43129" },
  "progressAfterSec": 300
}
```

- `advertise.baseUrl`：本机**对外可达**的根地址。配置后异步回执由对端主动推回（push）；留空则只能等发送方来拉（pull）——例如 DSH Desktop 默认只监听 127.0.0.1，就选 pull。
- `progressAfterSec`：管家单条投递超过该秒数未完成，向发送方推一条进度回执（默认 300）。

也可以走 profile 的 `cordis.patch.yml`（id 定位 + config 覆写），两种方式文件值优先。

**注意模型路由**：管家是 headless 会话，没人替它选模型，必须在配置里给 `steward.provider/model`
（当前账号可用模型名如 `deepseek-flash` / `deepseek-v4-pro`；`deepseek-official` 是 provider 名不是模型名）。

## 启动

```sh
DSH_FLEET_CONFIG=/path/to/fleet.json dsh web --profile web --host 0.0.0.0 --port 43129
```

## 验证

```sh
curl -H "Authorization: Bearer <secret>" http://127.0.0.1:43129/fleet/status
curl -H "Authorization: Bearer <secret>" http://127.0.0.1:43129/fleet/roster   # 心跳后 peers online:true

curl -X POST http://127.0.0.1:43129/fleet/message \
  -H "Authorization: Bearer <secret>" -H "content-type: application/json" \
  -d '{"text":"报告本机磁盘使用情况","wait":true,"timeoutSec":300}'
```

对端 A 调本机 B 的 `/fleet/message` 即是 A2A；本机任意 agent 也可以直接用 `fleet_send` 工具指挥对端管家。

## 成员管理（v0.3）

不再手改 fleet.json 也能增删成员。三种等价入口：

```sh
# 1) HTTP API（脚本/CLI 友好）
curl -X POST http://100.64.0.1:43129/fleet/roster \
  -H "Authorization: Bearer <secret>" -H "content-type: application/json" \
  -d '{"op":"add","device":"pc","baseUrl":"http://100.64.0.3:43129","role":"PC 管家"}'
#   → {"ok":true,"added":"pc","peers":[...]}   add 前会探测对端 /fleet/status 验证设备名与密钥
curl -X POST .../fleet/roster -d '{"op":"remove","device":"pc"}'

# 2) 工具（给 AI 用）：fleet_member_add / fleet_member_remove

# 3) 直接编辑 fleet.json 后重启该设备
```

**新成员入网流程**：① 新设备装好本插件 + fleet.json（device/secret/steward/peers 先指向任一现有成员）→ ② 在现有成员上 `fleet_member_add`（或 curl add；若双方都要主动联系对方，新设备也执行一次 add 指回，或 add 时 `announce:true` 自动反向注册——需要本机配置 `advertise.baseUrl`）。密钥是全舰队共享的，改密钥=全量轮换。

## 异步回执协议（v0.3）

`fleet_send` 默认不再阻塞等待：

1. 发送方 POST `{text, deliveryId, callback:{device,baseUrl}?}`（无 callback = 纯 pull 模式），立即拿 `{"ok":true,"async":true,"deliveryId":"d-xxxxxxxx"}`
2. 对端管家跑完任务，回执（reply/progress/error）入本机待发队列：
   - 发送方给了 callback → 立即 POST 回对端 `/fleet/message` `{"type":"receipt",...}`，失败由心跳每轮重试（最多 3 次），仍失败转 pull
   - 发送方用 `fleet_inbox` 工具收（会自动先拉一遍指定对端的 `/fleet/replies` 再展示未读）
3. 给 AI 的推荐姿势：`fleet_send` 异步派活 → `schedule_create` 设个到点提醒 → 提醒触发时 `fleet_inbox` 收结果汇报给用户
4. 回执/外发账本落盘在同目录：`fleet-outbox.json` / `fleet-inbox.json` / `fleet-replies.json`（环形上限 100/200/200 条）

注意：同步模式（`wait:true`）同一时刻只接受一条在途请求（409），异步模式可排队（followup 天然排队）；多条排队时回复归属按 seq 区间近似划分。

## fleet-ops 技能

仓库内 `skills/fleet-ops/SKILL.md` 是给管家/agent 的操作手册（增删成员、异步派活收回执、排障），
安装到本机 skills 目录即被热加载：`cp -r skills/fleet-ops ~/.dsh/skills/`（或 `$DSH_HOME/skills/`）。

## 设计说明

- 消息投递机制与官方 SDK server 相同：`agents.resume/create`（带 `agentOptions:{provider,model}`）→ `agent.followup(createUserMessage(...))`；回合结束判定用 `agent.whenIdle()` + `subagents.waitForChildren()` 稳定循环。
- **工具面靠 setup 里的 `agentPresets.mount(agentCtx, presetId)`**：`meta.agentPreset` 只记录 id，不挂工具；GUI 会话正是靠 composeAgent 的 setup mount 获得全部工具（bash/read/write/web/…32 个）。setup 回调必须返回 void（框架对返回值调 `.commit()`）。不 mount 的管家只有 fleet_send/fleet_status/working_directory 三个工具。
- 回复提取：订阅 `session/event`，收集 `assistant/message` 文本块。
- 单机同一时刻只接受一条在途消息（与 dsh-message-gateway 的 webhook 单槽位一致），多 turn 排队由 followup 队列天然保证。
- 管家 sessionId 确定性生成：`fleet-steward-<device>`，重启自动 resume。
- inject 需要 `timer`（心跳轮询用 `ctx.setInterval`）。

## 双实例联调记录（Mac 本机，2026-11-02）

profile `fleet-a`(:43131) / `fleet-b`(:43132)，各自 `DSH_FLEET_CONFIG` 指向不同 fleet.json：
status/roster/心跳互通 ✅；B 管家同步回复 ✅；A 管家经 `fleet_send` 指挥 B 管家并转述回复 ✅。

踩坑记录（详见会话档案）：
1. **DSH home 不一定是 `~/.dsh`**——Desktop 版在 `~/Library/Application Support/dsh-desktop/harness`，profile 全在那里；改错目录白折腾。
2. profile 缺 `@deepseek-ai/dsh-web-app` bundle 时 webServer 服务永远不来，dsh-fleet 卡 `pending (waiting for service: webServer)`。
3. 管家无模型路由时报 `prompt variable "{{model}}" has no value` —— create/resume 必须带 agentOptions。
4. 管家无工具（只剩 fleet_send/fleet_status/working_directory）—— setup 回调里必须 `await agentPresets.mount(agentCtx, presetId)`（preset 留空=默认全量组合）。
5. NAS 上 bash 首调可能报 `subprocess scope exited before its bootstrap consumed the launch request`（subprocess 启动竞态），重试即好。

## Web GUI 舰队面板（客户端半体，v0.2.x）

`lib/client.js` + `package.json` 的 `exports["./client"]` 与 `dsh.client` 构成插件的客户端半体：
左侧边栏「舰队」图标 + 主面板（设备卡片：在线状态/版本/uptime/管家状态/心跳时间，5s 轮询 `GET /fleet/panel`，该端点无鉴权只读）。

**跨版本要点（踩坑实录，2026-11-03）**：

- DSH Desktop 打包的 harness 是 **0.2.1-rc.2**，与 npx/npm 的 rc.5 不同代。桌面版动态客户端半体要用
  `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`（dsh-quota-pets 同款），
  并以 `ctx.inject(["slots"], ready => ready.slots.inject(...))` 取得 slots 服务——
  **不能直接访问 `ctx.slots`**（旧写法导致 GUI 页面崩溃，触发 DSH Desktop 安全模式修复把插件禁用）。
- rc.5（NAS/mac 实例）的模块图里没有 `dsh-client-ui-slots` 包：宿主重启不受影响（mac-b 实测），
  浏览器端 `arriveGraphRow` 对未知 inject id **静默跳过**（dsh-client-modules/lib/client.js），
  面板只是不注册，页面不会崩。将来 rc.5 桌面端可用后同一段代码自动点亮。
- 客户端半体铁律：**apply() 任何路径都不许抛错**（全部 try/catch 降级 console.warn），`require("react")` 也要包 try/catch。
  客户端 bundle 出错会白屏整个 GUI，风险远大于宿主半体。
- profile 用户层 cordis.patch.yml 的改动桌面版**不热加载**，需重启 Desktop 应用。
