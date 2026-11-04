---
name: fleet-ops
description: 舰队运维操作手册：添加/移除成员、异步派活与收回执、健康排查。当用户要管理设备舰队成员（新设备入网/踢出设备）、给其他设备的管家派任务并收取结果、或排查舰队心跳/回执问题时使用。
---

# fleet-ops — dsh-fleet 舰队操作

你所在的设备装有 dsh-fleet 插件，与其它设备（各驻一个「管家」agent）组成舰队，经内网互发消息。

## 工具速查

- `fleet_status`：本机+对端心跳（在线/管家状态/会话活跃度/外发账本）。零成本，先看这个。
- `fleet_send {device, text}`：**默认异步**——立即返回 deliveryId，不等待。对端干完回执进本机收件箱。
  - `wait:true` 才同步等回复（短任务、≤3600s）；禁止发本机。
- `fleet_inbox {device?}`：收回执。给 device 时会先向它拉取保留的未送达回执（pull 兜底）。
- `fleet_member_add {device, baseUrl, role?, announce?}`：新成员入网（先探测对端验证 device 名与密钥，再写入名册并持久化 fleet.json）。announce=true 同时让对端反向注册本机（需本机 advertise.baseUrl）。
- `fleet_member_remove {device}`：移除成员（只影响本机名册）。

## 推荐流程

**派活（异步，别干等）**：
1. `fleet_send` 派出自包含任务（对端管家看不到你的上下文）→ 记下 deliveryId
2. `schedule_create` 设 10-20 分钟提醒（长任务对端会在 progressAfterSec 后主动推「仍在处理」）
3. 提醒到点 → `fleet_inbox` 收回执 → 向用户汇报；没好就再设一轮提醒

**新设备入网**：
1. 新设备：装 dsh-fleet + 写 fleet.json（device/secret/steward 必填；secret 与全舰队一致）
2. 本机：`fleet_member_add {device, baseUrl, role}`（探测通过才算入册）
3. 需要双向互通：新设备侧同样 add 指回，或本机 add 时 announce=true

## 排障

- 401 unauthorized：secret 不一致——密钥是全舰队共享的，轮换要全量同步
- 探测失败/心跳离线：查对端 dsh 是否在跑、baseUrl 是否对外可达（tailscale IP）、端口
- 回执一直不来：对端可能忙/挂了；`fleet_status` 看对端管家 busy；再 `fleet_inbox {device}` 主动拉
- 桌面版（只监听 127.0.0.1）收不到推送回执属正常——它只能 pull；给常驻设备配 advertise.baseUrl 启用推送
- 回执账本在 fleet.json 同目录：fleet-outbox.json（外发）/ fleet-inbox.json（收件）/ fleet-replies.json（待发）
