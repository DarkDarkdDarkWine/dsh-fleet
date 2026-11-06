# dsh-fleet v1 平台能力验证结论

测试环境：DSH Desktop 0.12.1 / macOS (darwin arm64) / Node v24.17.0 (Electron/BoringSSL)；NAS DSH 0.3.1 (dsh-fleet) / 飞牛 fnOS (Linux x86_64) / Node v24.14.1 (OpenSSL 3.5.5)
测试日期：2026-11-05 起（Phase A 完成；GUI 侧实测 Phase C 待跑，下表以 ⏳ 标注）

## 总览

| # | 能力 | 结论 | 证据 |
|---|------|------|------|
| 1 | Desktop/NAS 运行时版本 | 可行（有坑：BoringSSL） | 实测 |
| 2 | Ed25519 证书 + mTLS | 部分：Desktop 不行，降级方案可行 | 实测 |
| 3 | 插件自开端口 | 部分：监听✓，跨设备访问⏳ | 实测（半） |
| 4 | mDNS 互相发现 | 不可行（用户拓扑），保留为机会性增强 | 实测 |
| 5 | 会话管理（建/标题/归档） | 可行（API 已定位，进程内实测⏳） | 源码+实测（半） |
| 6 | 向打开的会话注入消息 | ⏳ 探针就绪待测 | — |
| 7 | 用户通知 | 可行（源码证实），GUI 实测⏳ | 源码 |
| 8 | 面板模态框 | ⏳ 探针就绪待测 | 源码（组件存在） |
| 9 | dispose 钩子 | ⏳ 待测 | — |

## 1. 运行时版本

**结论：** 可行，但 Desktop 的 Node 是 Electron 带 BoringSSL，与官方 Node（OpenSSL）在 TLS 能力上有实质差异（见第 2 项）。
**证据：**
【实测】
- DSH Desktop 0.12.1（`/Applications/DSH Desktop.app`，CFBundleExecutable="DSH Desktop"）
- Desktop 内置 Node：`v24.17.0 darwin arm64`，`execPath=.../DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper`；`process.versions.openssl === "0.0.0"`（BoringSSL 特征）
- `ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" script.mjs` 可直接跑脚本
- harness shell 里的 `node` = Desktop 自带 `…/harness/.desktop-bin/node`（同 BoringSSL 后端）——**写测试脚本时要小心，`node` 不等于官方 node**
- 官方 OpenSSL Node 在 `~/.nvm/versions/node/v24.20.0`（OpenSSL 3.5.7）
- NAS：Node `v24.14.1`，OpenSSL 3.5.5
【源码】asar 内核心包全部 `0.2.1-rc.2`，cordis 4.0.5
**对计划二、三的影响：** 插件代码若依赖 `node:crypto` 的 X509/Ed25519 TLS 行为，必须考虑 BoringSSL 差异；不要假设 `openssl` 语义。
**替代方案：** 不需要。

## 2. Ed25519 证书 + 双向 TLS

**结论：** Desktop（BoringSSL）上 Ed25519 mTLS **握手失败**，ECDSA P-256 mTLS 可行 → 采用计划 Task 0 Step 2 的降级方案：**ECDSA P-256 做 TLS，Ed25519 只做签名背书**。官方 Node 与 NAS 上 Ed25519 mTLS 均可行。
**证据：**
【实测】矩阵（探针 `/tmp/fleet-probe-tls/mtls-probe.mjs`，@peculiar/x509 3.1.0 + reflect-metadata，node:https + requestCert:true/rejectUnauthorized:false）：

| 运行时 | SSL 后端 | Ed25519 mTLS | ECDSA P-256 mTLS |
|---|---|---|---|
| Electron-as-node v24.17.0 | BoringSSL | ✗ `SSLV3_ALERT_HANDSHAKE_FAILURE` (alert 40) | ✓ |
| .desktop-bin/node v24.17.0 | BoringSSL | ✗ 同上 | （同后端，未重复测） |
| nvm v24.20.0 | OpenSSL 3.5.7 | ✓ | ✓ |
| NAS v24.14.1 | OpenSSL 3.5.5 | ✓ | ✓ |

