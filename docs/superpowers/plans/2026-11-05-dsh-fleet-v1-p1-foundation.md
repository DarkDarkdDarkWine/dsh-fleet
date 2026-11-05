# dsh-fleet v1 · 计划一：舰队基础层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个能用 CLI 管理的去中心化舰队：设备身份、签名名册、自有加密端口、PIN 建舰队与入网、心跳与地址自动更新、局域网发现、移除成员与修改/重置 PIN。

**Architecture:** 插件自己用 `node:https` 开一个端口，成员之间双向 TLS，靠证书里的设备公钥识别身份。名册是一份哈希链接、逐条签名的事件日志，由纯函数 `foldState` 推导出成员状态。`FleetService` 负责编排，心跳负责名册同步和地址交换，mDNS 负责局域网发现。CLI 通过本机回环地址加令牌控制插件。派活、会话、AI 工具、面板不在本计划。

**Tech Stack:** Node ≥ 20（ESM，JS + JSDoc）；`node:crypto`（Ed25519、scrypt、sha256）；`node:https`；`@peculiar/x509` ^3.1.0（生成自签证书）；`bonjour-service` ^1.4.4（mDNS）；测试用 `node:test`。

**Spec:** `docs/superpowers/specs/2026-11-05-dsh-fleet-v1-design.md`

**v1 的三份计划：**

- **计划一（本文）**：基础层，覆盖 spec §5.1–5.7、§5.12（舰队管理部分）、§5.13。
- **计划二**：派活与会话，覆盖 §5.8、§5.9、§5.11。
- **计划三**：面板、通知、迁移、发布，覆盖 §5.10、§5.14，以及 fleet-ops 技能和 README。

计划二、三要等本计划的 Task 0 结论出来后再写。

## Global Constraints

- Node ≥ 20：`package.json` 写 `"engines": { "node": ">=20" }`；纯 ESM。
- 运行时依赖只允许 `@peculiar/x509` ^3.1.0 和 `bonjour-service` ^1.4.4，其余一律用 Node 内置模块。不自己实现任何密码学原语。
- 版本号 `1.0.0-alpha.1`（`package.json` 和 `lib/version.js` 两处一致）。**本计划期间不发布到 npm**。
- `package.json` 的 `files` 改为 `["lib", "bin", "cordis.patch.yml", "skills", "README.md", "LICENSE"]`。
- 单个文件不超过 800 行，函数不超过 50 行。
- 插件 `apply()` 在任何路径上都不许抛错：失败写进 `status().error` 并 `logger.warn`。
- PIN 必须正好 6 位数字（`/^\d{6}$/`）。PIN 绝不写进日志、命令行参数或任何文件；落盘的只有 scrypt 校验值。
- 数据目录：`$DSH_FLEET_DIR` → `$DSH_HOME/fleet` → `~/.dsh/fleet`。
- 必须支持 macOS、Linux、Windows。权限位相关的测试要用 `process.platform !== "win32"` 做守卫。
- 默认设置（spec 没有给值的部分由本计划定）：

  | 键 | 默认值 |
  |---|---|
  | `port` | `43190`（`0` 表示临时端口，仅用于测试） |
  | `host` | `"0.0.0.0"` |
  | `heartbeatSec` | `30` |
  | `offlineAfterMisses` | `3` |
  | `concurrency` | `2` |
  | `archiveDays` | `7` |
  | `deliveryTtlHours` | `24` |
  | `bodyLimitBytes` | `2097152` |
  | `agent` | `{ provider:"", model:"", preset:"", cwd:"" }` |
- 每个提交使用 conventional commits，直接提交到 `main`。提交代码前先跑 `npm test` 和 `/verify`。

**本计划对 spec 的两处落地调整（在执行前告知用户）：**

1. spec §5.2 说 CLI 走 DSH Web 服务上的本机接口。但插件拿不到 DSH Web 绑定的地址（NAS 上是 Tailscale IP），所以改为：**CLI 走插件自己端口上的 `/local/*` 路由，只接受回环来源 + 令牌**。面板（计划三）仍走 DSH Web。
2. 新增 CLI 命令 `leave`：清空本机的舰队数据，并重新生成身份。被移除的设备只能用新身份重新入网（spec §5.3 规定"移除胜出"），所以需要这个入口。

## Review Focus

