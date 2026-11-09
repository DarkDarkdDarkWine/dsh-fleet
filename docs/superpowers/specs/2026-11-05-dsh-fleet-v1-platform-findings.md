# dsh-fleet v1 平台能力验证结论

- **测试环境**
  - Mac：DSH Desktop 0.12.1，核心包 `0.2.1-rc.2`，cordis 4.0.5；macOS arm64；内置 Node v24.17.0（Electron 43，BoringSSL，`process.versions.openssl === "0.0.0"`）。
  - NAS：飞牛 fnOS，Linux x86_64；Node v24.14.1（OpenSSL 3.5.5）。
- **测试日期**：2026-11-05 至 2026-11-08。
- **分工**：Phase A 由 GLM 完成（第 1、2、4 项的实测，第 5、7 项的源码定位）；其余由 Claude 补测。测试用的探针 `dsh-fleet-probe` 0.3.x 已卸载。
- **源码路径**：凡未注明的，均指 `/Applications/DSH Desktop.app/Contents/Resources/app.asar` 里的 `node_modules/@deepseek-ai/<包>/lib/index.js`。

## 总览

| # | 能力 | 结论 | 证据 |
|---|---|---|---|
| 1 | 运行时版本 | 可行；Desktop 用的是 BoringSSL | 实测 |
| 2 | Ed25519 证书 + 双向 TLS | Desktop 上**不可行**；P-256 可行 | 实测（独立进程 + DSH 进程内） |
| 3 | 插件自开端口 | 可行（`0.0.0.0` 监听，跨设备经 Tailscale 可达） | 实测（DSH 进程内 + NAS curl） |
| 4 | mDNS 互相发现 | 在用户的网络拓扑下不可行，只能作为同网段的补充 | 实测 |
| 5 | 会话：新建 / 标题 / 归档 | 可行（`sessionController` + `workspaceController`） | 实测（DSH 进程内 + GUI 确认） |
| 6 | 向会话注入消息并唤醒 agent | 可行，但**必须走 `sessionController.prompt`** | 实测三种情况 + 源码 |
| 7 | 用户通知 | 可行（客户端 `new Notification()` → macOS 原生通知） | 实测（GUI 确认）+ 源码 |
| 8 | 面板模态框 | 可行（`dsh-client-ui-primitives` 的 `Modal`） | 实测（GUI 确认）+ 源码 |
| 9 | 卸载 / 重载时的清理 | 可行，但只能用 `ctx.effect`；**cordis 4 没有 `dispose` 事件**，webServer 路由不会自动撤销 | 实测 + 源码 |

## 1. 运行时版本

**结论：** 可行。Desktop 内置的 Node 是 Electron 的 BoringSSL 版，TLS 能力和官方 Node（OpenSSL）不一样（见第 2 项）。

**证据【实测】**

- DSH 进程：`node=v24.17.0 platform=darwin arch=arm64`，`execPath=…/DSH Desktop Helper.app/…`（`harness.log` 启动行）。
- 运行脚本：`ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" x.mjs` 可以直接跑脚本，和 DSH 进程是同一套运行时。
- PATH 陷阱：harness shell 里的 `node` 是 `…/harness/.desktop-bin/node`，同样是 BoringSSL；官方 Node 在 `~/.nvm/versions/node/v24.20.0`。

**对计划的影响：** 测试必须在两个运行时上都跑（官方 Node 和 Desktop 运行时）。

## 2. Ed25519 证书与双向 TLS

**结论：** Desktop 上用 Ed25519 证书做 TLS 握手失败，P-256 证书可以。Ed25519 和 P-256 的签名、验签，以及 scrypt，在 Desktop 运行时上都正常。

**证据【实测】**

- **GLM 矩阵（预生成证书）**

  | 运行时 | Ed25519 mTLS | P-256 mTLS |
  |---|---|---|
  | Electron v24.17.0（BoringSSL） | ✗ `SSLV3_ALERT_HANDSHAKE_FAILURE` | ✓ |
  | 官方 Node v24.20.0（OpenSSL 3.5.7） | ✓ | ✓ |
  | NAS v24.14.1（OpenSSL 3.5.5） | ✓ | ✓ |