服务端 `getPeerCertificate()` 可拿对端 CN/fingerprint256（ECDSA 路径验证过）；客户端可拿服务端证书。
探针 v0.1.0 已在真实 harness 内做过 ECDSA mTLS 自测（fleet-probe-report.json，事故前落盘成功）。
【实测】@peculiar/x509 v3 API 要点（踩坑记录）：
- 必须 `import "reflect-metadata"`（tsyringe 依赖），否则运行时报错
- `await X509CertificateGenerator.createSelfSigned({ name, notBefore, notAfter, keys, signingAlgorithm })`——**单参数对象、async**
- node `KeyObject` 需 `export({format:"der"})` → `crypto.subtle.importKey(..., extractable: **true**)`（x509 内部要 re-export，false 报 `InvalidAccessException key is not extractable`）
- TLS 层直接用 node:crypto 原生 PEM 交给 node:https，不经过 x509
**对计划二、三的影响：** Task 2 的身份层接口要按「ECDSA P-256 TLS + Ed25519 背书」设计；Ed25519 不能进 TLS 握手路径（Desktop 端）。
**替代方案：** 即降级方案本身。

## 3. 插件自开端口

**结论：** 部分。harness 进程内 `listen(43190, "0.0.0.0")` 成功（探针 v0.1.0 在事故启动的 report 里证实）；跨设备访问与 macOS 防火墙弹窗观察 ⏳（Phase C，需探针 v0.2.0 装回正常模式后从 NAS curl）。
**证据：**【实测】事故启动时探针 init 完整跑通：43190 裸 HTTP + 43191 ECDSA mTLS 均已监听并完成进程内自测。
**对计划二、三的影响：** v1 设计的「独立端口 + 0.0.0.0」方向初步成立，待跨设备验证闭环。
**替代方案：** —

## 4. mDNS 互相发现

**结论：** 不可行（作为主路径）。用户拓扑：Mac=192.168.0.250/24，NAS 物理=enp2s0 192.168.31.14/24（另有 docker 桥 192.168.0.1/20），**互 ping 不通，全靠 Tailscale**。mDNS 不过路由器，也不穿 Tailscale。
**证据：**
【实测】bonjour-service ^1.4.4：
- macOS：`publish` ✓（系统 `dns-sd -B` 能看到）；同机 `find` ✗（看不到同机系统注册的服务）
- NAS (Linux/avahi)：publish + find 双 ✓
- NAS browse 返回的 `addresses` 混入全部 docker 桥接口（几十个地址）——发现层必须过滤
**对计划二、三的影响：** 发现层降级为「同 L2 机会性增强」；主路径 = PIN 入网 / 显式添加（设计文档 §5.2 的判断成立）。
**替代方案：** Tailscale 已是事实上的成员目录来源之一（可直接枚举 tailnet 设备作为候选列表）。

## 5. 会话管理（spec §8.1）

**结论：** 可行（API 已定位，零 token 调用方式已写入探针 v0.2.0，进程内执行 ⏳）。
**证据：**
【源码】
- 标题：`dsh-session-title` 提供 `sessionTitle` 服务（`super(ctx,"sessionTitle")`，`static inject=["sessions","sessionProjections"]`）：`titles.rename(agent.session, title)` → `{title,eventSeq}`；非法标题抛 `SessionTitleInvalidError`。RPC 入口：`dsh-api-session-controller/lib/index.js:3160` `name:"rename"`。
- 归档：`workspaceRegistry.archiveSession(sessionId,{stopActivity})` / `unarchiveSession`（`dsh-api-workspace-controller/lib/index.js:297-317`，RPC `name:"archiveSession"/"unarchiveSession"`）。
- 归档后的会话拒绝后续投递（archived-session-gate，`dsh-api-session-controller/lib/index.js:2847+`）。
- 新建：`ctx.agents.create({sessionId, meta, agentOptions, setup})`（v0.3 已在产品里用过，会话出现在 GUI 列表）。
【实测】探针 v0.2.0 内置标题/归档零 token 测试（待正常模式运行）。
**对计划二、三的影响：** 派活会话（per-task session）+ 标题 + 归档全链路可按现有 API 实现，无需绕路。