1. **连续输错 PIN 之后重启插件**：锁定状态必须保留；锁定期间即使输入正确的 PIN 也要拒绝。测试在 Task 4、Task 11。
2. **被移除的设备还在发心跳**：其他成员一律返回 `401 not-a-member`；它的 `status().self.rejected` 变为 `true`；它在被移除之后签发的事件全部无效。测试在 Task 8。
3. **对方的 IP 变了**：旧地址超时后会尝试下一个地址；通过地址交换或 mDNS 学到新地址后能恢复通信；一个不通的地址不会把整轮心跳拖过 `heartbeatSec`。测试在 Task 6、Task 8。
4. **写文件时崩溃，或文件损坏**：所有写入都用"临时文件 + rename"。`roster.json` 损坏时拒绝启动舰队，并报 `roster-corrupt`，**绝不覆盖重建**；`identity.json` 同理。测试在 Task 1、Task 11。
5. **端口被占用**：`apply()` 不抛错，`status().listening` 为 `{ error: "EADDRINUSE" }`，CLI 的 `status` 命令能显示出来。测试在 Task 10。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `lib/version.js` | `VERSION` 常量 |
| `lib/paths.js` | 数据目录解析 |
| `lib/store.js` | JSON 文件的原子读写、权限收紧 |
| `lib/settings.js` | 设置的默认值、加载、校验 |
| `lib/identity.js` | 设备密钥、成员编码、签名/验签、自签证书 |
| `lib/roster/events.js` | 事件的规范化、哈希、签名 |
| `lib/roster/log.js` | `RosterLog`：DAG 日志的校验、合并、摘要、祖先查询 |
| `lib/roster/state.js` | `foldState`：日志 → 成员状态（移除规则、PIN 冲突） |
| `lib/pin.js` | PIN 校验值与 `PinGuard` 锁定 |
| `lib/transport/server.js` | HTTPS 服务：双向 TLS、路由鉴权、请求体上限、限速 |
| `lib/transport/client.js` | 逐个地址请求成员，并校验对方身份 |
| `lib/addresses.js` | 本机地址枚举、`AddressBook` |
| `lib/fleet.js` | `FleetService`：创建/入网/移除/PIN/描述/状态 |
| `lib/heartbeat.js` | 心跳、名册同步、地址交换、在线判定 |
| `lib/discovery.js` | mDNS 广播与发现（可注入替身） |
| `lib/local-routes.js` | CLI 用的 `/local/*` 控制路由 |
| `lib/index.js` | 插件入口（替换 v0.3） |
| `bin/dsh-fleet.js` | CLI（替换 v0.3） |
| `test/helpers/net.js` | 进程内多实例测试基座（替换 v0.3 的 `fleet-net.js`） |

v0.3 的 `lib/client.js` 本计划不动。它请求的 `/fleet/panel` 会返回 404，面板显示"舰队数据不可用"。这是已知的过渡状态，计划三重写。

---

### Task 0: 平台能力验证（spike，不进产品代码）

**Files:**
- Create: `docs/superpowers/specs/2026-11-05-dsh-fleet-v1-platform-findings.md`

- [ ] **Step 1：查清下列 9 项，每项记录"结论 + 证据（源码路径或实测命令与输出）+ 对计划二、三的影响"**
  1. DSH Desktop 内置 Node 的版本（`process.version`，在插件 `apply` 里打日志获得）
  2. 在该运行时里，`@peculiar/x509` 能否生成 Ed25519 自签证书，`node:https` 能否用它完成双向 TLS 握手（写一个 30 行的探针脚本，在 Desktop 内置 Node 下运行）
  3. 桌面版里插件能否 `listen("0.0.0.0", 43190)`，macOS 是否弹防火墙提示
  4. `bonjour-service` 在 macOS 和 Linux（NAS）上能否互相发现
  5. spec §8.1：插件能否设置会话标题、能否归档会话
  6. spec §8.2：插件能否向 GUI 正打开着的会话注入消息并唤醒 agent，是否和 GUI 冲突
  7. spec §8.3：DSH 有没有给插件用的用户通知能力
  8. spec §8.5：客户端面板能否弹出模态框
  9. cordis `ctx.on("dispose", fn)` 是否在插件卸载或重载时触发（决定 Task 10 怎么关闭服务）

- [ ] **Step 2：如果第 2 项失败，在 findings 里写明降级方案，并同步改 Task 2 的接口说明**
  降级方案：设备身份仍用 Ed25519 签名；TLS 改用一把独立的 ECDSA P-256 密钥，并由 Ed25519 身份签名背书（证书扩展里存 `ed25519 公钥 + 签名`），对端校验背书。

- [ ] **Step 3：提交**

```bash
git add docs/superpowers/specs/2026-11-05-dsh-fleet-v1-platform-findings.md
git commit -m "docs: v1 platform capability findings"
```

---

### Task 1: 数据目录、原子存储、设置