- **运行时现生成证书（探针 0.3.x，DSH 进程内）**：用 `@peculiar/x509` 3.1.0 现生成证书。Ed25519 自连报 `SSLV3_ALERT_HANDSHAKE_FAILURE`；P-256 自连成功，服务端能拿到对端的 CN 和 `fingerprint256`。
- **签名与 scrypt（Electron 运行时）**
  - `crypto.sign`/`verify`：Ed25519 和 P-256 都正常，篡改过的签名会被拒绝；
  - SPKI 导出后能重新导入；
  - `scryptSync(N=16384, r=8, p=1)` 正常。
- **`@peculiar/x509` 的使用要点**
  - 必须先 `import "reflect-metadata"`，再导入 x509，否则会报 `tsyringe requires a reflect polyfill`。
  - 依赖要同时声明它的 peer：`@peculiar/asn1-schema` ^3 和 `asn1js` ^4。不声明的话，DSH 用 pnpm 安装时会报缺少 peer。
  - 用法：`await X509CertificateGenerator.createSelfSigned({...})`，签名算法传 `{ name: "ECDSA", hash: "SHA-256" }`。
  - Node 的 `KeyObject` 导入 WebCrypto 时，`extractable` 必须为 `true`。

**对计划的影响：** 设备身份只用一把 P-256 密钥，签名和 TLS 证书都用它，不需要再用 Ed25519 做背书。成员编码 = 这把公钥 SPKI 的 sha256。

## 3. 插件自开端口

**结论：** 可行。

**证据【实测】**

- DSH 进程内的探针 `listen(43190, "0.0.0.0")` 和 `listen(43191, "0.0.0.0")`（P-256 mTLS）都成功。
- 从 NAS 经 Tailscale：
  - `curl http://100.114.210.24:43190/` 返回 `{"ok":true,…,"from":"100.85.254.124"}`；
  - `curl -k https://…:43191/` 握手成功；
  - 带 NAS 上生成的 P-256 客户端证书访问时，服务端拿到 `peerCN=nas-client` 和对端指纹。
- macOS 防火墙：本机的应用防火墙是关着的（`socketfilterfw --getglobalstate` → disabled），所以没有观察到"允许传入连接"的弹窗。开着防火墙时会不会弹窗，**未测**，计划三的防火墙文档要按"可能弹窗"来写。

**对计划的影响：** 自开端口的方向成立。

## 4. mDNS 互相发现

**结论：** 在用户的网络里不可行，只能作为同一网段下的补充。

**证据【实测，GLM】**

- Mac 在 `192.168.0.250/24`，NAS 的物理网口在 `192.168.31.14/24`，两边在局域网里互相 ping 不通，只能走 Tailscale。mDNS 不过路由器，也不穿 Tailscale。
- `bonjour-service` ^1.4.4：
  - macOS 上 `publish` 正常（系统 `dns-sd -B` 能看到）；
  - NAS（avahi）上 `publish` 和 `find` 都正常；
  - NAS 广播出的地址里混着几十个 docker 网桥地址，其中 `192.168.0.1/20` 还覆盖了 Mac 所在的网段。

**对计划的影响：**

- 主路径是 PIN 入网。
- 地址枚举必须过滤 docker/虚拟网卡（`docker*`、`br-*`、`veth*`、`virbr*`）和链路本地地址。
- Tailscale 是否作为第二个发现来源，**待用户决定**。

## 5. 会话：新建 / 标题 / 归档

**结论：** 可行。用的是 GUI 背后同一套服务，从进程内调用，不经过 RPC。

**证据【实测，探针 0.3.0】**

- 通过 `ctx.inject(["sessionController","workspaceController","agents"], …)` 拿到三个服务（`apply` 时同步 `ctx.get` 拿不到，必须用 `inject` 等它们就绪）。
- `sessionController.create({ cwd })` → `{ sessionId: "session-c7ceb4c0-…", agentPreset: "standard" }`：会话自动挂上默认预设，并出现在 GUI 列表里（用户确认）。
- `sessionController.rename({ sessionId, title })` → `{ title: "舰队探针测试会话", seq: 3 }`，GUI 显示新标题（用户确认）。
- `workspaceController.archiveSession({ sessionId })` / `unarchiveSession({ sessionId })` 都成功。归档后的会话会拒绝新消息（源码：`dsh-api-session-controller` 的 archived-session gate）。