## 6. 向打开着的会话注入消息（spec §8.2）

**结论：** ⏳ 待测。探针 v0.2.0 已带 `/probe/inject`（POST → 向最近活跃会话 `agents.resume` + `followup`），需正常模式装回后在 GUI 打开会话的场景 a/b/c 各测一次。
**对计划二、三的影响：** 待定。

## 7. 用户通知（spec §8.3）

**结论：** 可行（源码层已证实，GUI 实测⏳）。**客户端半体直接用标准 Web `Notification` API 即可得到原生 macOS 通知**——preload 已把 `window.Notification` 整个替换为 DesktopNotification 类。
**证据：**
【源码】`app.asar/out/preload/index.cjs:155-240`：`new Notification(title,{body,tag,icon,data,silent})` → IPC `dsh:notification-show` → 原生通知；`permission='granted'`（静态）；`onclick` 可用（点击 focus 窗口）。宿主半体无专门通知服务（桌面主进程 `desktop-main.js:19331` `registerDesktopNotificationBridge`）。
**对计划二、三的影响：** 面板通知走 Web Notification API；宿主侧（管家回执提醒）需经客户端半体转发或走 toast。
**替代方案：** 应用内 toast（见第 8 项组件）。

## 8. 面板模态框（spec §8.5）

**结论：** ⏳ 待测。源码层：`@deepseek-ai/dsh-client-ui-primitives` 导出 `Toast, Modal, useModalLayer, isBehindModal, closeTopModal, modalSelector` 等（完整清单 `/tmp/asar-extracts/ui-primitives-index.js`）。动态插件能否 require 该包、portal 到 body、键盘焦点，待探针 v0.2.0 三按钮面板实测。

## 9. dispose 钩子

**结论：** ⏳ 待测（探针 v0.2.0 关服逻辑已就绪，测重载/退出三种情形）。
【源码】`dsh-agent-loop/lib/index.js:1418-1467`：`FactoryOwnership.liveAgents` Set；`handle.dispose()` → abort 该 agent 的 initiator scope（"agent initiator scope is disposed"）并移出 liveAgents；已落盘事件保留。

## 意外发现

1. **客户端半体导出铁律**：`lib/client.js` 只能导出 `apply`。探针 v0.1.0 曾导出 `inject: ["@deepseek-ai/dsh-client-ui-slots"]`，cordis client runner 把它当必需服务名 → "waiting for activation" → 桌面进安全模式。产品 0.3.x 的写法（只导出 apply，inject 只写在 package.json `dsh.client.inject`）是唯一正确范式。（实测+用户侧复现）
2. **桌面修复流程会自动清掉手动停用条目**：安全模式修复期间写进 `cordis.patch.yml` 的 `disabled: true` 与 market state 的 disabled 会被开机修复清掉，导致"停用后重启仍失败"。彻底修复必须改插件包本身或完整卸载。（实测）
3. **Electron Node 与官方 Node 的 `node` 命令重名陷阱**：harness shell PATH 里 `.desktop-bin/node` 在前，测试脚本若要 OpenSSL 行为必须显式用 nvm 路径。
4. **tar 跨机传输**：macOS→Linux `tar czf` 会刷大量 `LIBARCHIVE.xattr.com.apple.provenance` 警告（无害）；用 `COPYFILE_DISABLE=1 tar` 或 rsync 消除。
5. **探针包安装要求**（实测）：package.json 必须声明 `dsh.bundle.patch` 与 `exports["."]`，否则报 `not-bundle` / `ERR_PACKAGE_PATH_NOT_EXPORTED`。
6. **插件可携带 npm 依赖**：探针 v0.2.0 带 `@peculiar/x509 + reflect-metadata` dependencies 走 generation 安装（staging pnpm 会装好），v1 的身份层可以直接这么用（⏳ 安装验证）。

---
*Phase C（项 3/6/7/8/9 的 GUI 侧与跨设备实测）待桌面恢复正常模式后继续；本文档随测随更。*