**Files:**
- Create: `lib/version.js`, `lib/paths.js`, `lib/store.js`, `lib/settings.js`
- Modify: `package.json`（版本号、`engines`、`files`、依赖、`"test": "node --test test/**/*.test.js"`）
- Test: `test/store.test.js`, `test/settings.test.js`

**Interfaces:**
- Produces:
  - `VERSION: string`
  - `resolveDataDir(env?: NodeJS.ProcessEnv): string`
  - `readJson<T>(path: string, fallback: T): T`：文件不存在时返回 `fallback`，JSON 解析失败时抛 `StoreCorruptError`（带 `.path`）
  - `writeJsonAtomic(path: string, data: unknown, opts?: { secret?: boolean }): void`：写 `path.tmp-<pid>`，fsync 后 rename。`secret` 为真时 POSIX 设 `0o600`，win32 用 `icacls "<path>" /inheritance:r /grant:r "%USERNAME%":F` 收紧权限，失败只警告
  - `DEFAULT_SETTINGS`（值见 Global Constraints）
  - `loadSettings(dataDir: string): Settings`：读 `settings.json` 并与默认值深合并。端口不是 0–65535 的整数、`heartbeatSec < 5`、`concurrency < 1` 时抛 `SettingsError`（`.field` 为字段名）

- [ ] **Step 1：写失败测试**
  - `resolveDataDir prefers DSH_FLEET_DIR, then DSH_HOME/fleet, then ~/.dsh/fleet`
  - `readJson returns fallback for a missing file`
  - `readJson throws StoreCorruptError on invalid JSON and leaves the file untouched`
  - `writeJsonAtomic leaves no tmp file and secret files are 0600`（POSIX 守卫）
  - `loadSettings merges nested agent defaults`
  - `loadSettings rejects port 70000 with field "port"`
- [ ] **Step 2：运行 `node --test test/store.test.js test/settings.test.js`，确认因模块缺失而失败**
- [ ] **Step 3：实现上面四个文件；`npm install @peculiar/x509@^3.1.0 bonjour-service@^1.4.4`**
- [ ] **Step 4：重跑，确认全部通过**
- [ ] **Step 5：提交** `feat: v1 storage, settings and data dir`

---

### Task 2: 设备身份

**Files:**
- Create: `lib/identity.js`
- Test: `test/identity.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic`
- Produces:
  - `type Identity = { memberId: string, publicKeyPem: string, privateKey: KeyObject, keyPem: string, certPem: string }`
  - `loadOrCreateIdentity(dataDir: string, opts?: { regenerate?: boolean }): Promise<Identity>`：读写 `identity.json`（secret）。首次启动时生成 Ed25519 密钥和自签证书（CN = memberId，有效期 20 年）。文件损坏时抛 `StoreCorruptError`，不重建
  - `memberIdOf(publicKeyPem: string): string`：对 SPKI DER 做 sha256，取前 32 个十六进制字符
  - `memberIdFromCert(cert: { raw: Buffer } | null): string | null`：从对端证书的 DER 解析公钥并计算 memberId
  - `signBytes(identity: Identity, bytes: Buffer): string`（base64）
  - `verifyBytes(publicKeyPem: string, bytes: Buffer, sig: string): boolean`