**【源码】**

- `dsh-api-session-controller`：`class … super(ctx, "sessionController")` 对外提供 `create`/`rename`/`prompt`/`cancel`/`delete`/`fork`，这些就是 GUI 调用的 RPC 方法本身。
- 进程内调用时 `ctx.invocation` 为空，`principalOf` 会把调用者当作 owner（受信任的进程内代码）。

**对计划的影响：** 计划二"每件事一个会话"直接用 `create` → `rename` → 处理 → `archiveSession`。

## 6. 向会话注入消息并唤醒 agent

**结论：** 可行，但必须走 `sessionController.prompt(request, signal)`，**不能**自己调 `ctx.agents.resume`。

**证据【实测，探针 0.3.x，探针自建的测试会话】**

| 情况 | 调用前状态 | 结果 |
|---|---|---|
| a. agent 活着且空闲 | `live:true, idle` | `{accepted:true}`，立刻开始新一轮，回复"收到A" |
| b. agent 正在回答（数到 60） | `live:true, running` | `{accepted:true}`，消息排进下一轮；第一轮结束后接着回复"收到B2"，顺序不乱 |
| c. 没有活着的 agent（DSH 重启后） | `live:false` | `{accepted:true}`，控制器带着预设恢复会话，回复"收到C" |

- 请求格式：`{ sessionId, requestId: randomUUID(), mode: "followup" | "steer", content: [{ type: "text", text }] }`。
- 用户在 GUI 打开测试会话后，能看到全部注入的消息和回复（用户确认）。
- 消息在会话里记作 `source.kind = "user"`，显示为一条用户消息。

**反例【实测，GLM 的探针 0.2.0】**

- 直接 `ctx.agents.resume({ resumeSessionId })` 加 `followup`：没打开的会话不挂预设，那一轮报错 `prompt variable "{{model}}" has no value … (section "deployment:persona-prefix")`。
- 如果 GUI 已经打开着这个会话，持久层只允许一个写入者，会抛 `SessionAlreadyOwnedError`（源码：`dsh-session-persistence-jsonl` 的 `writers`）。
- 注入后 `handle.dispose()` 还会中止 agent 正在进行的那一轮。

**【源码】** `SessionCommands.resolve()`：先 `ctx.agents.get(id)` 找已经活着的 agent，找不到才 `resume`，并带上 `presets.mount` 的预设。GUI 发消息走的就是这条路。

**对计划的影响：**

- 回执注入原对话、派活给每件事的会话，都统一用 `prompt`。
- 回执会显示为"用户消息"，正文开头要带明确的标识，例如 `【舰队回执 · 来自 nas】`。

## 7. 用户通知

**结论：** 可行。

**证据**

- 【实测】面板里调用 `new Notification("舰队探针", { body, tag })`，弹出了 macOS 原生通知（用户确认），`Notification.permission === "granted"`。
- 【源码，GLM】`app.asar/out/preload/index.cjs:155-240`：preload 把 `window.Notification` 换成了桥接类，点击通知会把 DSH 窗口切到前台。

宿主半体没有可用的通知服务，提醒要从客户端半体发出。

**对计划的影响：** 由面板（客户端半体）订阅事件并发出通知；宿主半体只负责提供事件。

## 8. 面板模态框

**结论：** 可行。

**证据**

- 【实测】面板能 `require("@deepseek-ai/dsh-client-ui-primitives")` 拿到 `Modal` 和 `Toast`。渲染 `Modal` 后，对话框盖住整个窗口，带 `data-modal-autofocus` 的输入框自动拿到焦点，按 Esc 能关闭；`Toast` 能正常显示（用户确认）。
- 【源码】
  - `Modal({ open, onClose, title, closeLabel, description, children, footer, headless })` 会通过 `createPortal` 挂到 `document.body`，并用 `useModalLayer` 管理焦点和 Esc。
  - `Toast({ text, icon, tone, anchor, holdMs, actions, onDone })` 是要渲染出来的组件，不是函数调用。
