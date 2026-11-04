# Hermes 技能 → DSH skills 移植清单

状态：**GENERIC 批量移植完成**（2026-11-03）——16 个技能已上 NAS `~/.dsh/skills/`（14 active + 2 pilot），管家 skill 工具热加载全部可见（无需重启服务），抽查 fnnas-tailscale 内容完整。格式零改动兼容（SKILL.md + name/description frontmatter，DSH 扫描 `~/.dsh/skills/` = dshHome/skills）。

## 总量

- 源：NAS `~/.hermes/skills/`，**224 个 SKILL.md**，79MB
- 分类扫描（grep hermes|miloco|t3mt）：**GENERIC 26 个**（可直接复制），**BOUND ~198 个**（引用 hermes 生态服务，需重写或丢弃）

## GENERIC（可直接复制，26 个）

| 技能 | 说明 |
|---|---|
| trim-cli | 飞牛 trim CLI |
| media-search-download/tgto-drive-telethon | tg→网盘转存 |
| research/ai-benchmark-verification | AI 基准验证 |
| research/polymarket | 预测市场 |
| mlops/huggingface-hub | HF hub |
| devops/fnnas-tailscale | 飞牛+tailscale 运维 |
| shopping/ecommerce-product-search | 电商比价 |
| analysis/bohai-method | 渤海方法论 |
| analysis/macro-geopolitical-analysis | 宏观地缘分析 |
| search/searxng-search | SearXNG 搜索 |
| search/firecrawl-selfhost | 自托管 firecrawl |
| pua | （用户私人技能） |
| gaming/pokemon-player | 宝可梦 |
| gaming/minecraft-modpack-server | MC 整合包服务器 |
| .archive/* (11个) | 归档旧技能，含 dsh-agent-framework 等，按需捞 |

复制命令模板（NAS 上执行）：
```sh
mkdir -p ~/.dsh/skills/<name> && cp -r ~/.hermes/skills/<path>/. ~/.dsh/skills/<name>/
```
注意：嵌套路径（research/polymarket）要拍平到 ~/.dsh/skills/<skill-name>/。

## BOUND（~198 个，需决策）

三大家族：
- **miloco-\***（~25个）：小米智能家居/感知/看家 —— 绑定 hermes 的 miloco 服务，DSH 侧需重写为 miot 直连或 MCP
- **t3mt-\***（~14个）：飞牛 trim 插件运维 —— 绑定 hermes 网关，可改写为调 fnOS API/bash
- **hermes-\*/a2a-\***：hermes 自身运维 —— 大部分作废（被 dsh-fleet 取代）

## 建议下一步

1. GENERIC 26 个批量拍平复制（脚本一次完成）
2. t3mt-\* 家族逐个评估：哪些能力 NAS 管家现在就该有（app 更新/存储管理/docker 运维 → 改写成 DSH skill 调 bash）
3. miloco-\* 家族等用户决定智能家居路线后再动