- [ ] **Step 1：写失败测试**
  - `creates once and reloads the same memberId`
  - `memberId is 32 lowercase hex chars and equals memberIdOf(publicKeyPem)`
  - `memberIdFromCert(new X509Certificate(certPem)) === memberId`
  - `sign/verify roundtrip; verify fails for a flipped byte`
  - `regenerate: true yields a different memberId`
  - `corrupt identity.json throws StoreCorruptError`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**（证书用 `@peculiar/x509` 的 `X509CertificateGenerator.createSelfSigned`，密钥从 `node:crypto` 的 KeyObject 导出给 WebCrypto）
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 device identity and self-signed cert`

---

### Task 3: 名册事件与 DAG 日志

**Files:**
- Create: `lib/roster/events.js`, `lib/roster/log.js`
- Test: `test/roster-log.test.js`

**Interfaces:**
- Consumes: `Identity`, `signBytes`, `verifyBytes`, `memberIdOf`
- Produces:
  - `EVENT_TYPES = ["fleet.create", "member.join", "member.remove", "pin.change", "member.describe"]`
  - `type SignedEvent = { v: 1, type, fleetId, author: string, parents: string[], at: number, body: object, hash: string, sig: string }`
  - 各类型的 `body`：
    - `fleet.create`：`{ name, pinVerifier, creator: { memberId, publicKeyPem, name } }`
    - `member.join`：`{ memberId, publicKeyPem, name }`
    - `member.remove`：`{ memberId }`
    - `pin.change`：`{ pinVerifier }`
    - `member.describe`：`{ name, description }`
  - `canonicalize(value): string`：递归按键名排序的 JSON
  - `hashEvent(e): string`：对去掉 `hash` 和 `sig` 后的 `canonicalize` 结果做 sha256，十六进制
  - `createEvent(identity, { fleetId, type, parents, body, at? }): SignedEvent`：`sig` 是对 hash 字节的签名
  - `class RosterLog`：
    - `constructor(events?: SignedEvent[])`
    - `add(e): { added: boolean, reason?: "bad-hash"|"bad-sig"|"missing-parent"|"not-a-member"|"duplicate"|"bad-type"|"second-create" }`
    - `merge(events): { added: number, rejected: { hash, reason }[] }`：反复尝试，直到没有进展，所以接受任意到达顺序
    - `get(hash)`、`all(): SignedEvent[]`（拓扑序，同层按 hash 排序）、`heads(): string[]`
    - `isAncestor(a, b): boolean`（a 是否是 b 的祖先）
    - `digest(): string`：所有事件 hash 排序后拼接再做 sha256
- 校验规则写在 `add` 里：
  - `fleet.create` 必须没有父事件，并且是全日志唯一的一条；
  - 其他事件的作者，必须在该事件的祖先集合里，以 `creator` 或 `member.join.body.memberId` 的身份出现过；
  - 验签用的公钥从同一批祖先事件里取。

- [ ] **Step 1：写失败测试**（`test/helpers/roster.js` 提供 `makeFleet(n)`，生成 n 个身份和一条 create 事件）
  - `rejects tampered body with bad-hash`
  - `rejects a valid hash signed by another key with bad-sig`
  - `rejects an event whose author never joined in its ancestry with not-a-member`
  - `rejects a second fleet.create`
  - `merge of the same events in shuffled order yields identical digest and all()`
  - `isAncestor follows parents transitively`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 signed roster DAG log`

---

### Task 4: 名册状态推导与 PIN

**Files:**
- Create: `lib/roster/state.js`, `lib/pin.js`
- Test: `test/roster-state.test.js`, `test/pin.test.js`

**Interfaces:**
- Consumes: `RosterLog`
- Produces:
  - `foldState(log: RosterLog): FleetState`，其中 `FleetState = { fleetId, fleetName, members: Map<memberId, { memberId, publicKeyPem, name, description, joinedAt, admittedBy }>, removed: Set<string>, pinVerifier: string, pinConflict: { winner: hash, losers: hash[] } | null }`
  - `PIN_PATTERN = /^\d{6}$/`；PIN 不合格时抛 `PinFormatError`
  - `createVerifier(pin): Promise<string>`：格式 `scrypt$16384$8$1$<salt b64>$<hash b64>`，salt 16 字节，keylen 32
  - `checkPin(verifier, pin): Promise<boolean>`：用 `timingSafeEqual` 比较
  - `class PinGuard`：`constructor({ load(): object, save(obj): void, now(): number })`
    - `status(key): { locked: boolean, retryAfterMs: number }`
    - `fail(key)`、`succeed(key)`
    - 策略：连续 5 次失败，锁 5 分钟；之后每次再被锁，时长翻倍，上限 60 分钟；`succeed` 清零

- `foldState` 的规则（spec §5.3，这部分实现者无法自行推断）：
  1. 有效作者集：对每条 `member.remove(X)` 事件 r，凡作者是 X、且**不是** r 的祖先的事件，一律"无效"。无效事件不产生任何效果，但仍保留在日志里（以便同步）。
  2. `members` = creator ∪ 所有有效 `member.join` 的目标 − `removed`。`removed` = 所有有效 `member.remove` 的目标。同一成员既有 join 又有 remove 时，remove 胜出。
  3. `admittedBy` = 那条 join 事件的作者。
  4. `pinVerifier`：在 create 和所有有效 `pin.change` 中，取"不是任何其他 PIN 事件祖先"的那些（并发极大值），按 `at` 降序、再按作者 memberId 降序排第一个为 winner。极大值多于一个时，`pinConflict = { winner, losers }`。
  5. `member.describe` 只对作者本人生效；同一成员取规则 4 同样意义下的胜者。