- 【实测，GLM 事故】客户端模块**只能导出 `apply`**。如果导出了 `inject: ["@deepseek-ai/dsh-client-ui-slots"]`，cordis 会把它当成必需的服务名，模块永远等不到激活，Desktop 就会进安全模式。包名只能写在 `package.json` 的 `dsh.client.inject` 里。

**对计划的影响：** 计划三的 PIN 弹窗直接用 `Modal`。

## 9. 卸载 / 重载时的清理

**结论：**

- cordis 4 **没有 `dispose` 事件**，`ctx.on("dispose")` 永远不会触发。清理只能写成 `ctx.effect(() => () => cleanup())`。
- `ctx.effect` 的回调会**立刻执行**，返回的函数才是清理函数。
- webServer 路由不会随插件卸载自动撤销，必须手动撤。

**证据【实测，探针 0.3.x 的生命周期日志】**

- **DSH 退出**：每次退出前都有一条 `dispose: closing 2 server(s)`，重启后重新监听没有报端口被占用（共 5 次）。
- **进程内重载**：同一个 pid 86043 先 `dispose`、再 `apply`（插件被替换时）。
- **卸载**（`remove_bundle`）：同一个 pid 98122 执行了 `dispose`，之后 43190 和 43191 都不再监听（`lsof` 为空）。但 `/probe/report` 路由**在卸载后仍然能访问**，直到下次重启。

**证据【源码】**

- `cordis` 的 `Fiber.effect(execute)`：`execute` 立刻执行，返回值作为清理函数；整个包里没有 `dispose` 事件。
- `dsh-host-webserver` 的 `register(route)`：返回一个撤销函数，但没有挂到 fiber 上；同一条路由再次注册会抛 `duplicate exact route`。

**对计划的影响（Task 10）：**

- 每一处 `webServer.register`、`tools.register` 和定时器都要放进 `ctx.effect(() => register(...))`，让撤销函数随插件卸载执行；
- 自开端口的关闭也放进 `ctx.effect`；
- 不使用 `ctx.on("dispose")`。

## 意外发现

1. **DSH 不替插件的 Web 路由做鉴权**：探针的 `/probe/*` 不带任何令牌就能访问，所以 v1 面板和管理路由必须自己做鉴权。
2. **插件安装方式**：
   - DSH agent 的 `plugin_manager` 工具 `install_bundle <本地目录>` 会生成一份新的安装，DSH **重启后才生效**；
   - `remove_bundle` 会把插件从 `package.json` 里去掉，并在当前进程里立刻卸载它，残留的安装文件下次启动时被清理；
   - 包必须声明 `dsh.bundle.patch` 和 `exports["."]`（GLM 实测）。
3. **桌面修复流程会清掉手动停用的条目**：安全模式修复时，写进 `cordis.patch.yml` 的 `disabled: true` 会被开机修复清掉。要彻底修好，只能改插件包本身或完整卸载（GLM 实测）。
4. **探针事故的副作用**：GLM 的探针 0.2.0 往用户会话 `session-7ec7aff5…`、`session-e4e490cf…` 和 `fleet-steward-mac-gui` 里各注入了一条测试消息，那几轮都失败了。测试会话"舰队探针测试会话"（`session-c7ceb4c0…`）留给用户自行删除。
5. **tar 跨机传输**：macOS → Linux 用 `tar czf` 会刷出大量 xattr 警告，无害；用 `COPYFILE_DISABLE=1` 可以消除（GLM 实测）。

## 计划一真机验证（2026-11-08，Task 12 Step 4）

**做法：** 两台设备都在临时数据目录里独立运行插件入口（`lib/index.js` 的 `apply`，配一个假的 cordis ctx），**没有装进 DSH**，用户在用的 0.3.1 不受影响。

