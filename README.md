# dsh-fleet

DeepSeek Harness 多设备舰队插件：每台设备常驻一个「管家」agent 会话，设备间经内网（tailscale）互发消息、心跳互探，任意 agent 可指挥任意 agent。

## 能力

- **管家会话**：首次消息自动创建/恢复（durable session），可指定 agent preset 与工作目录
- **`POST /fleet/message`**（A2A 入口）：把一条消息投进本机管家的回合，可同步等待完整回复（默认）或异步投递；并发请求返回 409
- **`GET /fleet/status`**：心跳——设备名、版本、uptime、管家 live/status/busy
- **`GET /fleet/roster`**：本机视角的舰队名册（自己 + 各对端缓存状态）
- **工具 `fleet_send` / `fleet_status`**：本机任意 agent 可用，向对端管家发任务/查舰队状态
- **心跳轮询**：按间隔探测各对端 `/fleet/status`，缓存在线状态

所有 `/fleet/*` 请求须带 `Authorization: Bearer <secret>`（舰队共享密钥）。

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
  "heartbeatSec": 30
}
```

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