- [ ] **Step 1：写失败测试**
  - `creator is the only member and pinVerifier comes from create`
  - `join adds member with admittedBy = author`
  - `remove wins over a concurrent join of the same member`
  - `a join signed by X that is not an ancestor of remove(X) has no effect`
  - `a join signed by X that is an ancestor of remove(X) stays, admittedBy X`
  - `concurrent pin.change: later at wins; equal at → larger memberId wins; pinConflict lists the loser`
  - `describe by B about itself applies; a describe authored by A cannot rename B`
  - `createVerifier/checkPin roundtrip; "12345", "1234567", "12a456" throw PinFormatError`
  - `5 failures lock for 300000 ms; correct-PIN path still sees locked`（假时钟）
  - `next lock is 600000 ms; never exceeds 3600000 ms`
  - `succeed resets the counter`
  - `lock survives a new PinGuard over the same saved state`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 roster state fold and PIN guard`

---

### Task 5: 本机地址与地址簿

**Files:**
- Create: `lib/addresses.js`
- Test: `test/addresses.test.js`

**Interfaces:**
- Produces:
  - `localAddresses(port: number, ifaces = os.networkInterfaces()): { host, port }[]`：非 internal 的 IPv4 地址，排序去重
  - `class AddressBook`：`constructor({ load, save, now })`
    - `record(memberId, addr, ok: boolean)`
    - `candidates(memberId): { host, port }[]`：最近成功的优先，其余按最近见到排序，最多保留 8 个
    - `mergeGossip(directory: Record<memberId, {host,port}[]>, selfId)`：只补充没见过的地址，不覆盖已有记录
    - `markSeen(memberId)`、`miss(memberId)`
    - `isOnline(memberId, offlineAfterMisses): boolean`
    - `snapshot()`：用于持久化和 status 输出

- [ ] **Step 1：写失败测试**
  - `localAddresses skips internal and IPv6, keeps 100.x tailscale`（用伪造的 `ifaces`）
  - `candidates puts last-ok first, caps at 8`
  - `mergeGossip ignores self and never drops existing entries`
  - `online after markSeen, offline after offlineAfterMisses misses`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 local addresses and address book`

---

### Task 6: 传输层（双向 TLS）

**Files:**
- Create: `lib/transport/server.js`, `lib/transport/client.js`
- Test: `test/transport.test.js`

**Interfaces:**
- Consumes: `Identity`, `memberIdFromCert`
- Produces:
  - `startFleetServer({ identity, host, port, bodyLimitBytes, isMember(memberId): boolean, routes, logger }): Promise<{ port: number, close(): Promise<void> }>`
    - `routes` 的形状：`Record<path, { auth: "member" | "open" | "local", method: "GET" | "POST", handler(ctx: { memberId: string | null, remoteAddress, body, headers }): Promise<{ status: number, body: object }> }>`
    - TLS 设置：`requestCert: true, rejectUnauthorized: false`
    - `member` 路由：对端证书算出的 memberId 必须满足 `isMember`，否则返回 `401 { error: "not-a-member" }`
    - `open` 路由：按来源 IP 限速，每分钟 10 次，超出返回 `429`
    - `local` 路由：来源必须是 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，否则返回 `403`（令牌由 Task 10 的 handler 检查）
    - 请求体超过上限返回 `413`；JSON 解析失败返回 `400`；未知路径返回 `404`
    - 所有响应都是 JSON
  - `requestMember({ identity, addresses, expectMemberId, method, path, body?, timeoutMs = 3000 }): Promise<{ status, body, address }>`
    - 按顺序逐个地址尝试
    - 用 `checkServerIdentity` 校验对端证书算出的 memberId 等于 `expectMemberId`（为 `null` 时跳过校验，只用于 hello 和入网）
    - 全部失败时抛 `UnreachableError`，`.attempts = [{ address, reason }]`