- Mac：用 DSH Desktop 自带的运行时运行（`ELECTRON_RUN_AS_NODE=1`，BoringSSL）；
- NAS：用它自己的 Node v24.14.1（OpenSSL）运行；
- 两边的舰队端口都是 43190。

**结果【实测】：**

| 步骤 | 结果 |
|---|---|
| NAS `dsh-fleet create 验证舰队` | ✓ 舰队 `1D22-379C` |
| Mac `dsh-fleet discover` | ✓ 经 Tailscale 发现 `1D22-379C 验证舰队 经由 100.85.254.124:43190（tailscale）`（两台不在同一网段，mDNS 发现不了） |
| Mac `dsh-fleet join`（不带 `--address`，自动选唯一舰队）+ PIN | ✓ 共 2 台成员；BoringSSL ↔ OpenSSL 双向 TLS 正常 |
| 心跳（默认 `heartbeatSec: 30`） | ✓ 两边都显示对方在线，首选地址都是对方的 Tailscale IP |
| NAS `dsh-fleet remove 52de67d0` + PIN | ✓ 打印"建议修改 PIN"；Mac 在 3 秒内变为"⚠ 已被移出舰队" |

**真机暴露的三个问题（都已修复并补了测试）：**

1. **超时太短**：经 Tailscale 中继，Mac→NAS 一次请求实测要 1.3–2.2 秒（TCP 连接约 0.4 秒，TLS 还要几个来回），原来 1.5 秒的 hello 探测超时会漏掉 NAS。
   - 改为：请求默认超时 6 秒、hello 探测 5 秒、心跳每个地址最多 6 秒（总时长仍不超过 `heartbeatSec / 2`）。
   - 提交 07943bb。
   - 注：`heartbeatSec` 设得太小时（例如 5 秒），预算分到每个地址不到 1 秒，中继链路上的心跳会时通时断。保持默认的 30 秒。
2. **失败的地址被提前**：心跳失败时，旧代码把尝试过的地址记成"刚见过"，结果下一轮排在最前面的，反而是最后一个连不上的地址。
   - 新增 `AddressBook.fail()`：只记失败，不刷新"见过"的时间。
   - 提交 b1d2416。
3. **代理的虚拟 IP**：Mac 广播了 `198.18.0.1`，这是 Shadowrocket 的 TUN 虚拟地址（198.18.0.0/15 段）。
   - 现在枚举本机地址时跳过这个段。
   - 提交 b1d2416。

## 计划一在 DSH 内加载验证（2026-11-08）

经用户同意，用 `plugin_manager install_bundle` 把 v1（`npm pack` 打出的包）装进 Mac 的 DSH Desktop，替换了 0.3.1。

**结果【实测】：**

| 检查项 | 结果 |
|---|---|
| 启动 | ✓ 没有触发插件恢复，也没有进入安全模式；43190 由 DSH 的 harness 进程（DSH Desktop Helper）监听 |
| 数据目录 | ✓ `$DSH_HOME/fleet/`，即 `…/dsh-desktop/harness/fleet/`，生成 `identity.json` 和 `control.json`；v0.3 的 `fleet*.json` 原样不动 |
| CLI | ✓ `--dir` 指向上面的目录后，`status` 和 `create` 都正常（测试舰队 `BB94-9016`） |
| `ctx.setInterval` | ✓ 本机另起一个临时节点入网后，DSH 自己的心跳在约 30 秒内成功连到对方真实的 `127.0.0.1:43192` |
| `ctx.effect` 清理 / 重启 | ✓ 退出时 harness 进程以 0 退出；新进程重新绑定 43190，没有出现 EADDRINUSE；舰队和成员都还在，对方再次显示在线 |
| `inject: ["timer"]`，不导出 `Config`，`ctx.logger` | ✓ 加载时没有报错 |

**顺带观察到：** mDNS 发现的地址被直接记成"已验证"，这是审阅意见里推迟处理的一个小问题。临时节点只监听 127.0.0.1，DSH 却先去连 mDNS 报来的 `192.168.0.250:43192`，失败后才换到 127.0.0.1 成功，相当于每次多试一个地址，结果不受影响。