- [ ] **Step 1：写失败测试**（三个身份 A、B、X；A 开服务，`isMember` 只认 B）
  - `member route accepts B and passes memberId to the handler`
  - `member route rejects X with 401 not-a-member`
  - `open route works without a client cert`
  - `body of bodyLimitBytes + 1 gets 413`
  - `11th open request within a minute from one IP gets 429`
  - `client skips an unreachable first address and succeeds on the second`（第一个地址用一个已关闭的端口）
  - `client throws when the server's memberId differs from expectMemberId`
  - `a dead address costs at most timeoutMs`（断言耗时 < 3500 ms）
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 mutual-TLS fleet transport`

---

### Task 7: FleetService——创建与入网

**Files:**
- Create: `lib/fleet.js`, `test/helpers/net.js`
- Test: `test/fleet-join.test.js`

**Interfaces:**
- Consumes：Tasks 1–6 的全部接口
- Produces:
  - `class FleetService`
    - `constructor({ dataDir, settings, identity, discovery, logger, now = Date.now })`
    - `start(): Promise<void>`：加载 `roster.json` 和 `state.json`，启动服务，登记路由
    - `stop(): Promise<void>`
  - `status(): FleetStatus`
    ```
    {
      version,
      joined: boolean,
      fleet: { id, short, name } | null,
      self: { memberId, name, rejected },
      members: [{ memberId, name, description, online, lastSeenAt, addresses, admittedBy, isSelf }],
      pinConflict,
      listening: { port } | { error },
      error: string | null
    }
    ```
    - `short` 的格式是 `XXXX-XXXX`：fleetId 前 8 个十六进制字符，转大写
  - `createFleet({ name, pin, memberName }): Promise<FleetStatus>`：fleetId 为 16 个随机字节的十六进制
  - `hello(): { fleetId | null, fleetName | null, memberId, name, version }`
  - `join({ address: { host, port }, pin, memberName }): Promise<FleetStatus>`
  - 错误统一用 `FleetError`，`.code` 取以下之一：
    - `already-joined`、`not-joined`
    - `bad-pin`、`pin-locked`（附 `retryAfterMs`）、`pin-format`
    - `key-mismatch`、`unreachable`
    - `roster-corrupt`
  - 协议路由（本任务登记）：
    - `GET /v1/hello`（open）→ `hello()`
    - `POST /v1/join`（open）
      - 请求：`{ pin, memberId, publicKeyPem, name }`
      - 服务端校验：请求方 TLS 客户端证书算出的 memberId 必须等于 `memberIdOf(publicKeyPem)`，也等于 `memberId`，否则返回 `400 key-mismatch`
      - PIN 用 `PinGuard` 检查，键为 `"join"`
      - 通过后追加 `member.join` 事件，响应 `{ events: log.all() }`

- [ ] **Step 1：写失败测试**（`test/helpers/net.js` 提供 `startNode(name)`，返回 `{ fleet, dir, stop }`；设置为 `port: 0`、`host: "127.0.0.1"`，discovery 用假实现）
  - `createFleet makes a one-member fleet; short matches /^[0-9A-F]{4}-[0-9A-F]{4}$/`
  - `createFleet with "12345" fails pin-format`
  - `join with the right PIN: both A and N list two members, N admittedBy A`
  - `join with a wrong PIN fails bad-pin; 5th failure → 6th attempt fails pin-locked with retryAfterMs > 0`
  - `join whose publicKeyPem does not match the TLS client key fails key-mismatch`
  - `hello on an unjoined node returns fleetId null and its memberId`
  - `createFleet or join when already joined fails already-joined`
  - `roster.json and state.json are written and identity unchanged after join`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 fleet create and PIN join`

---

### Task 8: 心跳、名册同步、移除与 PIN 变更

**Files:**
- Create: `lib/heartbeat.js`
- Modify: `lib/fleet.js`（新增方法和路由）
- Test: `test/fleet-membership.test.js`

**Interfaces:**
- Consumes: `FleetService`, `AddressBook`, `requestMember`, `foldState`
- Produces:
  - `createHeartbeat({ fleet, settings, now }): { tick(): Promise<void>, start(setIntervalFn), stop() }`。`tick` 对每个其他成员：
    1. `POST /v1/heartbeat`（member 路由），请求体：
       ```
       { addresses: localAddresses(port), version, status: { active: 0, queued: 0 }, rosterDigest, directory }
       ```
       `directory` = 地址簿里最近成功过的地址
    2. 成功 → `markSeen`，合并对方返回的 `directory`；摘要不同 → `POST /v1/roster/sync`；
       失败 → `miss`；响应为 `not-a-member` → `self.rejected = true`
    3. 各成员并发进行；单个成员耗时不超过 `min(3000 × 地址数, heartbeatSec × 1000 / 2)`
  - `POST /v1/heartbeat`（member）：用请求方的 `addresses` 和实际来源 IP 更新地址簿，响应同样的结构
  - `POST /v1/roster/sync`（member）：请求 `{ events }`，`merge` 之后响应 `{ events: log.all() }`；发起方也 `merge` 返回的事件
  - `FleetService` 新增方法：
    - `removeMember({ memberId, pin }): Promise<FleetStatus>`：PIN 在本机校验（键 `"critical"`），然后签发 `member.remove`；不能移除自己（`FleetError("self-remove")`）
    - `changePin({ oldPin, newPin }): Promise<FleetStatus>`：签发 `pin.change`
    - `resetPin({ newPin }): Promise<FleetStatus>`：不要求旧 PIN，只能从 `local` 路由调用；签发 `pin.change`
    - `describe({ name?, description? }): Promise<FleetStatus>`：签发 `member.describe`
    - `leave(): Promise<FleetStatus>`：删除 `roster.json` 和 `state.json`，`loadOrCreateIdentity({ regenerate: true })`，变回未入网状态
  - 本机名册一旦变化（新增或合并了事件），下一次 `tick` 会自动把它同步给所有成员。

- [ ] **Step 1：写失败测试**（三个节点 A、B、C；手动调用 `tick()`，不依赖真实计时器）
  - `C joins via A; after A.tick() and B.tick() B lists C and has C's address`
  - `B marks C offline after 3 failed ticks and online after the next success`
  - `A removes C with the right PIN; after ticks B no longer lists C; C's heartbeat gets not-a-member and C.status().self.rejected is true`
  - `remove with a wrong PIN fails bad-pin and counts toward the critical lockout`
  - `A changes PIN; after sync, join via B with the old PIN fails bad-pin and with the new PIN succeeds`
  - `concurrent changePin on A and B while partitioned → after sync both report the same pinConflict winner`
  - `B.describe updates B's description on A after sync`
  - `C.leave() yields a new memberId and joined false; C can join again with the PIN`
  - `a member whose first address went stale is reached via a gossiped address`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 heartbeat, roster sync, remove and PIN change`

---

### Task 9: 局域网发现

**Files:**
- Create: `lib/discovery.js`, `test/helpers/fake-discovery.js`
- Modify: `lib/fleet.js`（启动广播、接入发现结果）
- Test: `test/discovery.test.js`

**Interfaces:**
- Produces:
  - `createDiscovery({ bonjour = new Bonjour() }): { advertise(info), onFound(cb), stop() }`
    - 服务类型 `dsh-fleet`，协议 tcp，端口为舰队端口
    - txt 记录：`{ v: "1", fleet: fleetId || "", member: memberId, name }`
    - `onFound(cb)` 中 `cb` 的参数为 `{ fleetId | null, fleetName? , memberId, name, host, port }`。txt 不带舰队名，舰队名靠对 `/v1/hello` 的查询获得
  - `FleetService` 新增方法：
    - `discoverFleets(): { fleetId, short, fleetName, via: { memberId, host, port } }[]`：按 fleetId 分组，每个舰队给出一个可用于入网的地址
    - `discoveredUnjoined(): { memberId, name, host, port }[]`：已入网的节点看到的、还没入网的设备（计划三在面板上用）
  - 发现到已知成员时，用 `AddressBook.record(memberId, addr, true)` 补充地址。
  - 入网或离开舰队后，重新广播。

- [ ] **Step 1：写失败测试**（使用假 discovery）
  - `advertise carries fleet id after create and empty fleet before`
  - `discoverFleets groups two members of one fleet into one entry with its name`
  - `discovering a known member adds its new address to the address book`
  - `discoveredUnjoined lists a node with empty fleet`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 mDNS discovery`

---

### Task 10: 本机控制路由与插件入口

**Files:**
- Create: `lib/local-routes.js`
- Replace: `lib/index.js`
- Delete: `test/replies.test.js`、`test/cli.test.js`、`test/helpers/fleet-net.js`（v0.3）
- Test: `test/plugin.test.js`

**Interfaces:**
- Consumes: `FleetService`, `createHeartbeat`, `createDiscovery`, `loadSettings`, `loadOrCreateIdentity`
- Produces:
  - 启动时，生成或读取 `control.json`（secret）：`{ port, token }`。`token` 是 32 个随机字节的十六进制
  - `local` 路由：全部要求请求头 `x-fleet-token` 等于令牌，否则返回 `401`

    | 路由 | 对应 |
    |---|---|
    | `GET /local/status` | `status()` |
    | `GET /local/discover` | `discoverFleets()` |
    | `POST /local/create` | `{ name, pin, memberName }` |
    | `POST /local/join` | `{ host, port, pin, memberName }` |
    | `POST /local/remove` | `{ memberId, pin }` |
    | `POST /local/pin/change` | `{ oldPin, newPin }` |
    | `POST /local/pin/reset` | `{ newPin }` |
    | `POST /local/describe` | `{ name?, description? }` |
    | `POST /local/leave` | `leave()` |

    `FleetError` 映射为 `{ status: 400, body: { error: code, retryAfterMs? } }`（`pin-locked` 用 `423`）
  - 插件入口导出 `{ name: "dsh-fleet", inject: ["timer"], Config, apply }`
    - `Config` 为空对象 schema（设置走 `settings.json`）
    - `apply` 同步返回，异步启动；心跳用 `ctx.setInterval`；按 Task 0 第 9 项的结论在 dispose 时调用 `stop()`

- [ ] **Step 1：写失败测试**
  - `local route without token gets 401; with token returns status`
  - `apply with a fake ctx starts listening and writes control.json (0600 on POSIX)`
  - `apply when the port is taken does not throw; status().listening.error === "EADDRINUSE"`
  - `apply with a corrupt roster.json does not throw; status().error === "roster-corrupt" and the file is unchanged`
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 plugin entry and local control routes`

---

### Task 11: CLI

**Files:**
- Replace: `bin/dsh-fleet.js`
- Test: `test/cli.test.js`（新）

**Interfaces:**
- Consumes：`control.json`、`/local/*` 路由
- Produces：以下命令，全局参数 `--dir <dataDir>`、`--json`

  | 命令 | 说明 |
  |---|---|
  | `status` | 默认命令 |
  | `discover` | |
  | `create <舰队名> [--name 本机名]` | |
  | `join [--address host:port] [--fleet <short>] [--name 本机名]` | 不给 `--address` 时，从 `discover` 结果里按 `--fleet` 选；只有一个舰队时直接用 |
  | `members` | |
  | `remove <memberId 前缀>` | |
  | `pin change` | |
  | `pin reset` | |
  | `describe [--name N] [--description D]` | |
  | `leave` | 交互确认 `yes` |

- PIN 输入规则：
  - TTY 下隐藏回显读取；非 TTY 时从 stdin 按行读取（供测试使用）；
  - `create`、`pin change`、`pin reset` 要求连续输入两次新 PIN 并比对一致；
  - 出现 `--pin` 参数时直接报错退出，提示"PIN 只能交互输入"；
  - 用 `https` 连接 `127.0.0.1:<port>`，`rejectUnauthorized: false`（同机连接，令牌鉴权）。

- [ ] **Step 1：写失败测试**（spawn CLI，`--dir` 指向测试节点的数据目录，PIN 通过 stdin 传入）
  - `create reads PIN twice from stdin; status --json shows joined true`
  - `create with mismatched PIN entries exits non-zero without creating`
  - `join --address joins the second node`
  - `remove by 8-char memberId prefix removes the member and prints the hint "建议修改 PIN（dsh-fleet pin change）"`（spec §5.5）
  - `--pin 123456 is rejected with the interactive-only message`
  - `status shows "端口被占用" when listening.error is EADDRINUSE`
  - `after 5 wrong PINs and a plugin restart, the next join still fails pin-locked`（Review Focus 1）
- [ ] **Step 2：运行，确认失败**
- [ ] **Step 3：实现**
- [ ] **Step 4：运行，确认通过**
- [ ] **Step 5：提交** `feat: v1 CLI`

---

### Task 12: 端到端与收尾

**Files:**
- Test: `test/e2e.test.js`
- Modify: `README.md`（顶部加一节"v1 开发中：当前 main 是 v1 alpha，生产请用 npm 上的 0.3.x"）

- [ ] **Step 1：写失败测试**（三个节点，真实计时器，`heartbeatSec: 5`）
  - `create on A, join B and C via A; within 2 heartbeats all three list three online members`
  - `restart B (stop + start on the same dir): same memberId, still a member, online again within 2 heartbeats`
  - `remove C from B; within 2 heartbeats A no longer lists C`
- [ ] **Step 2：运行，确认失败或暴露缺口；如有缺口，回到对应任务修复**
- [ ] **Step 3：运行 `npm test`，全部通过；运行 `/verify`**
- [ ] **Step 4：在两台真实设备（Mac 桌面版 + NAS）上手工验证：建舰队、入网、心跳在线、移除。把结果记录到 findings 文档末尾**
- [ ] **Step 5：提交** `test: v1 foundation end-to-end`

---

## 计划二、三的范围（届时另写）

- **计划二 · 派活与会话**：
  - `fleet_directory`、`fleet_send`、`fleet_task`、`fleet_describe_self`、`fleet_request` 五个 AI 工具；
  - 结构化派活、每件事一个会话（事务编号映射到会话）；
  - 回执注入发起会话；
  - 信息不足回执；
  - 并发上限与排队、离线存储转发（有效期、去重）、自动归档；
  - 挂起的关键操作（AI 发起、在任意成员上用 PIN 批准）；
  - 重写 fleet-ops 技能。
- **计划三 · 面板与发布**：
  - 逐层点进去的面板（含 PIN 弹窗、待批准列表、发现到未入网的设备）、主动通知；
  - Windows ACL 和三平台防火墙引导文档；
  - 从 v0.3 迁移（导入 agent 配置）、README 和 fleet-ops 技能定稿；
  - 版本 1.0.0 发布。
